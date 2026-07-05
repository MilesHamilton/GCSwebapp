# Architecture Notes

Explainer notes in **your own words** — two paragraphs per feature, written
*from memory* after you verify each phase (loop step 6). If you can't write it
without looking, you don't understand it well enough to defend it yet.

Suggested shape for each entry:
- **¶1 — What it does & how it fits:** the slice, where it sits in the
  api → ws → store → layer-factory → deck pipeline.
- **¶2 — Why it's built this way:** the key decision, the alternative you
  rejected, and the tradeoff. (Mirror the matching why-log line.)

---

## Phase 0 — Scaffold + learning rig

_(your words — optional for setup)_

## Phase 1 — Static map shell

We created a file MapView that contains aircraft positions and geozones for it, we render our static map using Mapbox GL JS. we are setting a synced state between the mapbox and deck.gl. ie. props get added to mapbox and propagate to deck.gl.

## Phase 2 — Track store + layer factory + fake driver

zustand store that tracks hot paths only (cold will be normal react state) (telemetry data). inngest function recieves the data and pushes to store TS buildLayer pulls from store (via rAF loop getState). 

get state is a single method that does a blind read of the store state. We build Layers buildLayers(not deck)

So: the rAF loop reads the store (getState) → we build layers → we push them via `setProps` → deck paints the canvas. deck's only job is the paint.

inngest workflow:   telemetry → ingest() → STORE → (rAF reads via getState) → buildLayers → overlay.setProps → deck canvas

The driver's (mocked WebSocket) `setInterval` (10 Hz) is the *producer*; the rAF loop (~60 fps) is the *consumer*. Neither waits on the other — slow data → rAF redraws the same latest state; fast data → rAF grabs the newest next frame. Producer/consumer decoupled by a shared buffer (the store).

## Phase 3 — WebSocket transport + telemetry contract

The backend sim is our source of truth (our stand-in vehicle controller). It streams telemetry over a WebSocket at 10 Hz. The client's `ws/` layer parses each message and validates/normalizes it at the boundary into our store shape (lng/lat/alt, heading, speed, mode…), then writes it to the Zustand hot-lane store. On the hot path **nothing subscribes** — `set()` notifies no one; the rAF loop (~60 fps) *polls* `getState()` each frame, rebuilds layers, and calls `overlay.setProps`, and deck diffs internally. The draw loop runs faster than the data (60 fps vs 10 Hz), so there are ~6 renders per sample: the renderer never blocks on the network and always paints the freshest sample within ~16 ms of arrival. Note that without interpolation the *visual* motion is still 10 Hz (each position drawn 6× before it jumps); true 60 fps smoothness would need interpolating between the last two samples, which we haven't built. When a client connects it first receives a `snapshot` (current vehicles + geozones), then the live telemetry stream keeps it up to date.

Why it's built this way: the wire is five typed messages (`telemetry` / `mission` / `event` / `snapshot` / `replay`) as a discriminated union on `type`, not one mutable blob — each type has its own rate and consumer, so the union keeps the client reducer a simple `switch` and lets the compiler narrow per case, whereas a single blob forces every consumer to defensively re-check fields and couples unrelated concerns. `snapshot`-on-connect solves the late-joiner problem: a stream of `telemetry` alone only tells you about an entity on its *next* tick, so a fresh client would see an empty/partial world until everything re-announces — the snapshot hands over the full current world immediately, then the stream keeps it live. We validate at the boundary (parse → typed) rather than trusting the wire, so a bad/partial message fails in one place instead of corrupting the store, and the client reconnects with backoff rather than dying, because a GCS has to survive a dropped link and re-sync from the next snapshot. The tradeoff is more message types + a validation layer up front, bought back as a client that reasons about one thing at a time and recovers cleanly.

## Phase 4 — Replay

_(your words)_

## Phase 5 — Operator HUD + camera sync

_(your words)_

---

## Milestone 2 — Fake flight autonomy computer

## Phase 6 — Stateful flight model (autonomy core)

**Seed question:** *Today position is a pure function of time (`telemetry_at(t)`). Why must the sim become stateful — integrating state forward — before it can accept commands? What can't you express as `f(t)` once the requirement is "turn toward heading X at no more than the airframe's max turn rate, then hold"? And why must there be exactly one sim instance stepped by one clock, not one per WebSocket connection?*

stateless vs stateful: stateful allows for a controller to predict future positions from past telemetry, while stateless requires recomputing from scratch each tick.

