"""GCS gateway — the fan-in aggregator for a fleet of vehicles (Milestone 4 Phase 10).

The gateway is a PURE relay/router. It runs NO sim and NO clock: each vehicle is a
separate producer that owns its own VehicleSim + step loop and dials this service's
`/ingest`. The gateway keeps only a registry and fans messages between the two links:

    producers ──/ingest──▶  [ registry + latest cache ]  ──/ws──▶  browsers

- telemetry flows UP from each producer, is fanned OUT to every browser (verbatim);
- a command flows DOWN: a browser sends it, the gateway routes it to the ONE producer
  registered under its vehicleId (the only thing that can `sim.apply()` it);
- the producer's commandAck flows back UP and is broadcast to browsers.

Concurrency invariant (load-bearing): on any one WebSocket there is exactly ONE
writer — a per-socket outbound queue drained by a single `sender()` task. Two
concurrent `await send_text` on one Starlette socket corrupt the ASGI stream, so the
receivers NEVER send directly; they only enqueue. `broadcast()` is fully synchronous
(no await), which makes iterating the client set atomic w.r.t. the event loop.
"""

import asyncio
import time
from collections import deque
from contextlib import suppress

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from schemas import (
    CommandAckMsg,
    CommandMsg,
    Geozone,
    IngestMessage,
    RegisterMsg,
    SnapshotMsg,
    TelemetryMsg,
    VehicleLeftMsg,
    VehicleState,
)

CLIENT_TEL_MAX = 256  # per-browser telemetry buffer; drop-oldest so a slow browser can't balloon memory


class ClientOut:
    """Per-browser outbound buffer with two lanes, drained by ONE sender. Control frames
    (commandAck / events) are NEVER dropped; telemetry is bounded drop-oldest. A single
    consumer awaits get(); many producers append synchronously (no await -> atomic). This
    stops a telemetry burst on a back-pressured browser from silently evicting a pending
    ack (the old single bounded queue could)."""

    def __init__(self, tel_max: int = CLIENT_TEL_MAX) -> None:
        self._control: deque[str] = deque()
        self._telemetry: deque[str] = deque()
        self._tel_max = tel_max
        self._wake = asyncio.Event()

    def put_control(self, text: str) -> None:
        self._control.append(text)
        self._wake.set()

    def put_telemetry(self, text: str) -> None:
        self._telemetry.append(text)
        while len(self._telemetry) > self._tel_max:
            self._telemetry.popleft()  # drop OLDEST telemetry only — never a control frame
        self._wake.set()

    async def get(self) -> str:
        """Control first, then telemetry; block until either has an item. Safe with a
        single consumer: clear() and wait() have no await between them, so no wakeup is lost."""
        while True:
            if self._control:
                return self._control.popleft()
            if self._telemetry:
                return self._telemetry.popleft()
            self._wake.clear()
            await self._wake.wait()


# --- gateway state (the only thing the gateway remembers) ---
# One outbound buffer per browser, drained by that socket's single sender() task.
clients: dict[WebSocket, ClientOut] = {}  # browser -> its two-lane outbound buffer
producers: dict[str, "asyncio.Queue[str]"] = {}  # vehicleId -> that producer's outbound queue
latest: dict[str, VehicleState] = {}  # vehicleId -> most-recent state (for snapshot-on-connect)

# Mission data (cold) now lives with the GCS, not each vehicle: served once to every
# late-joining client and never duplicated across producers. Moved verbatim from sim.py.
GEOZONES = [
    Geozone(
        name="R-1 DCA",
        # DCA airport box grown 2 miles (~3219 m) outward on every side:
        # +-0.02891 deg lat, +-0.03712 deg lng at this latitude.
        polygon=[
            (-77.08212, 38.81109),
            (-76.98388, 38.81109),
            (-76.98388, 38.89091),
            (-77.08212, 38.89091),
            (-77.08212, 38.81109),
        ],
    ),
]

_ingest_adapter = TypeAdapter(IngestMessage)  # validates the producer->gateway union

app = FastAPI(title="GCS Gateway")


def _now_ms() -> int:
    return int(time.time() * 1000)


def broadcast_telemetry(text: str) -> None:
    """Fan telemetry out to every browser (drop-oldest per client). Synchronous on purpose:
    no await means iterating clients is atomic w.r.t. the loop (no 'dict changed size' race,
    no head-of-line blocking). Do NOT introduce an await in this function."""
    for out in clients.values():
        out.put_telemetry(text)


def broadcast_control(text: str) -> None:
    """Fan a control frame (commandAck / event) out to every browser — never dropped."""
    for out in clients.values():
        out.put_control(text)


