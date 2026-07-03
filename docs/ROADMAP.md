# GCS Web App — Learning Roadmap

## What this is

A rudimentary **Ground Control Station (GCS)**: a Python backend simulator emits
synthetic aircraft telemetry over a WebSocket; a React/TypeScript client keeps a
small in-memory world state and redraws **deck.gl** map layers from it, on a
**Mapbox** basemap.

Built as interview prep for a GCS / GIS engineering role. The point is not the
app — it's that you can **defend every architecture decision out loud**. This
doc is the spec you'll challenge, feature by feature.

## How we use this doc

Each phase = **one feature = one small, reviewable slice**. For every phase we
run this exact loop:

1. **You draft** — answer the phase's *seed question* in your own words.
2. **I critique** — I challenge your answer and the design.
3. **You approve** — we lock the approach.
4. **I implement** — the smallest code that satisfies the done-criteria.
5. **You verify** — run it, confirm the done-criteria.
6. **You explain** — write the 2-paragraph note in `notes/architecture.md`
   from memory, and add one line to `notes/why-log.md`.

**Rules:** plan before edit · one concern per commit · every nontrivial
decision gets a logged alternative.

## Architecture at a glance

- **`apps/api/`** (Python / FastAPI): emits aircraft position, attitude,
  velocity, status; serves waypoints + geozones; a `/ws` endpoint streams
  messages. Files: `main.py` (app), `sim.py` (aircraft generator),
  `schemas.py` (pydantic models).
- **`apps/web/`** (React / TS via Vite): Mapbox basemap + deck.gl overlay for
  telemetry; HUD panels for UI chrome. Dirs: `app/ map/ layers/ state/ ws/ hud/`.

**Two state lanes on the client** — the single most important idea here:

| Lane | What lives there | Why |
|------|------------------|-----|
| **Hot** | Latest vehicle positions, trail points, timestamps | Updated every socket tick; kept **out of React** so high-frequency telemetry never triggers component re-renders |
| **Cold** | Selected vehicle, panel/filter/theme state, playback controls | Low-frequency; normal React state is fine |

**Wire contract** — explicit and typed. Separate message types from day one so
the frontend reasons about one thing at a time instead of a giant mutable blob:

```json
{
  "type": "telemetry",
  "ts": 1782942485123,
  "vehicleId": "uav-01",
  "position": { "lng": -77.0365, "lat": 38.8977, "altM": 820 },
  "attitude": { "yawDeg": 112, "pitchDeg": 1.8, "rollDeg": -3.2 },
  "velocity": { "groundSpeedMps": 42 },
  "status": { "mode": "AUTO", "batteryPct": 78 }
}
```

- `telemetry` — high-rate aircraft state
- `mission` — waypoints, route edits, geozones
- `event` — mode changes, alerts, link loss, arm/disarm
- `snapshot` — full world-state sync when a client first connects
- `replay` — recorded trip chunks / playback control

**Replay-friendly trail shape** (used *live* too, so replay is free later):

```ts
type TimedPoint  = { coordinates: [number, number]; timestamp: number };
type VehicleTrack = { vehicleId: string; points: TimedPoint[] };
```

## Prerequisites

- **Mapbox token** — you chose Mapbox GL JS. Before Phase 1, create a free
  Mapbox account and a **public access token**, stored in `apps/web/.env` as
  `VITE_MAPBOX_TOKEN=...`. `.env` will be gitignored; never commit the token.
  (If token/billing friction ever bites, MapLibre GL JS is a near drop-in — see
  the why-log revisit trigger.)

## Phases

