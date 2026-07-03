# Why Log

One line per nontrivial decision. Add a row when we lock a decision (loop step 6).

| Date | Decision | Rationale | Alternative rejected | Revisit trigger |
|------|----------|-----------|----------------------|-----------------|
| 2026-07-03 | Basemap = **Mapbox GL JS** | Canonical `MapboxOverlay` story recognizable in GIS interviews; nicer default styles | **MapLibre GL JS** (free, no token) | Token/billing friction, or making the portfolio repo fully OSS/clone-and-run |
| 2026-07-03 | Frontend = **Vite + React + TS** | Fast dev server, standard portfolio stack | CRA (deprecated); Next.js (SSR overkill for a client-side map) | Need SSR, routing, or an API layer colocated with the web app |
| 2026-07-03 | Backend = **FastAPI + uvicorn** | First-class WebSocket + pydantic validation, minimal boilerplate | Flask/Socket.IO; raw `websockets` | Need horizontal scale → add Redis pub/sub |
| 2026-07-03 | Repo = **plain `apps/api` + `apps/web`**, one git repo | Two runtimes don't share a package manager; workspace tooling is overhead | pnpm workspaces / turborepo | Add a shared TS package or a third app |
| 2026-07-03 | deck.gl attach = **`MapboxOverlay` under `react-map-gl`** | Keeps layer updates off React's render cycle for the telemetry hot path | `<DeckGL>` React component (re-renders on every change) | Perf is a non-issue and we want simpler declarative code |
