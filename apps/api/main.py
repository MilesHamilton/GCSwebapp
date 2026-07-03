import asyncio
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from sim import snapshot_at, telemetry_at

app = FastAPI(title="GCS API")

TICK_S = 0.1  # 10 Hz telemetry


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    """Stream telemetry to a connected client at ~10 Hz until it disconnects."""
    await websocket.accept()
    t0 = time.monotonic()
    try:
        # snapshot-on-connect: full current world state so a late joiner is whole.
        snap = snapshot_at(time.monotonic() - t0, int(time.time() * 1000))
        await websocket.send_text(snap.model_dump_json())
        while True:
            msg = telemetry_at(time.monotonic() - t0, int(time.time() * 1000))
            await websocket.send_text(msg.model_dump_json())
            await asyncio.sleep(TICK_S)
    except (WebSocketDisconnect, RuntimeError):
        return
