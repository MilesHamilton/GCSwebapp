import 'mapbox-gl/dist/mapbox-gl.css'
import { useEffect } from 'react'
import { Map, Source, Layer, useControl, useMap } from 'react-map-gl/mapbox'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { useTrackStore, type TimedPoint, type Vehicle } from '../state/trackStore'
import { usePlaybackStore } from '../state/playbackStore'
import { useUiStore } from '../state/uiStore'
import { buildLayers, type RenderFrame, type Trail } from './layers'
import { startWsClient } from '../ws/client'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string

const INITIAL_VIEW_STATE = {
  longitude: -77.0365,
  latitude: 38.8977,
  zoom: 14,
  pitch: 55, // pitched so terrain relief + 3D buildings read; flatten to go top-down
  bearing: 0,
}

// Compass bearing (0=N, 90=E) of a->b, equirectangular (fine at local scale).
function bearing(a: [number, number], b: [number, number]): number {
  const dLng = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180)
  const dLat = b[1] - a[1]
  return ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360
}

// Sample a recorded track at time t: interpolate position, derive heading from the segment.
function sampleAt(id: string, points: TimedPoint[], t: number): Vehicle | null {
  if (points.length === 0) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (t <= first.timestamp) {
    const next = points[1]
    return {
      id,
      position: first.coordinates,
      headingDeg: next ? bearing(first.coordinates, next.coordinates) : 0,
      altM: first.altM,
      updatedAt: first.timestamp,
    }
  }
  if (t >= last.timestamp) {
    const prev = points[points.length - 2] ?? last
    return {
      id,
      position: last.coordinates,
      headingDeg: bearing(prev.coordinates, last.coordinates),
      altM: last.altM,
      updatedAt: last.timestamp,
    }
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (t >= a.timestamp && t <= b.timestamp) {
      const span = b.timestamp - a.timestamp
      const f = span === 0 ? 0 : (t - a.timestamp) / span
      const position: [number, number] = [
        a.coordinates[0] + (b.coordinates[0] - a.coordinates[0]) * f,
        a.coordinates[1] + (b.coordinates[1] - a.coordinates[1]) * f,
      ]
      return { id, position, headingDeg: bearing(a.coordinates, b.coordinates), altM: a.altM + (b.altM - a.altM) * f, updatedAt: t }
    }
  }
  return { id, position: last.coordinates, headingDeg: 0, altM: last.altM, updatedAt: last.timestamp }
}

// Resolve the frame to draw from the stores, imperatively (no React subscription).
function resolveFrame(): RenderFrame {
  const track = useTrackStore.getState()
  const pb = usePlaybackStore.getState()
  const ui = useUiStore.getState()
  const shared = {
    geozones: track.geozones,
    visibility: ui.visibility,
    selectedId: ui.selectedVehicleId,
    onSelectVehicle: (id: string) => useUiStore.getState().setSelected(id),
  }
  if (pb.mode === 'replay') {
    const vehicles: Vehicle[] = []
    const trails: Trail[] = []
    for (const [id, points] of Object.entries(track.recording)) {
      trails.push({ id, points })
      const v = sampleAt(id, points, pb.currentTime)
      if (v) vehicles.push(v)
    }
    return { ...shared, vehicles, trails, currentTime: pb.currentTime }
  }
  const vehicles = Object.values(track.vehicles)
  const trails: Trail[] = Object.entries(track.trails).map(([id, points]) => ({ id, points }))
  let currentTime = 0
  for (const v of vehicles) if (v.updatedAt > currentTime) currentTime = v.updatedAt
  return { ...shared, vehicles, trails, currentTime }
}

// The hot path. deck lives as a Mapbox control (overlaid). The rAF loop reads the stores
// imperatively (getState) and pushes freshly-built layers via setProps — all OFF React's
// render cycle, so telemetry never triggers a component re-render.
function DeckLayers() {
  // interleaved: deck draws into Mapbox's GL context (shared depth buffer), so terrain +
  // 3D buildings occlude deck layers under a pitched camera. Phase 1 shipped overlaid
  // (deck always on top); 3D forces this revisit — the logged Phase 1 trigger.
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: true }))
  const maps = useMap()

  useEffect(() => {
    const stop = startWsClient()
    let raf = 0
    const tick = () => {
      const frame = resolveFrame()
      overlay.setProps({ layers: buildLayers(frame) })
      // Camera follow: drive the map imperatively (off React), per the Phase 5 decision.
      const ui = useUiStore.getState()
      if (ui.follow && ui.selectedVehicleId) {
        const v = frame.vehicles.find((x) => x.id === ui.selectedVehicleId)
        if (v) maps.current?.setCenter(v.position)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      stop()
      cancelAnimationFrame(raf)
    }
  }, [overlay, maps])

  return null
}

export default function MapView() {
  if (!MAPBOX_TOKEN) {
    return (
      <div style={{ padding: 24, color: '#f3f4f6', fontFamily: 'system-ui' }}>
        Missing <code>VITE_MAPBOX_TOKEN</code> — add it to <code>apps/web/.env</code> and restart the dev
        server.
      </div>
    )
  }

  return (
    <Map
      mapboxAccessToken={MAPBOX_TOKEN}
      initialViewState={INITIAL_VIEW_STATE}
      mapStyle="mapbox://styles/mapbox/dark-v11"
      maxPitch={80}
      terrain={{ source: 'mapbox-dem', exaggeration: 1.4 }}
      style={{ width: '100vw', height: '100vh' }}
    >
      {/* DEM feeds the `terrain` prop above (relief) and the sky layer's horizon. */}
      <Source id="mapbox-dem" type="raster-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxzoom={14} />
      <Layer
        id="sky"
        type="sky"
        paint={{
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 90.0],
          'sky-atmosphere-sun-intensity': 15,
        }}
      />
      {/* 3D buildings extruded from the base style's composite source. */}
      <Layer
        id="3d-buildings"
        source="composite"
        source-layer="building"
        type="fill-extrusion"
        minzoom={14}
        filter={['==', 'extrude', 'true']}
        paint={{
          'fill-extrusion-color': '#2a3040',
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'min_height'],
          'fill-extrusion-opacity': 0.7,
        }}
      />
      <DeckLayers />
    </Map>
  )
}
