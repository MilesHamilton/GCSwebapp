import { PolygonLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { OBJLoader } from '@loaders.gl/obj'
import type { Color, PickingInfo } from '@deck.gl/core'
import type { Vehicle, TimedPoint, Geozone } from '../state/trackStore'

// A render frame: the already-resolved world to draw (live OR replay), plus the trail
// cursor and cold-lane HUD state. buildLayers stays a pure state->layers function;
// MapView resolves live vs replay (sampling the recording @currentTime) before calling.
export type Trail = { id: string; points: TimedPoint[] }
export type RenderFrame = {
  vehicles: Vehicle[]
  trails: Trail[]
  geozones: Geozone[]
  currentTime: number // epoch ms; TripsLayer reveals each trail up to here
  visibility: { geozones: boolean; trail: boolean; aircraft: boolean }
  selectedId: string | null
  onSelectVehicle: (id: string) => void
}

// --- Aircraft (RQ-180 mesh). PINNED: zoom-flip is a known deck limitation (#5147);
// revisit via ScenegraphLayer + glTF. See notes/why-log.md.
const AIRCRAFT_COLOR: Color = [200, 205, 210]
const AIRCRAFT_SELECTED: Color = [255, 209, 102]
const AIRCRAFT_SIZE_SCALE = 5
const HEADING_OFFSET = 90

const TRAIL_COLOR: Color = [57, 208, 255, 220]
const ZONE_FILL: Color = [255, 80, 80, 40]
const ZONE_LINE: Color = [255, 80, 80, 200]

// TripsLayer stores timestamps as float32, which loses precision on raw epoch-ms
// (~1.7e12). Normalize to a small base per frame so the trail renders cleanly.
const TRAIL_WINDOW_MS = 1_000_000_000 // effectively unbounded: show the whole path up to currentTime

export function buildLayers(frame: RenderFrame) {
  const trails = frame.trails.filter((t) => t.points.length >= 2)

  let base = Infinity
  for (const t of trails) for (const p of t.points) if (p.timestamp < base) base = p.timestamp
  if (!Number.isFinite(base)) base = 0

  return [
    new PolygonLayer<Geozone>({
      id: 'geozones',
      data: frame.geozones,
      visible: frame.visibility.geozones,
      getPolygon: (d) => d.polygon,
      getFillColor: ZONE_FILL,
      getLineColor: ZONE_LINE,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: true,
    }),
    new TripsLayer<Trail>({
      id: 'trails',
      data: trails,
      visible: frame.visibility.trail,
      getPath: (t) => t.points.map((p) => p.coordinates),
      getTimestamps: (t) => t.points.map((p) => p.timestamp - base),
      getColor: TRAIL_COLOR,
      getWidth: 2,
      widthUnits: 'pixels',
      currentTime: frame.currentTime - base,
      trailLength: TRAIL_WINDOW_MS,
      fadeTrail: false,
      capRounded: true,
      jointRounded: true,
    }),
    new SimpleMeshLayer<Vehicle>({
      id: 'aircraft',
      data: frame.vehicles,
      visible: frame.visibility.aircraft,
      mesh: '/models/rq-180.obj',
      loaders: [OBJLoader],
      getPosition: (d) => d.position,
      getColor: (d) => (d.id === frame.selectedId ? AIRCRAFT_SELECTED : AIRCRAFT_COLOR),
      getOrientation: (d): [number, number, number] => [0, HEADING_OFFSET - d.headingDeg, 0],
      sizeScale: AIRCRAFT_SIZE_SCALE,
      pickable: true,
      onClick: (info: PickingInfo<Vehicle>) => {
        if (info.object) {
          frame.onSelectVehicle(info.object.id)
          return true
        }
        return false
      },
      updateTriggers: { getColor: frame.selectedId },
    }),
  ]
}
