# Deploying to Render

The whole fleet deploys from `render.yaml` (a Render **Blueprint**) — the hosted
equivalent of `docker compose up`. Unlike Vercel, Render runs Docker and long-lived
WebSockets, so the gateway and producers run as-is.

## What gets deployed

| Service       | Type            | Role                                              |
| ------------- | --------------- | ------------------------------------------------- |
| `gcs-gateway` | Web Service     | Public. Browser `/ws` + producers `/ingest`.      |
| `uav-01/02/03`| Private Service | Each dials `ws://gcs-gateway:8000/ingest`.        |
| `gcs-web`     | Web Service     | Public nginx SPA behind HTTP Basic Auth.          |

All five are pinned to one region (`oregon`) — Render's private network and
service-to-service DNS only work within a region.

> **Cost:** five services on the `starter` plan (~$7/mo each). Private services and
> multiple web services are not on the free tier. Drop `uav-02`/`uav-03` from
> `render.yaml` if you want a cheaper single-vehicle demo.

## One-time setup

1. Push to GitHub (done): `https://github.com/MilesHamilton/GCSwebapp`.
2. In Render: **New → Blueprint**, connect the repo. Render reads `render.yaml`.
3. Before the first deploy, set the secret env vars (marked `sync:false`) on **`gcs-web`**:
   - `VITE_MAPBOX_TOKEN` — your public `pk.*` Mapbox token.
   - `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` — the login for the app's front door.
4. Apply. Render builds all five services.
5. **Wire the gateway URL into the web build.** Once `gcs-gateway` is up, copy its public
   URL (top of the service page) and set on `gcs-web`:
   - `VITE_WS_URL = wss://<gcs-gateway host>.onrender.com/ws`

   Then redeploy `gcs-web` with **Clear build cache & deploy** (Vite bakes this at build
   time). This can't be auto-wired: `fromService` only exposes a service's *private*
   host (`gcs-gateway`), which the browser can't resolve — there's no property for the
   public `.onrender.com` URL.

## Verify

- Visit the `gcs-web` URL → browser shows a Basic Auth prompt. Wrong/empty creds → 401.
- After login, the Operator HUD should show **`link ●`** and three aircraft appear
  within a few seconds (producers connect to the gateway, gateway snapshots the client).

## Notes / caveats

- **TLS:** Render terminates HTTPS, so the client speaks `wss://` to the gateway
  automatically (`wss://<gateway-host>/ws`) — no cert work needed.
- **Build-arg wiring:** `VITE_GATEWAY_HOST` is baked into the bundle at *build* time via
  `fromService`. If a build ever can't see it, set `VITE_WS_URL` on `gcs-web` explicitly
  to `wss://<your-gateway>.onrender.com/ws` and redeploy — the client prefers it.
- **Auth scope:** Basic Auth gates the *frontend only* (the chosen scope). The gateway
  WS stays open; it's a telemetry relay with no persisted state.
- **Cold starts:** on `starter`, services stay warm. If you move the web tier to a free
  static site later, it will spin down when idle.
