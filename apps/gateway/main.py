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
    VehicleState,
)

# --- gateway state (the only thing the gateway remembers) ---
# One outbound queue per socket, drained by that socket's single sender() task.
clients: dict[WebSocket, "asyncio.Queue[str]"] = {}  # browser -> its outbound queue
producers: dict[str, "asyncio.Queue[str]"] = {}  # vehicleId -> that producer's outbound queue
latest: dict[str, VehicleState] = {}  # vehicleId -> most-recent state (for snapshot-on-connect)

CLIENT_QUEUE_MAX = 256  # ~8-12 s of buffer; drop-oldest so one slow browser can't balloon memory

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


def _enqueue(q: "asyncio.Queue[str]", text: str) -> None:
    """Non-blocking put with drop-oldest. Fully synchronous — NEVER await here."""
    if q.full():
        q.get_nowait()  # evict oldest; safe (full => not empty) and no await => no race
    q.put_nowait(text)


def broadcast(text: str) -> None:
    """Fan a message out to every browser. Synchronous on purpose: no await means the
    iteration over clients is atomic w.r.t. the loop (no 'dict changed size' race, no
    head-of-line blocking). Do NOT introduce an await in this function."""
    for q in clients.values():
        _enqueue(q, text)


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
    out: "asyncio.Queue[str]" = asyncio.Queue(maxsize=CLIENT_QUEUE_MAX)
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
                    _enqueue(out, CommandAckMsg(ts=_now_ms(), commandId="", accepted=False, reason="invalid command").model_dump_json())
                    continue
                pq = producers.get(msg.vehicleId)
                if pq is None:
                    # The gateway holds the registry, so only it can answer "no such vehicle".
                    _enqueue(out, CommandAckMsg(ts=_now_ms(), commandId=msg.commandId, accepted=False, reason=f"vehicle {msg.vehicleId} not connected").model_dump_json())
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
                broadcast(raw)
            elif isinstance(msg, CommandAckMsg):
                broadcast(raw)  # single-operator: every browser gets it; unicast is Phase 11

    try:
        await _pump([asyncio.create_task(sender()), asyncio.create_task(receiver())])
    finally:
        # Identity-guarded prune: under --reload a reconnect can reuse the vehicleId
        # before this stale connection's finally runs; `is out` stops us clobbering it.
        if vehicle_id and producers.get(vehicle_id) is out:
            del producers[vehicle_id]
            latest.pop(vehicle_id, None)
