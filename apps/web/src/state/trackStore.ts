import { create } from 'zustand'

// The "hot lane": live vehicle state, updated on every telemetry tick. The render
// loop reads it imperatively via useTrackStore.getState() so high-frequency updates
// never trigger React re-renders. Geozones (cold mission data) also live here — set
// once from the snapshot and read by the same loop.

// Positions are [longitude, latitude] to match deck.gl's coordinate order. altM lets the
// trail render at the flight's real altitude in 3D (not flat on the ground).
export type TimedPoint = { coordinates: [number, number]; timestamp: number; altM: number }

export type Vehicle = {
  id: string
  position: [number, number]
  headingDeg: number
  updatedAt: number
  // Extra telemetry for the operator HUD panel (Phase 5). Optional: replay-sampled
  // vehicles (from the position-only recording) don't carry them.
  altM?: number
  speedMps?: number
  mode?: string
  batteryPct?: number
}

// One normalized telemetry sample (the WebSocket parser maps the wire message onto this).
export type TelemetrySample = {
  vehicleId: string
  position: [number, number]
  headingDeg: number
  ts: number
  altM: number
  speedMps: number
  mode: string
  batteryPct: number
}

export type Geozone = { name: string; polygon: [number, number][] }

// Bounded trail so memory stays flat during long flights (ring-buffer semantics).
const MAX_TRAIL_POINTS = 500

type TrackState = {
  vehicles: Record<string, Vehicle>
  trails: Record<string, TimedPoint[]>
  geozones: Geozone[]
  // Phase 4 replay: an UNCAPPED per-vehicle recording (the live trail is capped at 500;
  // replay needs full history). Written on the hot path only while `isRecording`.
  recording: Record<string, TimedPoint[]>
  isRecording: boolean
  ingest: (sample: TelemetrySample) => void
  setGeozones: (geozones: Geozone[]) => void
  startRecording: () => void
  stopRecording: () => void
  clear: () => void
}

export const useTrackStore = create<TrackState>()((set) => ({
  vehicles: {},
  trails: {},
  geozones: [],
  recording: {},
  isRecording: false,
  ingest: (s) =>
    set((state) => {
      const trail = [...(state.trails[s.vehicleId] ?? []), { coordinates: s.position, timestamp: s.ts, altM: s.altM }]
      if (trail.length > MAX_TRAIL_POINTS) trail.splice(0, trail.length - MAX_TRAIL_POINTS)
      const next: Partial<TrackState> = {
        vehicles: {
          ...state.vehicles,
          [s.vehicleId]: {
            id: s.vehicleId,
            position: s.position,
            headingDeg: s.headingDeg,
            updatedAt: s.ts,
            altM: s.altM,
            speedMps: s.speedMps,
            mode: s.mode,
            batteryPct: s.batteryPct,
          },
        },
        trails: { ...state.trails, [s.vehicleId]: trail },
      }
      if (state.isRecording) {
        next.recording = {
          ...state.recording,
          [s.vehicleId]: [...(state.recording[s.vehicleId] ?? []), { coordinates: s.position, timestamp: s.ts, altM: s.altM }],
        }
      }
      return next
    }),
  setGeozones: (geozones) => set({ geozones }),
  startRecording: () => set({ isRecording: true, recording: {} }),
  stopRecording: () => set({ isRecording: false }),
  clear: () => set({ vehicles: {}, trails: {}, geozones: [], recording: {}, isRecording: false }),
}))
