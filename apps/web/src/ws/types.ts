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
// Roster departure: the gateway sends this when a producer disconnects so the client
// drops the vehicle instead of leaving a frozen ghost on the map.
export type VehicleLeftMsg = { type: 'vehicleLeft'; ts: number; vehicleId: string }
export type CommandAckMsg = {
  type: 'commandAck'
  ts: number
  commandId: string
  accepted: boolean
  reason?: string | null
}

// Discriminated union: switch on `type` to route each message.
export type ServerMessage =
  | TelemetryMsg
  | MissionMsg
  | EventMsg
  | SnapshotMsg
  | ReplayMsg
  | CommandAckMsg
  | VehicleLeftMsg

// --- client -> server commands (the first uplink) ---
// Nullable/omitted fields mean "leave unchanged" (mirrors the server's type_mask idea).
export type HsaCommand = { kind: 'hsa'; headingDeg?: number | null; speedMps?: number | null; altM?: number | null }
export type LoiterCommand = {
  kind: 'loiter'
  centerLng?: number | null
  centerLat?: number | null
  radiusM?: number | null
  direction?: 'cw' | 'ccw' | null
  altM?: number | null
}
export type RacetrackCommand = {
  kind: 'racetrack'
  semiMajorM: number
  semiMinorM: number
  centerLng?: number | null
  centerLat?: number | null
  bearingDeg?: number | null
  direction?: 'cw' | 'ccw' | null
  altM?: number | null
}
export type Command = HsaCommand | LoiterCommand | RacetrackCommand
export type CommandMsg = { type: 'command'; ts: number; vehicleId?: string; commandId: string; command: Command }
