import { useTrackStore } from './trackStore'

// Phase 2 stand-in for real telemetry: flies uav-01 in a circle around CENTER at
// ~10 Hz by pushing samples into the track store. Returns a stop function.
// Phase 3 replaces this with a WebSocket feed calling the same ingest().

const CENTER: [number, number] = [-77.0365, 38.8977]
const RADIUS_DEG = 0.02 // ~2.2 km
const PERIOD_MS = 20000 // one lap
const TICK_MS = 100 // 10 Hz

export function startFakeDriver(vehicleId = 'uav-01'): () => void {
  const t0 = Date.now()
  const ingest = useTrackStore.getState().ingest
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    const now = Date.now()
    const thetaDeg = (((now - t0) / PERIOD_MS) * 360) % 360
    const theta = (thetaDeg * Math.PI) / 180
    // cos(lat) keeps the circle round despite mercator longitude compression.
    const lng = CENTER[0] + (RADIUS_DEG * Math.cos(theta)) / Math.cos((CENTER[1] * Math.PI) / 180)
    const lat = CENTER[1] + RADIUS_DEG * Math.sin(theta)
    // Heading = compass bearing of the tangent (motion is CCW, so heading = -theta).
    const headingDeg = (360 - thetaDeg) % 360
    ingest({ vehicleId, position: [lng, lat], headingDeg, ts: now })
  }, TICK_MS)
  return () => clearInterval(timer)
}
