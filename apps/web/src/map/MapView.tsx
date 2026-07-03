import 'mapbox-gl/dist/mapbox-gl.css'
import { useEffect } from 'react'
import { Map, useControl } from 'react-map-gl/mapbox'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { useTrackStore } from '../state/trackStore'
import { buildLayers } from './layers'
import { startFakeDriver } from '../state/fakeDriver'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string

const INITIAL_VIEW_STATE = {
  longitude: -77.0365,
  latitude: 38.8977,
  zoom: 12,
  pitch: 0,
  bearing: 0,
}

// The hot path. deck lives as a Mapbox control (overlaid). A fake driver feeds the
// store at ~10 Hz, and an rAF loop reads the store imperatively (getState) and pushes
// freshly-built layers via setProps — all OFF React's render cycle, so telemetry never
// triggers a component re-render. This component subscribes to nothing.
function DeckLayers() {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay({ interleaved: false }))

  useEffect(() => {
    const stop = startFakeDriver()
    let raf = 0
    const tick = () => {
      const { vehicles, trails } = useTrackStore.getState()
      overlay.setProps({ layers: buildLayers({ vehicles, trails }) })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      stop()
      cancelAnimationFrame(raf)
    }
  }, [overlay])

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
      style={{ width: '100vw', height: '100vh' }}
    >
      <DeckLayers />
    </Map>
  )
}
