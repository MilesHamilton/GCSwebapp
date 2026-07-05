// Control-plane calls to the sim-host (Phase 11 runtime spawn/despawn). This is separate
// from the /ws telemetry datalink: the sim-host is its own service on its own host port
// with a plain HTTP API. Spawn/despawn effects reach the map via the normal telemetry +
// roster (vehicleLeft) path, so there's nothing to update here beyond firing the request.
const SIMHOST_URL = (import.meta.env.VITE_SIMHOST_URL as string | undefined) ?? 'http://localhost:8001'

export async function spawnVehicle(): Promise<string | null> {
  try {
    const res = await fetch(`${SIMHOST_URL}/vehicles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}', // let the sim-host assign the id + a distinct pose
    })
    if (!res.ok) {
      console.warn('[simhost] spawn failed', res.status)
      return null
    }
    return ((await res.json()) as { vehicleId: string }).vehicleId
  } catch (e) {
    console.warn('[simhost] spawn error', e)
    return null
  }
}

export async function despawnVehicle(id: string): Promise<boolean> {
  try {
    // 404 = not a sim-host-managed vehicle (e.g. a compose-defined uav-01); harmless no-op.
    const res = await fetch(`${SIMHOST_URL}/vehicles/${id}`, { method: 'DELETE' })
    return res.ok
  } catch (e) {
    console.warn('[simhost] despawn error', e)
    return false
  }
}
