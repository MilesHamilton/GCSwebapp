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

_(your words)_

## Phase 4 — Replay

_(your words)_

## Phase 5 — Operator HUD + camera sync

_(your words)_
