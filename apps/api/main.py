"""GCS producer — one vehicle's autonomy computer (Milestone 4).

A PRODUCER: it owns a single stateful VehicleSim and dials the gateway's /ingest,
streaming telemetry up and applying commands routed down. The per-vehicle runtime
(sim clock + reconnecting ingest client) lives in VehicleRunner, shared with the
sim-host. FastAPI is kept only for /health.
"""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from runner import VehicleRunner
from sim import VehicleSim

GATEWAY_URL = os.getenv("GATEWAY_URL", "ws://gateway:8000/ingest")
VEHICLE_ID = os.getenv("VEHICLE_ID", "uav-01")


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


runner = VehicleRunner(VehicleSim(vehicle_id=VEHICLE_ID, **_env_pose()), GATEWAY_URL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    runner.start()
    try:
        yield
    finally:
        await runner.stop()


app = FastAPI(title="GCS Producer", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
