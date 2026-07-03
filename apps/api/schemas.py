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


# Discriminated union: pydantic validates/parses by the `type` tag.
ServerMessage = Annotated[
    Union[TelemetryMsg, MissionMsg, EventMsg, SnapshotMsg, ReplayMsg],
    Field(discriminator="type"),
]
