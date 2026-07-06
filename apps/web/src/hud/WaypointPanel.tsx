import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useMissionStore } from '../state/missionStore'
import { useUiStore } from '../state/uiStore'
import { useTrackStore } from '../state/trackStore'
import { sendCommand } from '../ws/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Cold-lane editor for operator-placed 3D waypoint routes, one per vehicle. Toggle Edit,
// click inside a geozone to drop waypoints on the selected vehicle, tune each altitude,
// then Send. Broadcast ("All") sends/clears the same path across the whole fleet. Clearing
// stops the vehicle flying its route and drops it into a loiter in place.
export default function WaypointPanel() {
  const editing = useMissionStore((s) => s.editing)
  const paths = useMissionStore((s) => s.paths)
  const warning = useMissionStore((s) => s.warning)
  const selectedId = useUiStore((s) => s.selectedVehicleId)
  // Live roster (id list), for the broadcast target. Shallow-compared so this doesn't
  // re-render on the 10 Hz telemetry tick, only when a vehicle joins/leaves.
  const vehicleIds = useTrackStore(useShallow((s) => Object.keys(s.vehicles).sort()))
  const [broadcast, setBroadcast] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // The path being edited/shown belongs to the selected vehicle (default uav-01).
  const targetKey = selectedId ?? 'uav-01'
  const waypoints = paths[targetKey] ?? []
  // Broadcast targets the whole roster; fall back to the single target if none reported yet.
  const targetIds = vehicleIds.length > 0 ? vehicleIds : [targetKey]

  // Auto-clear the transient warning; keyed on nonce so a repeated message re-fires it.
  const [warnText, setWarnText] = useState<string | null>(null)
  useEffect(() => {
    if (!warning) return
    setWarnText(warning.text)
    const t = setTimeout(() => setWarnText(null), 2500)
    return () => clearTimeout(t)
  }, [warning])

  const missionCmd = (wps: typeof waypoints) => ({
    kind: 'mission' as const,
    waypoints: wps.map((w) => ({ lng: w.lng, lat: w.lat, altM: w.altM })),
  })

  const send = () => {
    const mission = useMissionStore.getState()
    if (broadcast) {
      mission.setPathForAll(targetIds, waypoints) // every vehicle keeps its own copy
      mission.markActive(targetIds, true)
      sendCommand(missionCmd(waypoints), '*')
    } else {
      mission.markActive([targetKey], true)
      sendCommand(missionCmd(waypoints), selectedId ?? undefined)
    }
  }

  const clear = () => {
    const mission = useMissionStore.getState()
    const active = mission.active
    if (broadcast) {
      const anyActive = targetIds.some((id) => active[id])
      mission.clearPaths(targetIds)
      // Only interrupt vehicles that were actually flying a route; loiter them in place.
      if (anyActive) sendCommand({ kind: 'loiter' }, '*')
    } else {
      const wasActive = active[targetKey]
      mission.clearPaths([targetKey])
      if (wasActive) sendCommand({ kind: 'loiter' }, selectedId ?? undefined)
    }
  }

  return (
    <Card className="absolute bottom-3 left-3 z-10 w-64 gap-3 py-3">
      <CardHeader className="px-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle className="text-sm">Waypoint Path → {broadcast ? 'ALL' : targetKey}</CardTitle>
          <span className="text-muted-foreground text-xs">{collapsed ? '▸' : '▾'}</span>
        </button>
      </CardHeader>
      {!collapsed && (
      <CardContent className="gap-3 px-3">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={editing ? 'default' : 'outline'}
            onClick={() => useMissionStore.getState().setEditing(!editing)}
          >
            {editing ? '● Placing' : 'Edit'}
          </Button>
          <Button size="sm" variant="outline" disabled={waypoints.length === 0} onClick={clear}>
            Clear
          </Button>
          <Button size="sm" className="ml-auto" disabled={waypoints.length < 2} onClick={send}>
            Send
          </Button>
        </div>

        {vehicleIds.length > 1 && (
          <Button size="sm" variant={broadcast ? 'default' : 'outline'} onClick={() => setBroadcast(!broadcast)}>
            {broadcast ? 'All vehicles ✓' : 'Apply to all'}
          </Button>
        )}

        {editing && (
          <Label className="text-muted-foreground text-xs">Click inside a geozone to add a waypoint to {targetKey}.</Label>
        )}

        {waypoints.length === 0 ? (
          <span className="text-muted-foreground text-xs">No waypoints for {targetKey}.</span>
        ) : (
          <div className="flex flex-col gap-1">
            {waypoints.map((w, i) => (
              <div key={i} className="flex items-center gap-1">
                <Badge variant="secondary" className="w-5 justify-center tabular-nums">
                  {i + 1}
                </Badge>
                <Input
                  type="number"
                  className="h-7 w-20"
                  value={w.altM}
                  onChange={(e) => useMissionStore.getState().updateAlt(targetKey, i, Number(e.target.value))}
                />
                <span className="text-muted-foreground text-[10px]">m</span>
                <div className="ml-auto flex gap-0.5">
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={i === 0} onClick={() => useMissionStore.getState().moveWaypoint(targetKey, i, -1)}>
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={i === waypoints.length - 1} onClick={() => useMissionStore.getState().moveWaypoint(targetKey, i, 1)}>
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => useMissionStore.getState().removeWaypoint(targetKey, i)}>
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {warnText && (
          <Badge variant="destructive" className="w-full justify-start whitespace-normal">
            {warnText}
          </Badge>
        )}
      </CardContent>
      )}
    </Card>
  )
}
