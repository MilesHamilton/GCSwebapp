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
| | **▸ Milestone 2 — fake flight autonomy computer** | | |
| **6** | Stateful flight model (autonomy core) | stateful `step(dt)` *vs closed-form `f(t)`* · 3-DOF point-mass *vs 6-DOF* · one shared sim *vs per-connection* | circle now *emerges* from an integrated loiter law · sim is one shared stateful object · frontend untouched |
| **7** | Command uplink (HSA + loiter/CAP) | command on existing `/ws` *vs REST / 2nd socket* · typed union *vs MAVLink `COMMAND_LONG`* · loiter = tangent reusing the HSA heading loop *vs a separate orbit integrator* | send HSA → aircraft slews & holds · loiter → CAP orbit · infeasible cmd → rejected + reason |
| **8** | Dockerize the autonomy computer | single api container *vs separate autonomy container over a bus* · web on host *vs containerized (WSL2 HMR)* | `docker compose up` → api streams · host web flies & commands · edit `.py` → hot reload |

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

---

## Milestone 2 — Fake flight autonomy computer

Phases 0–5 make a **playback**: `telemetry_at(t)` returns the aircraft's position
as a *pure function of time* (a scripted circle). A flight **autonomy computer**
isn't playback — it **holds vehicle state, accepts commands, and flies itself**
toward them within the airframe's limits. This milestone makes that shift — the
same one real software-in-the-loop sims (ArduPilot / PX4 SITL) are built around:

- **Stateless → stateful.** `telemetry_at(t)` becomes `VehicleSim.step(dt)` — a
  fixed-timestep integrator carrying `{lat, lng, alt, heading, speed}` forward.
  The old circle survives as the *steady state* of a loiter law, not a script.
- **First uplink.** Everything so far is downlink; commands now ride the *same*
  `/ws` as a new `command` message, acknowledged with `commandAck`.
- **The commands.** **HSA** (heading / speed / altitude setpoints) and **Loiter
  / CAP** (a circular orbit) — the two the fake autopilot tracks.
- **Vehicle characteristics as clamps.** An RQ-180 stand-in supplies the *only*
  physics that matters here: how fast it may turn, climb, and accelerate.
- **Docker.** Package the sim as a reproducible, isolated service.

**RQ-180 stand-in.** The RQ-180 is classified, so these are open-source
*estimates* (gaps filled from its sibling, the RQ-4 Global Hawk) — deliberate,
swappable constants, stored in SI to match the wire contract:

| Characteristic | Estimate (SI) | Role in the sim |
|---|---|---|
| Cruise speed | ~42 m/s\* | default ground speed |
| Speed envelope | 30–60 m/s | clamps commanded speed |
| Max bank | 25° | → max turn rate `ω = g·tan φ / V` |
| Max climb/descent | 8 m/s | clamps commanded altitude rate |
| Max accel | 2 m/s² | clamps the speed ramp |
| Service ceiling | ~18 km | clamps commanded altitude |

\* *Kept at today's ~42 m/s for map-scale continuity; the realistic RQ-180 cruise
(~175 m/s) is a one-constant swap — logged as the rejected alternative.*

> **Build-order note:** the sim + command work (6–7) is the interesting part, so
> it comes first and Docker (8) packages it last. If you'd rather develop
> everything inside the container from the start, pull Phase 8 to the front — it
> wraps the *current* app unchanged, so it reorders cleanly.

### Phase 6 — Stateful flight model (autonomy core)

- **Slice:** replace the stateless `telemetry_at(t)` with a **single, shared,
  stateful `VehicleSim`** stepped by **one** background task at a fixed `dt`
  (10 Hz), plus a `vehicle.py` `VehicleCharacteristics` (the RQ-180 stand-in)
  that supplies the clamps. **No commands yet** — the default mode is a loiter
  whose steady state *reproduces today's circle*, so nothing visibly regresses.
  Telemetry/snapshot wire shapes are **unchanged** (`status.mode`, `rollDeg`
  already exist).
- **Seed question (you draft first):** *Today position is a pure function of time
  (`telemetry_at(t)`). Why must the sim become **stateful** — integrating state
  forward — before it can accept commands? What can't you express as `f(t)` once
  the requirement is "turn toward heading X at no more than the airframe's max
  turn rate, then hold"? And why must there be **exactly one** sim instance
  stepped by **one** clock, not one per WebSocket connection?*
- **Key decisions → alternative rejected:**
  - Stateful integrating `step(dt)` *vs keeping closed-form `telemetry_at(t)`* →
    setpoint tracking under rate limits has no clean closed form; a tiny Euler
    integrator is simpler and is exactly how a real autopilot loop works.
  - **3-DOF point-mass (kinematic)** *vs 6-DOF rigid body + aero* → we need a
    believable track that respects limits, not flight-dynamics fidelity; 6-DOF
    needs an aero database and a fast inner loop we'd have to justify.
  - **One shared sim stepped by a single background task** *vs a sim per `/ws`
    connection* → per-connection forks the world, double-steps with two clients,
    and freezes with zero; one owner keeps a single authoritative world that
    keeps flying with no GCS attached, and `snapshot`-on-connect still bootstraps
    late joiners.
  - Attitude **derived** (`yaw = heading`, roll from turn rate) *vs integrated as
    state* → derivation is exact for a point mass, drift-free, and adds no state.
  - **Fixed `dt`** paced by wall-clock sleep *vs variable `dt` from measured
    deltas* → fixed `dt` keeps dynamics deterministic and Euler bounds valid; a
    stall under variable `dt` causes a large integration jump.
  - Vehicle limits as **clamps** *vs hardcoded motion* → the RQ-180 config *is*
    the physics; max bank sets the max turn rate via `ω = g·tan φ / V`.
