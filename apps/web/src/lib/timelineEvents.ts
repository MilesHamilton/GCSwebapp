import type { TimedPoint, Geozone } from '../state/trackStore'
import type { Waypoint } from '../state/missionStore'
import type { TimelineEvent } from '@/components/ui/timeline'
import { pointInAnyGeozone } from './geo'

// Mirror the sim's waypoint capture radius (sim.py WP_CAPTURE_M) so replay markers land
// where the vehicle actually advanced to the next waypoint.
const WP_CAPTURE_M = 150
const M_PER_DEG_LAT = 111320

// Ground distance (m) between two [lng, lat] points (equirectangular; fine at this scale).
function metersBetween(a: [number, number], b: [number, number]): number {
  const north = (b[1] - a[1]) * M_PER_DEG_LAT
  const east = (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot(north, east)
}

// Derive replay markers from a finished recording: the two endpoints, a breach/return marker
// each time a vehicle's track crosses a geozone boundary, and a "reached waypoint #N" marker
// each time it captures the next waypoint on its mission route (looping, as the sim does).
export function computeTimelineEvents(
  recording: Record<string, TimedPoint[]>,
  geozones: Geozone[],
  paths: Record<string, Waypoint[]>,
  bounds: [number, number] | null,
): TimelineEvent[] {
  if (!bounds) return []
  const events: TimelineEvent[] = [
    { t: bounds[0], kind: 'start', label: 'Recording start' },
    { t: bounds[1], kind: 'end', label: 'Recording end' },
  ]
  for (const [id, pts] of Object.entries(recording)) {
    // Geozone breach / return crossings.
    if (geozones.length > 0) {
      let prevInside: boolean | null = null
      for (const p of pts) {
        const inside = pointInAnyGeozone(p.coordinates, geozones)
        if (prevInside !== null && inside !== prevInside) {
          events.push({
            t: p.timestamp,
            kind: inside ? 'return' : 'breach',
            label: inside ? `${id} re-entered zone` : `${id} left geozone`,
          })
        }
        prevInside = inside
      }
    }
    // Waypoint captures: walk the track advancing through this vehicle's route in order.
    const wps = paths[id]
    if (wps && wps.length > 0) {
      let wpIndex = 0
      for (const p of pts) {
        const tgt = wps[wpIndex]
        if (metersBetween(p.coordinates, [tgt.lng, tgt.lat]) < WP_CAPTURE_M) {
          events.push({ t: p.timestamp, kind: 'waypoint', label: `${id} reached waypoint #${wpIndex + 1}` })
          if (wps.length < 2) break // single-waypoint route: mark once, don't loop forever
          wpIndex = (wpIndex + 1) % wps.length
        }
      }
    }
  }
  return events.sort((a, b) => a.t - b.t)
}
