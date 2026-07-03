// TypeScript mirror of api/schemas.py — the WebSocket wire contract.
// Kept in sync by hand (small surface); a codegen step is the "scale later" option.

export type Position = { lng: number; lat: number; altM?: number }
export type Attitude = { yawDeg: number; pitchDeg?: number; rollDeg?: number }
export type Velocity = { groundSpeedMps?: number }
export type Status = { mode?: string; batteryPct?: number }
export type Geozone = { name: string; polygon: [number, number][] }

export type VehicleState = {
  vehicleId: string
  position: Position
  attitude: Attitude
  velocity?: Velocity
  status?: Status
}

export type TelemetryMsg = VehicleState & { type: 'telemetry'; ts: number }
export type MissionMsg = { type: 'mission'; ts: number; waypoints: [number, number][]; geozones: Geozone[] }
export type EventMsg = {
  type: 'event'
  ts: number
  vehicleId: string
  level: 'info' | 'warning' | 'critical'
  message: string
}
export type SnapshotMsg = { type: 'snapshot'; ts: number; vehicles: VehicleState[]; geozones: Geozone[] }
export type ReplayMsg = { type: 'replay'; ts: number; action: 'chunk' | 'play' | 'pause' | 'seek' }

// Discriminated union: switch on `type` to route each message.
export type ServerMessage = TelemetryMsg | MissionMsg | EventMsg | SnapshotMsg | ReplayMsg
