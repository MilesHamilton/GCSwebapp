import { PolygonLayer, PathLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { OBJLoader } from '@loaders.gl/obj'
import type { Color } from '@deck.gl/core'
import type { Vehicle, TimedPoint } from '../state/trackStore'

// A read-only snapshot of the hot lane. The factory turns it into deck layers.
export type WorldSnapshot = {
  vehicles: Record<string, Vehicle>
  trails: Record<string, TimedPoint[]>
}

// --- Aircraft (RQ-180 mesh). PINNED: zoom-flip is a known deck limitation (#5147);
// revisit via ScenegraphLayer + glTF. See notes/why-log.md.
const AIRCRAFT_COLOR: Color = [200, 205, 210]
const AIRCRAFT_SIZE_SCALE = 5
const HEADING_OFFSET = 90

// --- Trail
const TRAIL_COLOR: Color = [57, 208, 255, 180]

// --- Geozone: mission data (cold lane); static config for now.
type Geozone = { name: string; polygon: [number, number][] }
const GEOZONES: Geozone[] = [
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

type Trail = { id: string; points: TimedPoint[] }

// Pure function: world snapshot -> deck layers. Called by the render path, not React.
export function buildLayers(world: WorldSnapshot) {
  const vehicles = Object.values(world.vehicles)
  // A PathLayer path needs >= 2 points; skip trails that are just a seed point.
  const trails: Trail[] = Object.entries(world.trails)
    .map(([id, points]) => ({ id, points }))
    .filter((t) => t.points.length >= 2)

  return [
    new PolygonLayer<Geozone>({
      id: 'geozones',
      data: GEOZONES,
      getPolygon: (d) => d.polygon,
      getFillColor: ZONE_FILL,
      getLineColor: ZONE_LINE,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: true,
    }),
    new PathLayer<Trail>({
      id: 'trails',
      data: trails,
      getPath: (t) => t.points.map((p) => p.coordinates),
      getColor: TRAIL_COLOR,
      getWidth: 2,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    }),
    new SimpleMeshLayer<Vehicle>({
      id: 'aircraft',
      data: vehicles,
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
