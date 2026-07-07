import type { Geozone } from '../state/trackStore'

const M_PER_DEG_LAT = 111_320

// Ground distance (m) between two [lng, lat] points (equirectangular; fine at this scale).
export function metersBetween(a: [number, number], b: [number, number]): number {
  const north = (b[1] - a[1]) * M_PER_DEG_LAT
  const east = (b[0] - a[0]) * M_PER_DEG_LAT * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot(north, east)
}

// Ray-casting point-in-polygon. Point and polygon vertices are both [lng, lat] (deck order).
export function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// True if the point falls inside any geozone polygon.
export function pointInAnyGeozone(point: [number, number], geozones: Geozone[]): boolean {
  return geozones.some((z) => pointInPolygon(point, z.polygon))
}
