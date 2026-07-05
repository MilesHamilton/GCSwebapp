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
import traceback
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from schemas import CommandAckMsg, CommandMsg, RegisterMsg
from sim import VehicleSim

TICK_S = 0.1  # 10 Hz: both the sim step and the telemetry emit

# The gateway this producer feeds. Compose DNS resolves 'gateway' on the network;
# host-run dev overrides via env to ws://localhost:8000/ingest.
GATEWAY_URL = os.getenv("GATEWAY_URL", "ws://gateway:8000/ingest")
VEHICLE_ID = os.getenv("VEHICLE_ID", "uav-01")
RECONNECT_MIN_MS = 500
RECONNECT_MAX_MS = 5000
RECONNECT_STABLE_S = 5.0  # a link must stay up this long before its backoff resets to MIN


def _env_pose() -> dict[str, float]:
    """Read only the start-pose env vars that are set; the rest fall to VehicleSim's
    defaults (today's DCA values), so a bare producer reproduces single-vehicle behavior."""
    keys = {
        "start_lat": "START_LAT",
        "start_lng": "START_LNG",
        "start_heading_deg": "START_HEADING_DEG",
        "start_alt_m": "START_ALT_M",
        "loiter_lat": "LOITER_LAT",
        "loiter_lng": "LOITER_LNG",
    }
    return {arg: float(os.environ[env]) for arg, env in keys.items() if env in os.environ}


# ONE stateful sim, stepped by ONE clock (this producer's _sim_loop). It keeps flying
# whether or not the gateway link is up, so a reconnect resumes from the CURRENT state.
sim = VehicleSim(vehicle_id=VEHICLE_ID, **_env_pose())


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
    apply commands down, reconnecting with backoff. The sim keeps stepping across a LINK
    outage, so we re-register from LIVE state and no client sees a teleport. (A dev code
    --reload is different: it reconstructs this module and resets the sim to its start pose.)

    Catch OSError (cold-start ECONNREFUSED/gaierror before the gateway binds) AND
    WebSocketException (handshake failures + ConnectionClosed, which subclasses it) so no
    connection error can permanently kill the uplink. Backoff resets only after a stably-up
    link and every iteration sleeps a floor, so an accept-then-drop gateway can't hot-loop
    the whole fleet against it."""
    backoff = RECONNECT_MIN_MS
    while True:
        connected_at: float | None = None
        try:
            async with connect(GATEWAY_URL) as ws:
                await ws.send(RegisterMsg(ts=_now_ms(), vehicle=sim.state()).model_dump_json())
                connected_at = time.monotonic()

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
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:  # either direction ending (a drop) tears the other down cleanly
                    for t in tasks:
                        t.cancel()
                    for t in tasks:
                        with suppress(asyncio.CancelledError, WebSocketException):
                            await t
        except (OSError, WebSocketException):
            pass  # fall through to the unified backoff below
        # Reset backoff only if the link stayed up a while; otherwise grow it. Always sleep
        # a floor so a clean/quick drop (or a suppressed post-handshake close) can't re-dial
        # with zero delay.
        if connected_at is not None and time.monotonic() - connected_at >= RECONNECT_STABLE_S:
            backoff = RECONNECT_MIN_MS
        await asyncio.sleep(backoff / 1000.0)
        backoff = min(backoff * 2, RECONNECT_MAX_MS)


def _on_ingest_done(task: "asyncio.Task[None]") -> None:
    # The ingest loop is meant to run forever (it reconnects internally). If it ever exits
    # with an UNEXPECTED exception, surface it loudly — a green container with a silently
    # dead uplink is the worst failure mode for a GCS.
    if not task.cancelled() and (exc := task.exception()) is not None:
        traceback.print_exception(type(exc), exc, exc.__traceback__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Two independent tasks: the sim never pauses during a gateway outage.
    task_sim = asyncio.create_task(_sim_loop())
    task_ingest = asyncio.create_task(_ingest_client())
    task_ingest.add_done_callback(_on_ingest_done)
    try:
        yield
    finally:
        task_sim.cancel()
        task_ingest.cancel()


app = FastAPI(title="GCS Producer", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
