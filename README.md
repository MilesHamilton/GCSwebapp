# GCS Web App

A rudimentary **Ground Control Station (GCS)**: Python backend simulators emit
synthetic aircraft telemetry over WebSocket to a fan-in gateway; a
React/TypeScript client keeps in-memory world state and redraws **deck.gl**
map layers from it on a **Mapbox** basemap (3D terrain, sky, buildings).

Built as interview prep for a GCS / GIS engineering role — see
[`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase-by-phase design log.

## Architecture

- **`apps/gateway`** — FastAPI relay owning host `:8000`. Browsers connect on
  `/ws`; producers connect on `/ingest`. No sim, no clock — pure fan-in.
- **`apps/api`** — the producer image. Each container runs one `VehicleSim`
  (3-DOF point-mass autonomy loop) and streams its telemetry to the gateway.
  `docker-compose.yml` runs three of these (`uav-01/02/03`) with distinct
  start poses near KDCA.
- **`apps/web`** — Vite + React + TS client. Renders the Mapbox basemap with
  deck.gl layers (interleaved for occlusion), a HUD, replay controls, and a
  command uplink panel.

## Prerequisites

- Docker + Docker Compose
- Node.js (for the web dev server)
- A free Mapbox public token: https://account.mapbox.com/access-tokens/

## Running locally

**1. Start the backend** (gateway + simulated fleet):

```bash
docker compose up --build
```

Any time `apps/api/requirements.txt`, `apps/gateway/requirements.txt`, or a
Dockerfile changes, re-run this with `--build` — the bind mount hot-reloads
source but never picks up new image-baked dependencies.

**2. Configure the web client** (first run only):

```bash
cp apps/web/.env.example apps/web/.env
```

Paste your Mapbox token into `VITE_MAPBOX_TOKEN` in `apps/web/.env`.

**3. Run the web dev server on the host:**

```bash
npm --prefix apps/web install
npm --prefix apps/web run dev
```

The dev server runs on the host rather than in Docker — WSL2 bind-mount file
watching is slow, so host HMR is far snappier. It reaches the containerized
gateway at `ws://localhost:8000/ws` with no code changes needed.

**4. Open** http://localhost:5173

To stop: `Ctrl+C` the web dev server, then `docker compose down`.

### Optional: fully containerized web

For a clone-and-run demo (not day-to-day dev):

```bash
docker compose --profile full-container up
```

## Project layout

```
apps/
  api/       # producer image: VehicleSim + FastAPI WebSocket client
  gateway/   # fan-in relay: FastAPI WebSocket server
  web/       # Vite + React + TS + deck.gl + Mapbox client
docs/
  ROADMAP.md # phase-by-phase design log and rationale
notes/       # architecture notes + decision log (why-log)
```
