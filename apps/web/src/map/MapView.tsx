import 'mapbox-gl/dist/mapbox-gl.css'
import { Map, useControl } from 'react-map-gl/mapbox'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { IconLayer, PolygonLayer } from '@deck.gl/layers'
import type { Color } from '@deck.gl/core'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string

const INITIAL_VIEW_STATE = {
  longitude: -77.0365,
  latitude: 38.8977,
  zoom: 12,
  pitch: 0,
  bearing: 0,
}

// Phase 1: one hardcoded aircraft. Position + heading are static here;
// Phase 2 drives them from the track store.
type Aircraft = { position: [number, number]; headingDeg: number }
const AIRCRAFT: Aircraft[] = [{ position: [-77.0365, 38.8977], headingDeg: 45 }]

// Airplane marker as a data-URI SVG (arrow pointing north) so there is no
// binary asset to manage. IconLayer.getAngle rotates it to the heading.
const AIRCRAFT_ICON =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">` +
      `<path d="M24 4 L40 40 L24 32 L8 40 Z" fill="#39d0ff" stroke="#0a2a33" stroke-width="2" stroke-linejoin="round"/>` +
      `</svg>`,
  )

// Phase 1: one hardcoded geozone polygon (a rough box near the aircraft).
type Geozone = { name: string; polygon: [number, number][] }
const GEOZONE: Geozone[] = [
  {
    name: 'R-1 Restricted',
    polygon: [
      [-77.075, 38.875],
      [-77.0, 38.875],
      [-77.0, 38.92],
      [-77.075, 38.92],
      [-77.075, 38.875],
    ],
  },
]

const ZONE_FILL: Color = [255, 80, 80, 40]
const ZONE_LINE: Color = [255, 80, 80, 200]

function buildLayers() {
  return [
    new PolygonLayer<Geozone>({
      id: 'geozones',
      data: GEOZONE,
      getPolygon: (d) => d.polygon,
      getFillColor: ZONE_FILL,
      getLineColor: ZONE_LINE,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: true,
    }),
    new IconLayer<Aircraft>({
      id: 'aircraft',
      data: AIRCRAFT,
      getPosition: (d) => d.position,
      getIcon: () => ({ url: AIRCRAFT_ICON, width: 48, height: 48, anchorX: 24, anchorY: 24 }),
      getSize: 40,
      sizeUnits: 'pixels',
      // deck angle is counter-clockwise degrees; compass heading is clockwise.
      // Phase 2 revisits this mapping when yaw goes live.
      getAngle: (d) => -d.headingDeg,
      billboard: false,
      pickable: true,
    }),
  ]
}

// Adds a deck.gl MapboxOverlay to the Mapbox map as a control.
// interleaved:false = OVERLAID — deck paints its own canvas above Mapbox.
// Mapbox owns the camera; the overlay syncs deck's view to it automatically.
function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props))
  overlay.setProps(props)
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
      <DeckOverlay interleaved={false} layers={buildLayers()} />
    </Map>
  )
}
