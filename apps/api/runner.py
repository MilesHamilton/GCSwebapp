"""One vehicle's runtime: its sim clock + a reconnecting /ingest client to the gateway.

Factored out of main.py so both the single-vehicle producer (main.py) and the
multi-vehicle sim-host (simhost.py) share ONE copy of the (subtle) reconnect loop.
A VehicleRunner owns a VehicleSim, starts two tasks (sim loop + ingest client), and
can be stopped — which drops its gateway link, so the gateway prunes it and tells
clients (Phase 11 roster). That is exactly how runtime despawn propagates.
"""

import asyncio
import time
import traceback
from contextlib import suppress

from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from schemas import CommandAckMsg, CommandMsg, RegisterMsg
from sim import VehicleSim

TICK_S = 0.1  # 10 Hz: both the sim step and the telemetry emit
RECONNECT_MIN_MS = 500
RECONNECT_MAX_MS = 5000
RECONNECT_STABLE_S = 5.0  # a link must stay up this long before its backoff resets to MIN


def _now_ms() -> int:
    return int(time.time() * 1000)


class VehicleRunner:
    def __init__(self, sim: VehicleSim, gateway_url: str) -> None:
        self.sim = sim
        self.gateway_url = gateway_url
        self._tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        # Two independent tasks: the sim never pauses during a gateway outage, so a
        # reconnect resumes from CURRENT state (no teleport).
        self._tasks = [asyncio.create_task(self._sim_loop()), asyncio.create_task(self._ingest_client())]
        self._tasks[1].add_done_callback(self._on_ingest_done)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with suppress(asyncio.CancelledError):
                await t
        self._tasks = []

    def _on_ingest_done(self, task: "asyncio.Task[None]") -> None:
        # The ingest loop should run forever; surface an unexpected death (green
        # container, dead uplink is the worst failure for a GCS).
        if not task.cancelled() and (exc := task.exception()) is not None:
            traceback.print_exception(type(exc), exc, exc.__traceback__)

    async def _sim_loop(self) -> None:
        """The single authoritative clock for THIS vehicle: advance the sim at a fixed dt."""
        nxt = time.monotonic()
        while True:
            self.sim.step(TICK_S)
            nxt += TICK_S
            await asyncio.sleep(max(0.0, nxt - time.monotonic()))

    async def _ingest_client(self) -> None:
        """Register, then stream telemetry up and apply commands down, reconnecting with
        backoff. Catch OSError (cold-start ECONNREFUSED before the gateway binds) AND
        WebSocketException (handshake failures + ConnectionClosed) so no connection error
        permanently kills the uplink; reset backoff only after a stably-up link and always
        sleep a floor so an accept-then-drop gateway can't hot-loop."""
        backoff = RECONNECT_MIN_MS
        while True:
            connected_at: float | None = None
            try:
                async with connect(self.gateway_url) as ws:
                    await ws.send(RegisterMsg(ts=_now_ms(), vehicle=self.sim.state()).model_dump_json())
                    connected_at = time.monotonic()

                    async def sender() -> None:
                        while True:
                            await ws.send(self.sim.telemetry().model_dump_json())
                            await asyncio.sleep(TICK_S)

                    async def receiver() -> None:
                        while True:
                            raw = await ws.recv()
                            try:
                                msg = CommandMsg.model_validate_json(raw)
                            except ValidationError:
                                await ws.send(CommandAckMsg(ts=_now_ms(), vehicleId=self.sim.vehicle_id, commandId="", accepted=False, reason="invalid command").model_dump_json())
                                continue
                            accepted, reason = self.sim.apply(msg.command)  # the sim owns the truth
                            await ws.send(CommandAckMsg(ts=_now_ms(), vehicleId=self.sim.vehicle_id, commandId=msg.commandId, accepted=accepted, reason=reason).model_dump_json())

                    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for t in tasks:
                            t.cancel()
                        for t in tasks:
                            with suppress(asyncio.CancelledError, WebSocketException):
                                await t
            except (OSError, WebSocketException):
                pass  # fall through to the unified backoff below
            if connected_at is not None and time.monotonic() - connected_at >= RECONNECT_STABLE_S:
                backoff = RECONNECT_MIN_MS
            await asyncio.sleep(backoff / 1000.0)
            backoff = min(backoff * 2, RECONNECT_MAX_MS)