shared sim clock: the sim clock must be unified if two sims claiming one vehicle collide, they drift into different states. there is ambiguity on which sim is the one with command authority.

## Phase 7 — Command uplink (HSA + loiter/CAP)

**Seed question:** *Everything so far is downlink. What changes when you add an uplink on the same socket — how do you send and receive on one WebSocket at once? Why model commands as setpoints the server tracks (server-authoritative) rather than the client computing positions? And why is Loiter "just HSA with a heading that's recomputed every tick"?*

for the websocket to become bi-directional, you would need to have two concurrent coroutines over the same socket — one for receiving messages and one for sending messages.

Loiter is a giant series of HSA's that include a fixed center, HSA's (heading, speed, altitude) that dictates one direction 

## Phase 8 — Dockerize the autonomy computer

**Seed question:** *Why containerize the sim for a learning app — what does Docker actually buy you here? A real GCS and its flight controller are separate machines; should the autonomy computer be its own container talking to FastAPI over a bus, or an asyncio task inside FastAPI? Where is that "separation" already earned in the code?*

_(your words)_

---

## Milestone 4 — Multi-vehicle / distributed GCS

## Phase 10 — Multi-vehicle gateway (fan-in aggregator)

**Seed question:** *The client already keys telemetry, trails, and aircraft by vehicleId — so why isn't a second vehicle "free"? What has to exist on the backend for two separate containers' telemetry to reach one map, and for a command to reach the right vehicle? Why make each producer dial the gateway rather than the gateway dial each vehicle?*

A second vehicle isn't "free" because, although the client is already fleet-ready (the store keys everything by `vehicleId` and the layer factory renders a *list* of aircraft), there's nothing on the backend to carry two separate containers' telemetry onto one map, or to steer a command to the right plane. We add a **gateway** — a new FastAPI service that sits between the browser and the vehicles — and split the world into three roles: **producers** (each is a container running its own `VehicleSim` + step-loop, so N vehicles means N sims and N clocks — the `_sim_loop` moved *with* the sim out of the old `apps/api`), the **gateway** itself (a pure relay/router that owns no sim and no clock — only a registry mapping `vehicleId → that producer's connection`, plus the set of connected browsers), and the **client** (the browser, unchanged, still one `/ws` link → store → deck). Telemetry flows *up*: each self-clocked producer streams its state to the gateway, which fans it out to every browser tagged with its `vehicleId`, and the client's existing `ingest()` drops it into the right slot. A command flows *down*: `sendCommand(vehicleId)` → gateway → registry lookup → routed to the one producer that can `apply()` it → the change surfaces in that producer's next telemetry frame.

We chose this **gateway/fan-in (Option B)** over the two rejected alternatives: letting the client open *N* sockets (Option A — cheapest, but the client grows a connection manager and must know every endpoint, and it doesn't scale to a dynamic fleet), and a message broker like Redis/MQTT (Option C — the real scale answer, but overkill for a handful of vehicles; the gateway's fan-in is exactly where a broker would slot in later). Producers **dial** the gateway and self-register rather than the gateway dialing a config list, so fleet membership is dynamic and runtime-spawned sims (Phase 11) join the same way. The internal `/ingest` link is full-duplex just like today's `/ws` (concurrent sender + receiver): **up** it carries `register` (the one genuinely new frame — `vehicleId` + start pose, so the gateway can build its registry), `telemetry`, and `commandAck`; **down** it carries `command`. We reuse the existing `TelemetryMsg`/`CommandMsg` because they *already* carry `vehicleId`, so the only new type is `register` — the accepted tradeoff being that the internal contract is now coupled to the client-facing wire types (one source of truth). The key invariant shift from Phase 6: "exactly one sim, one clock" becomes "one sim + one clock *per producer*," and the gateway deliberately owns neither — it only remembers who's who.

## Phase 11 — Fleet control (per-vehicle command + runtime spawn)

**Seed question:** *With one global activeSocket and one lastAck, what breaks when a command could go to any of three vehicles? Why reuse the map's selectedId as the command target instead of a separate dropdown? And why is runtime "add a vehicle" a new sim process that registers rather than a new Docker container — what would the container path cost?*

**Seed question (operator fleet selector + broadcast):** *You already select a vehicle by clicking it on the map (selectedVehicleId, cold lane). Why add a panel selector too — and should "select all" send one command the gateway fans out, or N commands from the client? What does each cost, and which keeps the client a thin producer?*

_(your words)_
