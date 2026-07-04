# Phase 4 Handoff — Replay

_Last updated: 2026-07-04 · Tip: `d3aa622` (Phase 3 complete)_

## Status

Phases 0–3 are done. The app is a working end-to-end event-driven GCS:

```
FastAPI sim (10 Hz) → WebSocket /ws → client parse/normalize → Zustand store
      → rAF loop reads getState() → buildLayers() → deck.gl (overlaid on Mapbox)
```

- **Backend** streams telemetry over `/ws` and sends a `snapshot` (current vehicle + geozones) on connect.
- **Frontend** keeps telemetry in a Zustand *hot-lane* store and redraws deck layers from an rAF loop — **off React's render cycle** (nothing subscribes; the loop polls `getState()`).
- One aircraft (`uav-01`) flies a circle; a cyan trail follows; a red geozone is drawn from the snapshot.

### Run it
```bash
apps/api/.venv/bin/uvicorn main:app --app-dir apps/api --reload   # terminal 1
npm --prefix apps/web run dev                                     # terminal 2  (needs apps/web/.env: VITE_MAPBOX_TOKEN=...)
```

## Pinned known issue

The RQ-180 **`SimpleMeshLayer` flips orientation at high zoom** via MapboxOverlay (deck #5147) — visible but upside-down/SW zoomed in, correct zoomed out. Accepted for v1. Fix path = `ScenegraphLayer` + glTF. Do **not** re-chase it in Phase 4.

## Phase 4 goal

Replay: **record** the telemetry stream, add a **playback clock** you can scrub, drive the trail with **`TripsLayer` + `currentTime`**, and expose a **scrubber UI**. Done when: record a flight → switch to replay → scrub the timeline → aircraft + trail animate to the cursor.

## Start here — seed question (you draft, then I critique)

> **Why is the live trail data already replay-ready?** (Look at `trails: Record<id, TimedPoint[]>` in the store — `{ coordinates, timestamp }`.) And **what does a playback clock own that live mode never needed** — what changes when time becomes something you *scrub* instead of something that only moves forward?

## Commit plan (one concern each)

1. **Recorder** — capture telemetry into an **uncapped** per-vehicle buffer (the live trail is capped at 500; recording needs full history). Start/stop.
2. **Playback clock + mode + TripsLayer swap** — cold-lane state `{ mode: 'live' | 'replay', currentTime, playing }`; a clock that advances `currentTime` while playing; `buildLayers` renders from the **recording @ currentTime** in replay mode. **Swap the trail `PathLayer` → `TripsLayer`** (the deferral from Phase 2) — it maps 1:1 onto `TimedPoint`: `getPath = pts.map(p=>p.coordinates)`, `getTimestamps = pts.map(p=>p.timestamp)`, plus `currentTime`.
3. **Scrubber UI** — timeline slider (min/max = recording start/end ts) bound to `currentTime`, play/pause, record/stop, live↔replay toggle. This is the **first real cold-lane React UI** (human-speed interaction state — normal `useState`/store selectors are fine here).

## Decisions Phase 4 will surface (draft an opinion + the alternative)

- **Recording location** — client buffer *(simplest)* vs server-side recording file.
- **Recording shape** — reuse `TimedPoint[]` *(why the data's replay-ready)* vs a new format.
- **Where the recorder taps in** — the WS client records raw samples, vs `ingest` appends to a recording buffer when `isRecording`.
- **Playback-clock home** — **cold lane** (React state; it changes on scrub/play, human speed) vs the hot store.
- **Trail layer** — `PathLayer` → **`TripsLayer`** (currentTime-driven). This is the logged Phase 2 revisit trigger.
- **Live↔replay switch** — how `buildLayers` chooses its data source (live store vs recording snapshot at `currentTime`).

## Key files

| File | Role |
|------|------|
| `apps/web/src/state/trackStore.ts` | Zustand hot lane: `vehicles`, `trails` (`TimedPoint[]`, capped 500), `geozones`; `ingest`, `setGeozones`, `clear` |
| `apps/web/src/map/layers.ts` | `buildLayers(WorldSnapshot)` → `[geozone PolygonLayer, PathLayer trail, RQ-180 SimpleMeshLayer]` |
| `apps/web/src/map/MapView.tsx` | `<Map>` + `DeckLayers` (useControl overlay + rAF loop + `startWsClient`) |
| `apps/web/src/ws/client.ts` | parse → `switch(type)` → normalize → `ingest`; `snapshot` → `setGeozones`; backoff reconnect |
| `apps/web/src/ws/types.ts` | TS mirror of the wire contract |
| `apps/api/schemas.py` | pydantic wire contract (5 message types incl. `replay`, already stubbed) |
| `apps/api/sim.py` | `telemetry_at`, `snapshot_at`, `GEOZONES` |
| `apps/api/main.py` | `/health`, `/ws` (snapshot-on-connect + 10 Hz stream) |

## Gotchas

- **Trail cap (500)** is for the *live* trail; the recorder needs a separate uncapped buffer or full history.
- **`TripsLayer` needs `currentTime`** fed every frame (from the playback clock in replay, or "now" in live). It reveals the path up to `currentTime` within `trailLength`.
- **Playback state is cold-lane** — it may use React state / store selectors and re-render UI; that's fine (human speed). Keep the *telemetry* hot path untouched.
- The `replay` message type already exists in `schemas.py`/`types.ts` if you want server-driven playback chunks later; Phase 4 can stay client-side.

## How we work (session protocol)

Per feature: **you draft → I critique → you approve → I implement → you verify → you explain from memory.** Plan before edit. **One concern per commit.** Every nontrivial decision gets a logged alternative in `notes/why-log.md`; every feature gets a 2-paragraph note in `notes/architecture.md`.

## Outstanding from Phase 3 (not blocking)

- `notes/architecture.md` → Phase 3 note (two paragraphs).
- `notes/why-log.md` — 3 Phase 3 decisions still unlogged: simple per-connection loop vs connection manager · type-assert vs zod validation · geozone-via-snapshot vs client-static.
- **Concept to lock:** on the hot path **nothing subscribes to the store** — `set()` notifies no one; the rAF loop *polls* `getState()`. (This was the recurring review gap.)
