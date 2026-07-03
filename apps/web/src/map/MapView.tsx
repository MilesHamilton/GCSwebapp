import 'mapbox-gl/dist/mapbox-gl.css'
import { Map, useControl } from 'react-map-gl/mapbox'
import { MapboxOverlay, type MapboxOverlayProps } from '@deck.gl/mapbox'
import { PolygonLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { OBJLoader } from '@loaders.gl/obj'
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

// No .mtl shipped with the OBJ, so the airframe is drawn a flat tactical gray.
// GCS glyphs aren't to scale — the mesh is exaggerated via sizeScale so a ~40 m
// aircraft reads at operational zoom. Note: unlike the old pixel icon, a mesh is
// world-space, so it grows/shrinks with the map.
const AIRCRAFT_COLOR: Color = [200, 205, 210]
const AIRCRAFT_SIZE_SCALE = 5
// The Y-up -> Z-up rotation is baked into rq-180.obj, so runtime orientation is a
// single clean yaw about vertical (no Euler coupling / attitude flips). HEADING_OFFSET
// aligns the model's nose with compass heading — nudge it (0/90/180/270) if the nose
// points the wrong way after verify.
const HEADING_OFFSET = 90

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
    new SimpleMeshLayer<Aircraft>({
      id: 'aircraft',
      data: AIRCRAFT,
      mesh: '/models/rq-180.obj',
      loaders: [OBJLoader],
      getPosition: (d) => d.position,
      getColor: AIRCRAFT_COLOR,
      getOrientation: (d): [number, number, number] => [0, HEADING_OFFSET - d.headingDeg, 0],
      sizeScale: AIRCRAFT_SIZE_SCALE,
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
