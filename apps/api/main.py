import asyncio
import time
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from schemas import CommandAckMsg, CommandMsg
from sim import VehicleSim

TICK_S = 0.1  # 10 Hz: both the sim step and the telemetry emit

# ONE shared sim, stepped by ONE clock. Every /ws connection reads this same
# instance, so all clients see one consistent world and it keeps flying with none
# connected (a stateful sim can't be recomputed per-connection like the old f(t)).
sim = VehicleSim()


async def _sim_loop() -> None:
    """The single authoritative clock: advance the sim at a fixed dt, paced to real time."""
    nxt = time.monotonic()
    while True:
        sim.step(TICK_S)  # fixed dt -> deterministic dynamics
        nxt += TICK_S
        await asyncio.sleep(max(0.0, nxt - time.monotonic()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_sim_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="GCS API", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    """Full-duplex link: stream telemetry down while accepting commands up, concurrently."""
    await websocket.accept()
    # snapshot-on-connect: full current world state so a late joiner is whole.
    await websocket.send_text(sim.snapshot().model_dump_json())

    async def sender() -> None:
        while True:
            await websocket.send_text(sim.telemetry().model_dump_json())
            await asyncio.sleep(TICK_S)

    async def receiver() -> None:
        while True:
            raw = await websocket.receive_text()
            # validate at the boundary; a malformed command is rejected, never trusted.
            try:
                msg = CommandMsg.model_validate_json(raw)
            except ValidationError:
                ack = CommandAckMsg(ts=int(time.time() * 1000), commandId="", accepted=False, reason="invalid command")
                await websocket.send_text(ack.model_dump_json())
                continue
            accepted, reason = sim.apply(msg.command)  # mutate the one shared sim
            ack = CommandAckMsg(ts=int(time.time() * 1000), commandId=msg.commandId, accepted=accepted, reason=reason)
            await websocket.send_text(ack.model_dump_json())

    # Run both directions concurrently; when either ends (usually a disconnect on
    # the receiver), cancel the other and tear the connection down cleanly.
    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
        with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await t
    for t in done:
        with suppress(WebSocketDisconnect, RuntimeError):
            t.result()