def build_snapshot() -> SnapshotMsg:
    """The full current world for a just-connected browser: every known vehicle's
    latest state + the mission geozones. Empty fleet -> vehicles=[] (client tolerates it)."""
    return SnapshotMsg(ts=_now_ms(), vehicles=list(latest.values()), geozones=GEOZONES)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


async def _pump(tasks: list["asyncio.Task[None]"]) -> None:
    """Run sender+receiver until either ends (usually a disconnect), then tear down."""
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
        with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await t
    for t in done:
        with suppress(WebSocketDisconnect, RuntimeError):
            t.result()


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    """Browser link: unchanged contract. Snapshot on connect, then live telemetry down
    and commands up. The receiver NEVER sends — it only enqueues (one-writer invariant)."""
    await websocket.accept()
    out = ClientOut()
    try:
        clients[websocket] = out
        # Registered before this send, so no telemetry tick is missed; the direct send is
        # safe because sender() hasn't started yet (momentarily the only writer).
        await websocket.send_text(build_snapshot().model_dump_json())

        async def sender() -> None:
            while True:
                await websocket.send_text(await out.get())

        async def receiver() -> None:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = CommandMsg.model_validate_json(raw)
                except ValidationError:
                    out.put_control(CommandAckMsg(ts=_now_ms(), commandId="", accepted=False, reason="invalid command").model_dump_json())
                    continue
                if msg.vehicleId == "*":  # broadcast: fan to every producer; each acks with its own id
                    if not producers:
                        out.put_control(CommandAckMsg(ts=_now_ms(), vehicleId="*", commandId=msg.commandId, accepted=False, reason="no vehicles connected").model_dump_json())
                    for pq in list(producers.values()):
                        pq.put_nowait(raw)
                    continue
                pq = producers.get(msg.vehicleId)
                if pq is None:
                    # The gateway holds the registry, so only it can answer "no such vehicle".
                    out.put_control(CommandAckMsg(ts=_now_ms(), vehicleId=msg.vehicleId, commandId=msg.commandId, accepted=False, reason=f"vehicle {msg.vehicleId} not connected").model_dump_json())
                    continue
                pq.put_nowait(raw)  # route down to the owning producer (unbounded queue)

        await _pump([asyncio.create_task(sender()), asyncio.create_task(receiver())])
    finally:
        clients.pop(websocket, None)


@app.websocket("/ingest")
async def ingest(websocket: WebSocket) -> None:
    """Producer link: register-first, then telemetry/acks up and commands down. Keys the
    registry off the CONNECTION's registered vehicle_id (not the wire field), so insert
    and prune use the same key -> no unroutable/unprunable ghosts."""
    await websocket.accept()
    out: "asyncio.Queue[str]" = asyncio.Queue()  # unbounded: commands are click-rate
    vehicle_id: str | None = None

    async def sender() -> None:
        while True:
            await websocket.send_text(await out.get())

    async def receiver() -> None:
        nonlocal vehicle_id
        while True:
            raw = await websocket.receive_text()
            try:
                msg = _ingest_adapter.validate_json(raw)
            except ValidationError:
                continue
            if vehicle_id is None and not isinstance(msg, RegisterMsg):
                await websocket.close(code=1008, reason="register first")
                return
            if isinstance(msg, RegisterMsg):
                vid = msg.vehicle.vehicleId
                if not vid:
                    await websocket.close(code=1008, reason="invalid register")
                    return
                vehicle_id = vid  # last-writer-wins doubles as clean reconnect handling
                producers[vid] = out
                latest[vid] = msg.vehicle
            elif isinstance(msg, TelemetryMsg):
                # Strip type/ts down to a clean VehicleState for the snapshot cache;
                # broadcast the raw frame verbatim (it already carries type='telemetry').
                latest[vehicle_id] = VehicleState(
                    vehicleId=vehicle_id,
                    position=msg.position,
                    attitude=msg.attitude,
                    velocity=msg.velocity,
                    status=msg.status,
                )
                broadcast_telemetry(raw)
            elif isinstance(msg, CommandAckMsg):
                broadcast_control(raw)  # single-operator: every browser gets it; unicast is Phase 11

    try:
        await _pump([asyncio.create_task(sender()), asyncio.create_task(receiver())])
    finally:
        # Identity-guarded prune: under --reload a reconnect can reuse the vehicleId
        # before this stale connection's finally runs; `is out` stops us clobbering it.
        if vehicle_id and producers.get(vehicle_id) is out:
            del producers[vehicle_id]
            latest.pop(vehicle_id, None)
            # Tell already-connected browsers to drop it (new clients' snapshots already omit
            # it). Control lane so it can't be evicted by a telemetry burst.
            broadcast_control(VehicleLeftMsg(ts=_now_ms(), vehicleId=vehicle_id).model_dump_json())