| # | Feature (one slice) | Key decisions → *alternative rejected* | Done when |
|---|---|---|---|
| **0** | Scaffold + learning rig | plain folders *vs pnpm workspace* | web boots blank page · api returns `/health` · first commit · `notes/` exist |
| **1** | Static map shell | interleaved *vs overlaid* · `MapboxOverlay` *vs `<DeckGL>` component* | map renders · aircraft icon at fixed coord · one geozone polygon · no console errors |
| **2** | Track store + layer factory + fake driver | Zustand *vs Context/module* · **TripsLayer *vs PathLayer*** · imperative loop *vs declarative re-render* · 10 Hz cadence | aircraft flies a circle · yaw + trail update · UI chrome doesn't re-render per tick |
| **3** | WebSocket transport + telemetry contract | 5 message types *vs one blob* · snapshot-on-connect · reconnect/backoff · validate at boundary | timer removed, backend drives it · refresh mid-flight → snapshot restores · drop server → reconnects |
| **4** | Replay | `TimedPoint` reused live+replay · live *vs replay* mode · where the clock lives | record a flight · scrub the timeline · trail animates to cursor |
| **5** | Operator HUD + camera sync | camera imperative `flyTo` *vs declarative `viewState`* · selection in cold lane | click aircraft → card fills · toggle geozone · follow → camera tracks |

---

### Phase 0 — Scaffold + learning rig

- **Slice:** repo skeleton (`apps/api`, `apps/web`), `git init`, `.gitignore`,
  a FastAPI `/health` endpoint, a Vite React/TS app that boots to a blank page,
  and the `notes/` files.
- **Seed question (you draft first):** *none* — this is setup with no design to
  critique. (Optional: sketch the folder tree from memory as a warm-up.)
- **Key decisions → alternative rejected:**
  - Plain two-folder repo *vs pnpm workspace / turborepo* → the two runtimes
    don't share a package manager, so workspace tooling is pure overhead now.
- **Done when:** `uvicorn` serves `GET /health` → `{"status":"ok"}`;
  `npm run dev` shows a blank Vite page; `git log` has one scaffold commit;
  `notes/architecture.md` + `notes/why-log.md` exist.
- **Commits:** `chore: scaffold repo + learning rig`

### Phase 1 — Static map shell

- **Slice:** Mapbox basemap + deck.gl overlay, **one hardcoded** aircraft
  `IconLayer`, **one** `PolygonLayer` geozone. No data movement, no network.
- **Seed question (you draft first):** *deck.gl can render **overlaid** (a
  separate canvas on top of Mapbox) or **interleaved** (deck draws into Mapbox's
  WebGL context, respecting map labels / 3D). Which do you pick for v1, and
  why? And why attach via `MapboxOverlay` instead of the `<DeckGL>` React
  component?*
- **Key decisions → alternative rejected:**
  - Interleaved *vs overlaid* `MapboxOverlay` render mode.
  - `MapboxOverlay` under `react-map-gl` *vs the `<DeckGL>` React component* →
    the overlay path keeps layer updates off React's render cycle (matters in
    Phase 2's hot path); `<DeckGL>` is simpler but re-renders on every change.
  - `IconLayer` for the vehicle *vs `ScenegraphLayer`* → icon first; 3D model
    only after everything else works.
- **Done when:** map renders, aircraft icon sits at a fixed lng/lat, one polygon
  is drawn, browser console is clean.
- **Commits:** `feat: static map shell (mapbox + deck overlay + icon + geozone)`

### Phase 2 — Track store + layer factory + fake driver

- **Slice:** a **Zustand** store for the hot lane, a **layer factory**
  (`state → deck layers[]`), and a browser timer that moves the aircraft in a
  circle while appending trail points. Proves the `state → layers` pipeline
  *without* the network.
- **Seed question (you draft first):** *What belongs in the hot lane vs the cold
  lane, and why keep telemetry out of React component state at all? What breaks
  if you put the aircraft position in `useState`?*
