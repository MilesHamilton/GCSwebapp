import { useTrackStore, type TelemetrySample } from '../state/trackStore'
import { useCommandStore } from '../state/commandStore'
import { useUiStore } from '../state/uiStore'
import type { Command, CommandMsg, ServerMessage, VehicleState } from './types'

// Deployed builds inject the gateway's public host (VITE_GATEWAY_HOST, wired to the
// Render gateway service in render.yaml) and we speak wss://; dev falls back to the
// local containerized gateway. A full VITE_WS_URL wins if set. Vite bakes import.meta.env
// at BUILD time, so these must be present as build args when the prod image is built.
const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ||
  (import.meta.env.VITE_GATEWAY_HOST
    ? `wss://${import.meta.env.VITE_GATEWAY_HOST}/ws`
    : 'ws://localhost:8000/ws')
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 5000

// The single live socket, exposed to the command sender. There's one datalink, so a
// module singleton mirrors that — no Context/provider needed for one producer.
let activeSocket: WebSocket | null = null

// Normalize rich wire vehicle state -> the lean store sample (wire shape != store shape).
function toSample(v: VehicleState, ts: number): TelemetrySample {
  return {
    vehicleId: v.vehicleId,
    position: [v.position.lng, v.position.lat],
    headingDeg: v.attitude.yawDeg,
    ts,
    altM: v.position.altM ?? 0,
    speedMps: v.velocity?.groundSpeedMps ?? 0,
    mode: v.status?.mode ?? '',
    batteryPct: v.status?.batteryPct ?? 0,
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
    case 'commandAck':
      useCommandStore.getState().setAck(msg)
      break
    case 'vehicleLeft':
      // Roster departure: drop the vehicle; clear selection/follow + its hidden flag.
      store.removeVehicle(msg.vehicleId)
      useUiStore.getState().clearVehicleHidden(msg.vehicleId)
      if (useUiStore.getState().selectedVehicleId === msg.vehicleId) useUiStore.getState().setSelected(null)
      break
    // mission -> cold lane (Phase 5), event -> alerts, replay -> Phase 4
    default:
      break
  }
}

// Send an uplink command to a specific vehicle. No-op (with a warn) if the socket isn't
// open. The gateway routes by vehicleId (Phase 11); "*" broadcasts to the whole fleet.
// An omitted vehicleId falls to the server default ("uav-01"). The reply is a commandAck.
export function sendCommand(command: Command, vehicleId?: string): void {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    console.warn('[ws] cannot send command; socket not open')
    return
  }
  const msg: CommandMsg = { type: 'command', ts: Date.now(), commandId: crypto.randomUUID(), command }
  if (vehicleId) msg.vehicleId = vehicleId
  activeSocket.send(JSON.stringify(msg))
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
      activeSocket = socket
      useUiStore.getState().setConnected(true)
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
      if (socket === activeSocket) activeSocket = null
      useUiStore.getState().setConnected(false)
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
