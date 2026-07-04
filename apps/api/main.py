import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

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
    """Stream the shared sim's telemetry to a client at ~10 Hz until it disconnects."""
    await websocket.accept()
    try:
        # snapshot-on-connect: full current world state so a late joiner is whole.
        await websocket.send_text(sim.snapshot().model_dump_json())
        while True:
            await websocket.send_text(sim.telemetry().model_dump_json())
            await asyncio.sleep(TICK_S)
    except (WebSocketDisconnect, RuntimeError):
        return
