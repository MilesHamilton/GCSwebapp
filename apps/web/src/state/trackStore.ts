import { create } from 'zustand'

// The "hot lane": live vehicle state, updated on every telemetry tick. The render
// loop reads it imperatively via useTrackStore.getState() so high-frequency updates
// never trigger React re-renders. Geozones (cold mission data) also live here — set
// once from the snapshot and read by the same loop.

// Positions are [longitude, latitude] to match deck.gl's coordinate order.
export type TimedPoint = { coordinates: [number, number]; timestamp: number }

export type Vehicle = {
  id: string
  position: [number, number]
  headingDeg: number
  updatedAt: number
}

// One normalized telemetry sample (the WebSocket parser maps the wire message onto this).
export type TelemetrySample = {
  vehicleId: string
  position: [number, number]
  headingDeg: number
  ts: number
}

export type Geozone = { name: string; polygon: [number, number][] }

// Bounded trail so memory stays flat during long flights (ring-buffer semantics).
const MAX_TRAIL_POINTS = 500

type TrackState = {
  vehicles: Record<string, Vehicle>
  trails: Record<string, TimedPoint[]>
  geozones: Geozone[]
  ingest: (sample: TelemetrySample) => void
  setGeozones: (geozones: Geozone[]) => void
  clear: () => void
}

export const useTrackStore = create<TrackState>()((set) => ({
  vehicles: {},
  trails: {},
  geozones: [],
  ingest: (s) =>
    set((state) => {
      const trail = [
        ...(state.trails[s.vehicleId] ?? []),
        { coordinates: s.position, timestamp: s.ts },
      ]
      if (trail.length > MAX_TRAIL_POINTS) trail.splice(0, trail.length - MAX_TRAIL_POINTS)
      return {
        vehicles: {
          ...state.vehicles,
          [s.vehicleId]: {
            id: s.vehicleId,
            position: s.position,
            headingDeg: s.headingDeg,
            updatedAt: s.ts,
          },
        },
        trails: { ...state.trails, [s.vehicleId]: trail },
      }
    }),
  setGeozones: (geozones) => set({ geozones }),
  clear: () => set({ vehicles: {}, trails: {}, geozones: [] }),
}))
