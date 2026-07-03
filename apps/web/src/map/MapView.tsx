import 'mapbox-gl/dist/mapbox-gl.css'
import { useEffect } from 'react'
import { Map, useControl } from 'react-map-gl/mapbox'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { useTrackStore } from '../state/trackStore'
import { buildLayers } from './layers'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string

const INITIAL_VIEW_STATE = {
  longitude: -77.0365,
  latitude: 38.8977,
  zoom: 12,
  pitch: 0,
  bearing: 0,
}

// Adds a deck.gl MapboxOverlay to the Mapbox map as a control (overlaid mode).
// Mapbox owns the camera; the overlay syncs deck's view to it automatically.
function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}

export default function MapView() {
  // Commit 2: render declaratively from the store snapshot. Commit 3 replaces this
  // subscription + one-shot seed with a fake driver + an rAF loop that pushes layers
  // via setProps, off React's render path (the real hot path).
  const vehicles = useTrackStore((s) => s.vehicles)
  const trails = useTrackStore((s) => s.trails)

  useEffect(() => {
    useTrackStore.getState().ingest({
      vehicleId: 'uav-01',
      position: [-77.0365, 38.8977],
      headingDeg: 45,
      ts: Date.now(),
    })
  }, [])

  if (!MAPBOX_TOKEN) {
    return (
      <div style={{ padding: 24, color: '#f3f4f6', fontFamily: 'system-ui' }}>
        Missing <code>VITE_MAPBOX_TOKEN</code> — add it to <code>apps/web/.env</code> and restart the dev
        server.
      </div>
    )
  }

  const layers = buildLayers({ vehicles, trails })

  return (
    <Map
      mapboxAccessToken={MAPBOX_TOKEN}
      initialViewState={INITIAL_VIEW_STATE}
      mapStyle="mapbox://styles/mapbox/dark-v11"
      style={{ width: '100vw', height: '100vh' }}
    >
      <DeckOverlay interleaved={false} layers={layers} />
    </Map>
  )
}
