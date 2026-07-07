import { PolygonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { OBJLoader } from '@loaders.gl/obj'
import type { Color, PickingInfo } from '@deck.gl/core'
import type { Vehicle, TimedPoint, Geozone } from '../state/trackStore'
import type { Waypoint } from '../state/missionStore'

// A render frame: the already-resolved world to draw (live OR replay), plus the trail
// cursor and cold-lane HUD state. buildLayers stays a pure state->layers function;
// MapView resolves live vs replay (sampling the recording @currentTime) before calling.
export type Trail = { id: string; points: TimedPoint[] }
export type RenderFrame = {
  vehicles: Vehicle[]
  trails: Trail[]
  geozones: Geozone[]
  // Per-vehicle 3D mission routes (markers + polyline). The selected vehicle's path is
  // drawn bright; the rest dimmed.
  waypointPaths: { id: string; waypoints: Waypoint[]; selected: boolean }[]
  currentTime: number // epoch ms; TripsLayer reveals each trail up to here
  zoom: number // map zoom; below LOW_ZOOM_THRESHOLD everything with altitude ground-locks
  showGeozones: boolean // geozones = the one global visibility toggle
  hiddenVehicles: Record<string, boolean> // per-vehicle hide: drops that craft's mesh + trail
  selectedId: string | null
  onSelectVehicle: (id: string) => void
}

// --- Aircraft (RQ-180 mesh). PINNED: zoom-flip is a known deck limitation (#5147);
// revisit via ScenegraphLayer + glTF. See notes/why-log.md.
const AIRCRAFT_COLOR: Color = [200, 205, 210]
const AIRCRAFT_SELECTED: Color = [255, 209, 102]
const AIRCRAFT_SIZE_SCALE = 5
// deck's getOrientation is [pitch, yaw, roll] in degrees; yaw tracks compass heading. The
// RQ-180 OBJ's nose is authored 180° from deck's forward, so the yaw offset is 270 (= 90 for
// the mesh's axis + 180 to point the nose along the direction of travel).
const HEADING_OFFSET = 270

const TRAIL_COLOR: Color = [57, 208, 255, 220]
const ZONE_LINE: Color = [255, 80, 80, 220]
const WP_COLOR: Color = [255, 209, 102, 230] // selected vehicle's mission (amber, like a selected craft)
const WP_COLOR_DIM: Color = [255, 209, 102, 90] // other vehicles' missions, dimmed
const WP_WALL_COLOR: Color = [255, 209, 102, 55] // ground-reference wall under a selected waypoint
const WP_WALL_COLOR_DIM: Color = [255, 209, 102, 22]
const WP_WALL_HALF_WIDTH_M = 12 // wall width, so it reads as a plane rather than a zero-width line
const M_PER_DEG_LAT = 111_320
const GEOZONE_HEIGHT_M = 2000 // extrude the zone into a floor->2 km airspace cage
// Below this zoom, real flight altitude (hundreds to low thousands of metres) reads as
// detached from the terrain — a floating cage, a trail smeared across the sky, a waypoint
// marker hovering with no visible ground contact. There's no fix for that within a single
// frame; instead every altitude-bearing layer collapses toward the ground below this zoom
// (the geozone cage flattens to its outline, trails/mission routes project to their ground
// track), and re-inflates once close enough that the vertical extent reads correctly again.
const LOW_ZOOM_THRESHOLD = 11

// TripsLayer stores timestamps as float32, which loses precision on raw epoch-ms
// (~1.7e12). Normalize to a small base per frame so the trail renders cleanly.
const TRAIL_WINDOW_MS = 1_000_000_000 // effectively unbounded: show the whole path up to currentTime

// A single flattened waypoint, tagged with its 1-based index and whether its vehicle is the
// selected one — the shared shape behind the wall/marker/label layers below.
type WpItem = Waypoint & { index: number; selected: boolean }

// A thin vertical quad from the ground up to `altM`, so the waypoint's altitude reads
// clearly against the terrain. Not a camera-facing billboard (deck has no primitive for
// that outside TextLayer/IconLayer) — a fixed diagonal plane, which looks right from most
// orbit angles. At altM=0 (ground-locked, low zoom) it degenerates to a zero-height sliver.
function wallQuad(w: Waypoint, altM: number): [number, number, number][] {
  const dLat = WP_WALL_HALF_WIDTH_M / M_PER_DEG_LAT
  const dLng = WP_WALL_HALF_WIDTH_M / (M_PER_DEG_LAT * Math.cos((w.lat * Math.PI) / 180))
  return [
    [w.lng - dLng, w.lat - dLat, 0],
    [w.lng - dLng, w.lat - dLat, altM],
    [w.lng + dLng, w.lat + dLat, altM],
    [w.lng + dLng, w.lat + dLat, 0],
  ]
}

export function buildLayers(frame: RenderFrame) {
  // Per-vehicle hide: a hidden craft drops BOTH its mesh and its trail (it keeps flying).
  const hidden = frame.hiddenVehicles
  const vehicles = frame.vehicles.filter((v) => !hidden[v.id])
  const trails = frame.trails.filter((t) => !hidden[t.id] && t.points.length >= 2)

  let base = Infinity
  for (const t of trails) for (const p of t.points) if (p.timestamp < base) base = p.timestamp
  if (!Number.isFinite(base)) base = 0

  // Zoomed in: extruded wireframe cage (a 3D airspace volume) and real-altitude trails/routes.
  // Zoomed out: everything with vertical extent collapses toward the ground (see
  // LOW_ZOOM_THRESHOLD above) so nothing reads as a disconnected floating shape.
  const extruded = frame.zoom >= LOW_ZOOM_THRESHOLD
  const groundLock = frame.zoom < LOW_ZOOM_THRESHOLD
  const wpAlt = (altM: number) => (groundLock ? 0 : altM)

  const wpItems: WpItem[] = frame.waypointPaths.flatMap((p) =>
    p.waypoints.map((w, index) => ({ ...w, index, selected: p.selected })),
  )

  return [
    new PolygonLayer<Geozone>({
      id: 'geozones',
      data: frame.geozones,
      visible: frame.showGeozones,
      getPolygon: (d) => d.polygon,
      // A restricted area has vertical extent — render it as an extruded WIREFRAME cage
      // (no filled walls). That reads as a 3D airspace volume with no translucent faces
      // to occlude the craft or z-fight in interleaved mode (the earlier side effect).
      extruded,
      getElevation: GEOZONE_HEIGHT_M,
      filled: false,
      wireframe: true,
      stroked: true,
      getLineColor: ZONE_LINE,
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      parameters: { depthWriteEnabled: false },
      pickable: true,
    }),
    new TripsLayer<Trail>({
      id: 'trails',
      data: trails,
      // Zoomed out: project to the ground track (alt 0) instead of real flight altitude,
      // so a long trail doesn't read as a line smeared across the sky with no anchor.
      getPath: (t) => t.points.map((p): [number, number, number] => [p.coordinates[0], p.coordinates[1], wpAlt(p.altM)]),
      getTimestamps: (t) => t.points.map((p) => p.timestamp - base),
      getColor: TRAIL_COLOR,
      getWidth: 2,
      widthUnits: 'pixels',
      currentTime: frame.currentTime - base,
      trailLength: TRAIL_WINDOW_MS,
      fadeTrail: false,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getPath: groundLock },
    }),
    // A semi-transparent ground-reference wall under each waypoint, for altitude visibility.
    // Ground-locked, this degenerates to a zero-height sliver (both edges land at z=0).
    new PolygonLayer<WpItem>({
      id: 'mission-wp-walls',
      data: wpItems,
      getPolygon: (w) => wallQuad(w, wpAlt(w.altM)),
      extruded: false,
      filled: true,
      stroked: false,
      getFillColor: (w) => (w.selected ? WP_WALL_COLOR : WP_WALL_COLOR_DIM),
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getFillColor: frame.selectedId, getPolygon: groundLock },
    }),
    // Mission routes: one polyline per vehicle, through its waypoints at their altitudes
    // (or their ground track, zoomed out)...
    new PathLayer<{ id: string; waypoints: Waypoint[]; selected: boolean }>({
      id: 'mission-paths',
      data: frame.waypointPaths.filter((p) => p.waypoints.length >= 2),
      getPath: (d) => d.waypoints.map((w): [number, number, number] => [w.lng, w.lat, wpAlt(w.altM)]),
      getColor: (d) => (d.selected ? WP_COLOR : WP_COLOR_DIM),
      getWidth: (d) => (d.selected ? 2 : 1.5),
      widthUnits: 'pixels',
      updateTriggers: { getColor: frame.selectedId, getWidth: frame.selectedId, getPath: groundLock },
    }),
    // ...and a marker at each waypoint (drawn at its 3D position, or ground-locked).
    new ScatterplotLayer<WpItem>({
      id: 'mission-waypoints',
      data: wpItems,
      getPosition: (w): [number, number, number] => [w.lng, w.lat, wpAlt(w.altM)],
      getFillColor: (w) => (w.selected ? WP_COLOR : WP_COLOR_DIM),
      getRadius: (w) => (w.selected ? 6 : 4),
      radiusUnits: 'pixels',
      stroked: true,
      getLineColor: [20, 24, 32, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      updateTriggers: { getFillColor: frame.selectedId, getRadius: frame.selectedId, getPosition: groundLock },
    }),
    // Always-on label: waypoint number + altitude, offset above the marker. The TEXT always
    // shows the real altitude; only the anchor position ground-locks at low zoom.
    new TextLayer<WpItem>({
      id: 'mission-wp-labels',
      data: wpItems,
      getPosition: (w): [number, number, number] => [w.lng, w.lat, wpAlt(w.altM)],
      getText: (w) => `#${w.index + 1} · ${Math.round(w.altM)}m`,
      getColor: (w) => (w.selected ? WP_COLOR : WP_COLOR_DIM),
      getSize: 12,
      sizeUnits: 'pixels',
      getPixelOffset: [0, -16],
      background: true,
      getBackgroundColor: [20, 24, 32, 180],
      backgroundPadding: [4, 2],
      updateTriggers: { getColor: frame.selectedId, getPosition: groundLock },
    }),
    new SimpleMeshLayer<Vehicle>({
      id: 'aircraft',
      data: vehicles,
      mesh: '/models/rq-180.obj',
      loaders: [OBJLoader],
      // 3D: fly the mesh at its real altitude (z=altM) so terrain/buildings can occlude it
      // under a pitched camera. Replay-sampled vehicles have no altM -> ground (0).
      getPosition: (d): [number, number, number] => [d.position[0], d.position[1], d.altM ?? 0],
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
