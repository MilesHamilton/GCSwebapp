"""GCS sim-host — runtime spawn/despawn of vehicles (Milestone 4 Phase 11).

A control-plane service the operator panel calls directly (its own host port). It runs
spawned vehicles as VehicleRunner tasks IN-PROCESS — each dials the gateway like any
producer, so a spawned vehicle is indistinguishable from a compose-defined one on the
wire. Despawn stops the runner, which drops its gateway link -> the gateway prunes it
and broadcasts vehicleLeft, so the client removes it (Phase 11 roster). No new container
per vehicle: the distributed lesson is the gateway's dynamic registration, not Docker.
"""

import itertools
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from runner import VehicleRunner
from sim import CENTER_LAT, CENTER_LNG, CRUISE_ALT_M, RWY_BEARING_DEG, VehicleSim

GATEWAY_URL = os.getenv("GATEWAY_URL", "ws://gateway:8000/ingest")

runners: dict[str, VehicleRunner] = {}
_counter = itertools.count(101)  # spawned ids start at uav-101, clear of the compose fleet


class SpawnReq(BaseModel):
    # All optional: the sim-host fills sensible, visually-distinct defaults near DCA.
    vehicleId: str | None = None
    startLat: float | None = None
    startLng: float | None = None
    startHeadingDeg: float | None = None
    startAltM: float | None = None
    loiterLat: float | None = None
    loiterLng: float | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    for r in list(runners.values()):
        await r.stop()


app = FastAPI(title="GCS Sim-Host", lifespan=lifespan)
# The panel (a browser origin) POSTs here cross-origin, so allow it. This is a local
# dev control plane, not a public API.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/vehicles")
def list_vehicles() -> dict[str, list[str]]:
    return {"vehicles": sorted(runners.keys())}


@app.post("/vehicles")
async def spawn(req: SpawnReq) -> dict[str, str]:
    vid = req.vehicleId or f"uav-{next(_counter)}"
    if vid in runners:
        raise HTTPException(status_code=409, detail=f"{vid} already exists")
    # Spread spawned vehicles around DCA (distinct loiter center + altitude) so they don't
    # stack; caller-supplied fields win.
    n = len(runners)
    lat = req.loiterLat if req.loiterLat is not None else CENTER_LAT + 0.012 * ((n % 3) - 1)
    lng = req.loiterLng if req.loiterLng is not None else CENTER_LNG + 0.012 * ((n // 3) - 1)
    sim = VehicleSim(
        vehicle_id=vid,
        start_lat=req.startLat if req.startLat is not None else lat,
        start_lng=req.startLng if req.startLng is not None else lng,
        start_heading_deg=req.startHeadingDeg if req.startHeadingDeg is not None else RWY_BEARING_DEG,
        start_alt_m=req.startAltM if req.startAltM is not None else CRUISE_ALT_M + 150.0 * n,
        loiter_lat=lat,
        loiter_lng=lng,
    )
    runner = VehicleRunner(sim, GATEWAY_URL)
    runner.start()
    runners[vid] = runner
    return {"vehicleId": vid}


@app.delete("/vehicles/{vehicle_id}")
async def despawn(vehicle_id: str) -> dict[str, object]:
    runner = runners.pop(vehicle_id, None)
    if runner is None:
        raise HTTPException(status_code=404, detail=f"{vehicle_id} not managed by this sim-host")
    await runner.stop()  # drops the gateway link -> gateway prunes -> client gets vehicleLeft
    return {"vehicleId": vehicle_id, "removed": True}
