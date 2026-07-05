"""Wire contract for the GCS WebSocket stream.

Every server->client message is tagged by `type` (a discriminated union), so the
client can `switch` on it and route each to the right handler. This module is the
source of truth for the message shapes; the web client mirrors them in TypeScript
(Phase 3, commit 3). Positions are lng/lat to match deck.gl's coordinate order.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field


# --- shared sub-structures ---
class Position(BaseModel):
    lng: float
    lat: float
    altM: float = 0.0


class Attitude(BaseModel):
    yawDeg: float
    pitchDeg: float = 0.0
    rollDeg: float = 0.0


class Velocity(BaseModel):
    groundSpeedMps: float = 0.0


class Status(BaseModel):
    mode: str = "AUTO"
    batteryPct: float = 100.0


class VehicleState(BaseModel):
    vehicleId: str
    position: Position
    attitude: Attitude
    velocity: Velocity = Field(default_factory=Velocity)
    status: Status = Field(default_factory=Status)


class Geozone(BaseModel):
    name: str
    polygon: list[tuple[float, float]]  # [[lng, lat], ...]


# --- messages (discriminated by `type`) ---
class TelemetryMsg(VehicleState):
    type: Literal["telemetry"] = "telemetry"
    ts: int  # epoch milliseconds


class MissionMsg(BaseModel):
    type: Literal["mission"] = "mission"
    ts: int
    waypoints: list[tuple[float, float]] = []
    geozones: list[Geozone] = []


class EventMsg(BaseModel):
    type: Literal["event"] = "event"
    ts: int
    vehicleId: str
    level: Literal["info", "warning", "critical"] = "info"
    message: str


class SnapshotMsg(BaseModel):
    type: Literal["snapshot"] = "snapshot"
    ts: int
    vehicles: list[VehicleState] = []
    geozones: list[Geozone] = []


class ReplayMsg(BaseModel):
    type: Literal["replay"] = "replay"
    ts: int
    action: Literal["chunk", "play", "pause", "seek"] = "chunk"


class VehicleLeftMsg(BaseModel):
    # Roster departure: the gateway emits this when a producer disconnects, so already-
    # connected clients can drop the vehicle instead of leaving a frozen ghost on the map.
    type: Literal["vehicleLeft"] = "vehicleLeft"
    ts: int
    vehicleId: str


class CommandAckMsg(BaseModel):
    type: Literal["commandAck"] = "commandAck"
    ts: int
    vehicleId: str = ""  # which vehicle answered; "" when the gateway couldn't even parse the command
    commandId: str  # echoes the command it answers
    accepted: bool
    reason: str | None = None  # human-readable when rejected (e.g. violates a vehicle limit)


# Discriminated union: pydantic validates/parses by the `type` tag.
ServerMessage = Annotated[
    Union[TelemetryMsg, MissionMsg, EventMsg, SnapshotMsg, ReplayMsg, CommandAckMsg, VehicleLeftMsg],
    Field(discriminator="type"),
]


# --- client -> server commands (the first uplink) ---
# A command carries *intent* (setpoints); the server owns the truth and integrates it.
# Nullable fields mean "leave unchanged" — the clean equivalent of MAVLink's type_mask.
class HsaCommand(BaseModel):
    kind: Literal["hsa"] = "hsa"
    headingDeg: float | None = None
    speedMps: float | None = None
    altM: float | None = None


class LoiterCommand(BaseModel):
    kind: Literal["loiter"] = "loiter"
    centerLng: float | None = None  # None = loiter about the current position
    centerLat: float | None = None
    radiusM: float | None = None  # None = keep the current radius
    direction: Literal["cw", "ccw"] | None = None  # None = keep the current direction
    altM: float | None = None


class RacetrackCommand(BaseModel):
    kind: Literal["racetrack"] = "racetrack"
    semiMajorM: float  # half the overall LENGTH of the racetrack
    semiMinorM: float  # half the overall WIDTH == the 180deg turn radius
    centerLng: float | None = None  # None = about the current position
    centerLat: float | None = None
    bearingDeg: float | None = None  # long-axis heading; None = current heading
    direction: Literal["cw", "ccw"] | None = None
    altM: float | None = None


Command = Annotated[Union[HsaCommand, LoiterCommand, RacetrackCommand], Field(discriminator="kind")]


class CommandMsg(BaseModel):
    type: Literal["command"] = "command"
    ts: int
    vehicleId: str = "uav-01"
    commandId: str  # client-generated; echoed back in the ack
    command: Command


# What a client may send up. A one-member union for now, kept in the discriminated
# style so more uplink types slot in later without changing the parse site.
ClientMessage = CommandMsg


# --- internal vehicle <-> gateway link (/ingest), Milestone 4 Phase 10 ---
# A producer (one vehicle) dials the gateway and speaks THIS contract, not the
# browser-facing one. The frames are deliberately reused from above; the only new
# type is `register`, the identity handshake a producer sends first.
class RegisterMsg(BaseModel):
    type: Literal["register"] = "register"
    ts: int
    vehicle: VehicleState  # initial pose; the gateway keys its registry off vehicle.vehicleId


# Producer -> gateway (UP). Producers only ever emit these three; mission/snapshot/
# replay/event are the gateway's job downstream, never a producer's. Distinct `type`
# literals let pydantic route by discriminator, same as ServerMessage.
IngestMessage = Annotated[
    Union[RegisterMsg, TelemetryMsg, CommandAckMsg],
    Field(discriminator="type"),
]
# Gateway -> producer (DOWN) is just a routed CommandMsg — no new type needed.
