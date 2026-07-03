import { create } from 'zustand'

// The "hot lane": live vehicle state, updated on every telemetry tick. The render
// loop reads it imperatively via useTrackStore.getState() so high-frequency updates
// never trigger React re-renders. UI that wants a readout can subscribe with a
// selector (that's the cold-lane use of the same store).

// Positions are [longitude, latitude] to match deck.gl's coordinate order.
export type TimedPoint = { coordinates: [number, number]; timestamp: number }

export type Vehicle = {
  id: string
  position: [number, number]
  headingDeg: number
  updatedAt: number
}

// One normalized telemetry sample. Phase 3 maps the WebSocket `telemetry` message
// onto this shape; Phase 2's fake driver produces it directly.
export type TelemetrySample = {
  vehicleId: string
  position: [number, number]
  headingDeg: number
  ts: number
}

// Bounded trail so memory stays flat during long flights (ring-buffer semantics).
const MAX_TRAIL_POINTS = 500

type TrackState = {
  vehicles: Record<string, Vehicle>
  trails: Record<string, TimedPoint[]>
  ingest: (sample: TelemetrySample) => void
  clear: () => void
}

export const useTrackStore = create<TrackState>()((set) => ({
  vehicles: {},
  trails: {},
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
  clear: () => set({ vehicles: {}, trails: {} }),
}))
