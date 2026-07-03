import { useTrackStore, type TelemetrySample } from '../state/trackStore'
import type { ServerMessage, TelemetryMsg } from './types'

const WS_URL = 'ws://localhost:8000/ws'
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 5000

// Normalize the rich wire telemetry -> the lean store sample (wire shape != store shape).
function toSample(m: TelemetryMsg): TelemetrySample {
  return {
    vehicleId: m.vehicleId,
    position: [m.position.lng, m.position.lat],
    headingDeg: m.attitude.yawDeg,
    ts: m.ts,
  }
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'telemetry':
      useTrackStore.getState().ingest(toSample(msg))
      break
    // mission -> cold lane (Phase 5), event -> alerts, snapshot -> commit 4, replay -> Phase 4
    default:
      break
  }
}

// Connects to the telemetry socket and feeds the track store. Reconnects with
// exponential backoff. Returns a stop function. Note: only the *producer* — the
// store, layer factory, and rAF render loop are unchanged from the fake driver.
export function startWsClient(url = WS_URL): () => void {
  let socket: WebSocket | null = null
  let backoff = BACKOFF_MIN_MS
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const connect = () => {
    socket = new WebSocket(url)

    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS
      console.info('[ws] connected', url)
    }

    socket.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data as string) as ServerMessage)
      } catch {
        console.warn('[ws] bad message', ev.data)
      }
    }

    socket.onclose = () => {
      if (stopped) return
      console.warn(`[ws] disconnected; retrying in ${backoff}ms`)
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }

    socket.onerror = () => socket?.close() // -> onclose -> backoff
  }

  connect()

  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
    socket?.close()
  }
}
