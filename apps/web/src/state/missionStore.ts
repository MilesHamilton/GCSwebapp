import { create } from 'zustand'

// Cold-lane mission editor state: operator-placed 3D waypoint routes, one per vehicle.
// Human-speed, so ordinary React subscriptions are fine (the render loop reads imperatively).
export type Waypoint = { lng: number; lat: number; altM: number }

// New waypoints drop in at cruise altitude until the operator enters one; after that,
// new waypoints (on any vehicle) default to whatever altitude was last entered.
export const DEFAULT_WP_ALT_M = 500

type MissionState = {
  editing: boolean
  // Per-vehicle paths, keyed by vehicleId — clearing one leaves the others intact.
  paths: Record<string, Waypoint[]>
  // The last route actually TRANSMITTED to each vehicle (snapshotted on Send). Unlike
  // `paths`, Clear never touches this — it's what replay's "reached waypoint #N" markers
  // match against, so clearing the on-screen draft (which also loiters the vehicle in
  // place) can't silently erase the record of a route the vehicle actually flew.
  sentPaths: Record<string, Waypoint[]>
  // The most recent altitude the operator entered, across any waypoint on any vehicle.
  // Seeds the altitude of the next newly-placed waypoint.
  lastAltM: number
  // Bumped whenever a path's SET or ORDER changes (add/remove/move/clear/replace), never on
  // a plain altitude edit. The waypoint list UI keys its altitude inputs off this so a typed
  // value in one field is never clobbered by a re-render, but a reorder/add/remove still
  // forces the row to remount with the current value.
  revision: number
  // Which vehicles are currently FLYING a sent mission (vs. an unsent local draft). Clear
  // only issues a "loiter in place" for an active vehicle, so it never disrupts one that
  // wasn't following a route.
  active: Record<string, boolean>
  // `nonce` bumps on every warning so an identical repeated message still re-triggers the UI.
  warning: { text: string; nonce: number } | null
  setEditing: (editing: boolean) => void
  addWaypoint: (vehicleId: string, lng: number, lat: number) => void
  updateAlt: (vehicleId: string, index: number, altM: number) => void
  removeWaypoint: (vehicleId: string, index: number) => void
  moveWaypoint: (vehicleId: string, index: number, dir: -1 | 1) => void
  clearPaths: (vehicleIds: string[]) => void
  setPathForAll: (vehicleIds: string[], waypoints: Waypoint[]) => void
  markActive: (vehicleIds: string[], value: boolean) => void
  markSent: (vehicleIds: string[], waypoints: Waypoint[]) => void
  warn: (text: string) => void
}

export const useMissionStore = create<MissionState>()((set) => ({
  editing: false,
  paths: {},
  sentPaths: {},
  lastAltM: DEFAULT_WP_ALT_M,
  revision: 0,
  active: {},
  warning: null,
  setEditing: (editing) => set({ editing }),
  addWaypoint: (id, lng, lat) =>
    set((s) => ({
      paths: { ...s.paths, [id]: [...(s.paths[id] ?? []), { lng, lat, altM: s.lastAltM }] },
      revision: s.revision + 1,
    })),
  updateAlt: (id, index, altM) =>
    set((s) => ({
      paths: { ...s.paths, [id]: (s.paths[id] ?? []).map((w, i) => (i === index ? { ...w, altM } : w)) },
      lastAltM: altM,
    })),
  removeWaypoint: (id, index) =>
    set((s) => ({
      paths: { ...s.paths, [id]: (s.paths[id] ?? []).filter((_, i) => i !== index) },
      revision: s.revision + 1,
    })),
  moveWaypoint: (id, index, dir) =>
    set((s) => {
      const arr = s.paths[id] ?? []
      const j = index + dir
      if (j < 0 || j >= arr.length) return {}
      const wps = [...arr]
      ;[wps[index], wps[j]] = [wps[j], wps[index]]
      return { paths: { ...s.paths, [id]: wps }, revision: s.revision + 1 }
    }),
  clearPaths: (ids) =>
    set((s) => {
      const paths = { ...s.paths }
      const active = { ...s.active }
      for (const id of ids) {
        delete paths[id]
        delete active[id]
      }
      return { paths, active, revision: s.revision + 1 }
    }),
  setPathForAll: (ids, waypoints) =>
    set((s) => {
      const paths = { ...s.paths }
      for (const id of ids) paths[id] = waypoints.map((w) => ({ ...w }))
      return { paths, revision: s.revision + 1 }
    }),
  markActive: (ids, value) =>
    set((s) => {
      const active = { ...s.active }
      for (const id of ids) active[id] = value
      return { active }
    }),
  markSent: (ids, waypoints) =>
    set((s) => {
      const sentPaths = { ...s.sentPaths }
      for (const id of ids) sentPaths[id] = waypoints.map((w) => ({ ...w }))
      return { sentPaths }
    }),
  warn: (text) => set((s) => ({ warning: { text, nonce: (s.warning?.nonce ?? 0) + 1 } })),
}))