- **Done when:** the aircraft still circles, but the circle now *emerges* from an
  integrated loiter law rather than a scripted path; the sim is a single shared
  stateful object; console clean; the frontend is untouched.
- **Commits:** `feat: vehicle characteristics (RQ-180 clamps)` ·
  `feat: stateful VehicleSim.step(dt)` · `feat: single-clock sim loop`

### Phase 7 — Command uplink (HSA + loiter/CAP)

- **Slice:** the app's **first uplink**. Add `command` (client→server) and
  `commandAck` (server→client) to the wire contract; make `/ws` **full-duplex**
  (concurrent sender + receiver tasks); `VehicleSim.apply(cmd)` flips mode +
  setpoints; implement the two guidance laws — **HSA** (rate-limited heading /
  speed / altitude capture) and **Loiter/CAP** (tangent-to-orbit heading fed into
  the *same* heading loop). Add a minimal cold-lane `CommandPanel` to send them.
- **Seed question (you draft first):** *Everything so far is downlink. What
  changes when you add an uplink on the **same** socket — how do you send and
  receive on one WebSocket at once? Why model commands as **setpoints the server
  tracks** (server-authoritative) rather than the client computing positions? And
  why is Loiter "just HSA with a heading that's recomputed every tick"?*
- **Key decisions → alternative rejected:**
  - Command on the **existing `/ws`** (full-duplex via `asyncio.gather`/`wait`)
    *vs a REST endpoint or a second socket* → a real datalink is one bidirectional
    link; keeps command + telemetry + ack correlated on one lifecycle.
  - **Typed discriminated-union command** (nullable = "leave unchanged", `cw/ccw`
    enum) *vs re-encoding MAVLink `COMMAND_LONG` (`param1..7` + `type_mask`)* →
    self-documenting and pydantic/TS-validated; you can still point at the MAVLink
    primitive each field distills (`type_mask` → nullable, sign-of-radius → enum).
  - **Server-authoritative setpoints** *vs client sends positions* → the client
    asks, the sim flies; avoids client/server state divergence.
  - **Loiter = tangent + reuse the HSA heading loop** *vs a separate orbit
    integrator / L1 vector field* → one guidance primitive, two features;
    pure-tangent holds the ring (start-on-ring), radius-capture is the noted
    one-term extension.
  - **Circular orbit** for CAP *vs a racetrack pattern* → the circle is the
    minimal faithful loiter; racetrack (two straights + two 180° turns) is named
    as the extension.
  - Ack = **`accepted | rejected` + reason** *vs the full `MAV_RESULT` enum* →
    covers feasible-vs-violates-a-limit; the enum is the trivial extension.
  - Send seam: **module-singleton socket + `sendCommand()`** called by a cold-lane
    panel *vs React Context / lifting the socket* → one link, one producer; keeps
    the rAF hot path untouched.
- **Done when:** send an HSA heading → the RQ-180 slews to it at its max turn rate
  and holds; change speed/altitude → it ramps within limits; click Loiter → it
  re-establishes a CAP orbit; an infeasible command (e.g. a radius below the min
  turn radius) returns `rejected` with a reason.
- **Commits:** `feat: command wire contract (command + commandAck)` ·
  `feat: full-duplex /ws (sender + receiver)` ·
  `feat: HSA + loiter guidance laws` · `feat: web command panel (first uplink)`

### Phase 8 — Dockerize the autonomy computer

- **Slice:** `apps/api/Dockerfile` (`python:3.12-slim`, non-root, `--reload`) and
  a root `docker-compose.yml` that runs the api (bind-mounted so `--reload` sees
  edits) with **web behind an opt-in profile** (host-run in dev for fast HMR).
  Package the "autonomy computer" as a reproducible service.
- **Seed question (you draft first):** *Why containerize the sim for a learning
  app — what does Docker actually buy you here? A real GCS and its flight
  controller are separate machines; should the autonomy computer be its **own
  container** talking to FastAPI over a bus, or an **asyncio task inside**
  FastAPI? Where is that "separation" already earned in the code?*
- **Key decisions → alternative rejected:**
  - **Single api container** (sim as an asyncio task in FastAPI) *vs a separate
    autonomy container bridged over ZeroMQ/Redis* → the separation is already
    earned at the `VehicleSim` class seam; a second container only adds an IPC bus
    that teaches message-bussing, not autonomy. Split when: multiple vehicles, a
    real SITL binary, or autonomy must survive an api restart.
  - **Web on the host in dev** (api-only container; web behind a `full-container`
    profile) *vs containerizing web too* → WSL2 bind-mount watching forces polling
    (laggy HMR); host web reaches the published `:8000` with no code change.
  - **Single-stage dev image** with bind mount + `--reload` *vs a multi-stage
    baked-in build* → multi-stage is the documented prod path; in dev it fights
    the reload loop.
- **Done when:** `docker compose up` serves `/health` and streams telemetry; host
  `npm run dev` connects and the RQ-180 flies + accepts commands exactly as
  before; editing `apps/api/*.py` hot-reloads inside the container.
- **Commits:** `chore: dockerfile for api (python 3.12-slim)` ·
  `chore: docker-compose (api + optional web profile)`