- **Key decisions → alternative rejected:**
  - **Zustand** *vs React Context vs a plain module store* → Context re-renders
    all consumers on change; a plain store works but Zustand gives selectors +
    devtools cheaply.
  - **`TripsLayer` *vs `PathLayer`* for the trail** → `TripsLayer` is
    timestamp-native (path + per-vertex time), so the same data drives live
    trailing *and* Phase 4 replay; `PathLayer` is static geometry only.
  - Imperative render loop (~10 Hz) rebuilding layers from the store *vs
    declarative React re-render per tick* → decouples draw rate from data rate
    and keeps React out of the hot path.
- **Done when:** aircraft circles, heading/yaw updates, trail grows, and React
  DevTools shows the HUD/chrome is **not** re-rendering every tick.
- **Commits:** `feat: track store (zustand hot lane)` · `feat: layer factory` ·
  `feat: fake telemetry driver (circle)`

### Phase 3 — WebSocket transport + telemetry contract

- **Slice:** `schemas.py` (pydantic), FastAPI `/ws` endpoint, `sim.py`
  generator, and a client `ws/` layer that validates messages and feeds the
  store. Send a `snapshot` on connect; **delete the browser timer**.
- **Seed question (you draft first):** *Why separate message types
  (`telemetry` / `mission` / `event` / `snapshot` / `replay`) instead of one
  blob? What problem does `snapshot`-on-connect solve that a stream of
  `telemetry` alone does not?*
- **Key decisions → alternative rejected:**
  - Five typed messages *vs one mutable blob* → each type has a different rate
    and consumer; a discriminated union keeps the client reducer simple.
  - Snapshot-on-connect *vs replaying history* → a late-joining client needs
    current world state immediately, not to wait for the next tick of each entity.
  - Client reconnect with backoff *vs fail-and-stop*.
  - Validate at the boundary (parse → typed) *vs trusting the wire*.
- **Done when:** the browser timer is gone and the backend drives the aircraft;
  refreshing mid-flight restores the world via `snapshot`; killing the server
  shows a disconnected state and the client reconnects when it returns.
- **Commits:** `feat: telemetry wire schema (pydantic)` ·
  `feat: FastAPI /ws + sim` · `feat: client ws parser → store` ·
  `feat: snapshot on connect`

### Phase 4 — Replay

- **Slice:** record emitted telemetry to a buffer/file, a playback clock, drive
  `TripsLayer` from `currentTime`, and a scrubber + play/pause.
- **Seed question (you draft first):** *Why is the live trail data already
  replay-ready? What does the playback clock own that live mode didn't need, and
  how does live vs replay mode switch cleanly?*
- **Key decisions → alternative rejected:**
  - Reuse `TimedPoint` for live + replay *vs a separate replay format* → one
    shape, one code path, export-friendly later.
  - A dedicated playback clock *vs reusing wall-clock time* → replay needs
    scrub/seek/pause, which wall-clock can't give you.
- **Done when:** you record a flight, switch to replay, scrub the timeline, and
  the aircraft + trail animate to the cursor position.
- **Commits:** `feat: telemetry recorder` · `feat: playback clock` ·
  `feat: replay scrubber UI`

### Phase 5 — Operator HUD + camera sync

- **Slice:** selected-vehicle card, connection status, playback controls, layer
  visibility toggles, and a camera **follow** mode.
- **Seed question (you draft first):** *Why is `selectedVehicleId` cold-lane
  state but the aircraft position hot-lane? For camera-follow, do you drive the
  map imperatively (`map.flyTo`) or declaratively (React `viewState`) — which,
  and what's the tradeoff during high-rate updates?*
- **Key decisions → alternative rejected:**
  - Imperative `flyTo` *vs declarative `viewState`* for follow → imperative
    avoids React churn on every tick; declarative is simpler but couples camera
    to render cadence.
  - Selection lives cold-lane *vs hot-lane* → it changes on click, not on tick.
- **Done when:** clicking the aircraft fills the card; the geozone toggle
  hides/shows the polygon; enabling follow keeps the camera tracking the aircraft.
- **Commits:** `feat: HUD vehicle card + conn status` ·
  `feat: camera follow/sync` · `feat: layer visibility toggles`
