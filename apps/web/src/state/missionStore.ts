import { create } from 'zustand'

// Cold-lane mission editor state: operator-placed 3D waypoint routes, one per vehicle.
// Human-speed, so ordinary React subscriptions are fine (the render loop reads imperatively).
export type Waypoint = { lng: number; lat: number; altM: number }

// New waypoints drop in at cruise altitude; the operator adjusts each one in the panel.
export const DEFAULT_WP_ALT_M = 500

type MissionState = {
  editing: boolean
  // Per-vehicle paths, keyed by vehicleId — clearing one leaves the others intact.
  paths: Record<string, Waypoint[]>
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
  warn: (text: string) => void
}

export const useMissionStore = create<MissionState>()((set) => ({
  editing: false,
  paths: {},
  active: {},
  warning: null,
  setEditing: (editing) => set({ editing }),
  addWaypoint: (id, lng, lat) =>
    set((s) => ({ paths: { ...s.paths, [id]: [...(s.paths[id] ?? []), { lng, lat, altM: DEFAULT_WP_ALT_M }] } })),
  updateAlt: (id, index, altM) =>
    set((s) => ({ paths: { ...s.paths, [id]: (s.paths[id] ?? []).map((w, i) => (i === index ? { ...w, altM } : w)) } })),
  removeWaypoint: (id, index) =>
    set((s) => ({ paths: { ...s.paths, [id]: (s.paths[id] ?? []).filter((_, i) => i !== index) } })),
  moveWaypoint: (id, index, dir) =>
    set((s) => {
      const arr = s.paths[id] ?? []
      const j = index + dir
      if (j < 0 || j >= arr.length) return {}
      const wps = [...arr]
      ;[wps[index], wps[j]] = [wps[j], wps[index]]
      return { paths: { ...s.paths, [id]: wps } }
    }),
  clearPaths: (ids) =>
    set((s) => {
      const paths = { ...s.paths }
      const active = { ...s.active }
      for (const id of ids) {
        delete paths[id]
        delete active[id]
      }
      return { paths, active }
    }),
  setPathForAll: (ids, waypoints) =>
    set((s) => {
      const paths = { ...s.paths }
      for (const id of ids) paths[id] = waypoints.map((w) => ({ ...w }))
      return { paths }
    }),
  markActive: (ids, value) =>
    set((s) => {
      const active = { ...s.active }
      for (const id of ids) active[id] = value
      return { active }
    }),
  warn: (text) => set((s) => ({ warning: { text, nonce: (s.warning?.nonce ?? 0) + 1 } })),
}))
