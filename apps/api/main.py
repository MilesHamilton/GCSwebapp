"""GCS producer — one vehicle's autonomy computer (Milestone 4 Phase 10).

Formerly the /ws server the browser talked to directly; now it is a PRODUCER. It
still owns a single stateful VehicleSim stepped by one clock, but instead of serving
browsers it DIALS the gateway's /ingest, registers, streams its telemetry up, and
applies the commands routed back down. FastAPI is kept only for /health (and as the
seam for Phase 11's runtime spawn endpoint).
"""

import asyncio
import os
import time
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from schemas import CommandAckMsg, CommandMsg, RegisterMsg
from sim import VehicleSim

TICK_S = 0.1  # 10 Hz: both the sim step and the telemetry emit

# The gateway this producer feeds. Compose DNS resolves 'gateway' on the network;
# host-run dev overrides via env to ws://localhost:8000/ingest.
GATEWAY_URL = os.getenv("GATEWAY_URL", "ws://gateway:8000/ingest")
RECONNECT_MIN_MS = 500
RECONNECT_MAX_MS = 5000

# ONE stateful sim, stepped by ONE clock (this producer's _sim_loop). It keeps flying
# whether or not the gateway link is up, so a reconnect resumes from the CURRENT state.
sim = VehicleSim()


def _now_ms() -> int:
    return int(time.time() * 1000)


async def _sim_loop() -> None:
    """The single authoritative clock for THIS vehicle: advance the sim at a fixed dt."""
    nxt = time.monotonic()
    while True:
        sim.step(TICK_S)  # fixed dt -> deterministic dynamics
        nxt += TICK_S
        await asyncio.sleep(max(0.0, nxt - time.monotonic()))


async def _ingest_client() -> None:
    """Maintain the /ingest link to the gateway: register, then stream telemetry up and
    apply commands down, reconnecting with backoff. The sim keeps stepping across an
    outage, so we re-register from LIVE state (never the start pose) and no client sees
    a teleport. The whole `connect()` is inside the try because a cold start can hit
    ECONNREFUSED/gaierror (both OSError) before the gateway's uvicorn has bound."""
    backoff = RECONNECT_MIN_MS
    while True:
        try:
            async with connect(GATEWAY_URL) as ws:
                await ws.send(RegisterMsg(ts=_now_ms(), vehicle=sim.state()).model_dump_json())
                backoff = RECONNECT_MIN_MS  # connected -> reset

                async def sender() -> None:
                    while True:
                        await ws.send(sim.telemetry().model_dump_json())
                        await asyncio.sleep(TICK_S)

                async def receiver() -> None:
                    while True:
                        raw = await ws.recv()
                        # Commands arrive pre-routed by the gateway (already for THIS vehicle).
                        try:
                            msg = CommandMsg.model_validate_json(raw)
                        except ValidationError:
                            await ws.send(CommandAckMsg(ts=_now_ms(), commandId="", accepted=False, reason="invalid command").model_dump_json())
                            continue
                        accepted, reason = sim.apply(msg.command)  # the sim owns the truth
                        await ws.send(CommandAckMsg(ts=_now_ms(), commandId=msg.commandId, accepted=accepted, reason=reason).model_dump_json())

                tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                    with suppress(asyncio.CancelledError, ConnectionClosed):
                        await t
                for t in done:
                    with suppress(ConnectionClosed):
                        t.result()
        except (OSError, ConnectionClosed):
            await asyncio.sleep(backoff / 1000.0)
            backoff = min(backoff * 2, RECONNECT_MAX_MS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Two independent tasks: the sim never pauses during a gateway outage.
    task_sim = asyncio.create_task(_sim_loop())
    task_ingest = asyncio.create_task(_ingest_client())
    try:
        yield
    finally:
        task_sim.cancel()
        task_ingest.cancel()


app = FastAPI(title="GCS Producer", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
