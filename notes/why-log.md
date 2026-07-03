# Why Log

One line per nontrivial decision. Add a row when we lock a decision (loop step 6).

| Date | Decision | Rationale | Alternative rejected | Revisit trigger |
|------|----------|-----------|----------------------|-----------------|
| 2026-07-03 | Basemap = **Mapbox GL JS** | Canonical `MapboxOverlay` story recognizable in GIS interviews; nicer default styles | **MapLibre GL JS** (free, no token) | Token/billing friction, or making the portfolio repo fully OSS/clone-and-run |
| 2026-07-03 | Frontend = **Vite + React + TS** | Fast dev server, standard portfolio stack | CRA (deprecated); Next.js (SSR overkill for a client-side map) | Need SSR, routing, or an API layer colocated with the web app |
| 2026-07-03 | Backend = **FastAPI + uvicorn** | First-class WebSocket + pydantic validation, minimal boilerplate | Flask/Socket.IO; raw `websockets` | Need horizontal scale → add Redis pub/sub |
| 2026-07-03 | Repo = **plain `apps/api` + `apps/web`**, one git repo | Two runtimes don't share a package manager; workspace tooling is overhead | pnpm workspaces / turborepo | Add a shared TS package or a third app |
| 2026-07-03 | deck.gl attach = **`MapboxOverlay` under `react-map-gl`** | Keeps layer updates off React's render cycle for the telemetry hot path | `<DeckGL>` React component (re-renders on every change) | Perf is a non-issue and we want simpler declarative code |
| 2026-07-03 | deck compositing = **overlaid** (`interleaved:false`) | v1 doesn't need deck objects interleaved with map labels/3D | interleaved | want geozones beneath labels or 3D-building occlusion |
| 2026-07-03 | Vehicle marker = **RQ-180 `SimpleMeshLayer`** (2D icon abandoned) | mesh renders reliably; `IconLayer` came up blank (SVG + canvas-PNG both; suspect `billboard:false`) | 2D `IconLayer` | fix the icon, or move to `ScenegraphLayer` |
| 2026-07-03 | 3D mesh zoom-flip **left unresolved (pinned)** | deck #5147: mesh flips orientation at high zoom via MapboxOverlay; not worth blocking v1 | keep debugging / swap layer now | **`ScenegraphLayer` + glTF** in v2 |
| 2026-07-03 | Hot-lane store = **Zustand** | external store read imperatively via `getState()` off React's render cycle; selectors for cold UI | React Context (re-renders all consumers); Redux (boilerplate) | — |
| 2026-07-03 | Live trail = **`PathLayer`** | simplest layer that shows the breadcrumb; store already keeps timestamped points so the data is replay-ready regardless | `TripsLayer` now | Phase 4 replay → swap to `TripsLayer` (one-line factory change) |
| 2026-07-03 | Hot path = **imperative rAF loop + `overlay.setProps`** (read store via `getState`) | pushes telemetry to deck off React entirely; decouples 10 Hz data from ~60 fps draw through the shared store | declarative: subscribe to the store and re-render React each tick | low-rate/simple updates where a React subscription is fine |
