import { useTrackStore, type TelemetrySample } from '../state/trackStore'
import type { ServerMessage, VehicleState } from './types'

const WS_URL = 'ws://localhost:8000/ws'
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 5000

// Normalize rich wire vehicle state -> the lean store sample (wire shape != store shape).
function toSample(v: VehicleState, ts: number): TelemetrySample {
  return {
    vehicleId: v.vehicleId,
    position: [v.position.lng, v.position.lat],
    headingDeg: v.attitude.yawDeg,
    ts,
  }
}

function handle(msg: ServerMessage): void {
  const store = useTrackStore.getState()
  switch (msg.type) {
    case 'telemetry':
      store.ingest(toSample(msg, msg.ts))
      break
    case 'snapshot':
      // late-joiner bootstrap: cold mission data + current vehicle positions
      store.setGeozones(msg.geozones)
      msg.vehicles.forEach((v) => store.ingest(toSample(v, msg.ts)))
      break
    // mission -> cold lane (Phase 5), event -> alerts, replay -> Phase 4
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
