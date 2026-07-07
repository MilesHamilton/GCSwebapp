import { useEffect, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sendCommand } from '../ws/client'
import { useCommandStore } from '../state/commandStore'
import { useUiStore } from '../state/uiStore'
import { useTrackStore } from '../state/trackStore'
import { useMissionStore, type Waypoint } from '../state/missionStore'
import { metersBetween } from '../lib/geo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// The app's first cold-lane UI: an operator command panel, on shadcn/ui. Interaction is
// human-speed, so ordinary React state + re-renders are fine here, OFF the telemetry hot path.

// Muted one-line field description under an input.
function Help({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground text-[10px] leading-tight">{children}</span>
}

type CommandType = 'hsa' | 'orbit' | 'waypoint'

// A stable fallback reference: `s.paths[targetKey] ?? []` would otherwise return a NEW
// array every selector call whenever the vehicle has no path yet, and zustand's
// useSyncExternalStore compares snapshots by reference — a fresh array each render looks
// like a change every time, forcing an infinite re-render loop.
const EMPTY_WAYPOINTS: Waypoint[] = []

export default function CommandPanel() {
  const [cmdType, setCmdType] = useState<CommandType>('hsa')
  const [heading, setHeading] = useState('')
  const [speed, setSpeed] = useState('')
  const [altitude, setAltitude] = useState('')
  // Loiter and racetrack are the two orbit patterns; `pattern` picks which fields show.
  const [pattern, setPattern] = useState<'loiter' | 'racetrack'>('loiter')
  const [radius, setRadius] = useState('2226')
  const [direction, setDirection] = useState<'cw' | 'ccw'>('ccw')
  const [semiMajor, setSemiMajor] = useState('3000')
  const [semiMinor, setSemiMinor] = useState('600')
  const [bearing, setBearing] = useState('')
  // Commands target the SELECTED vehicle (map click or the panel selector). No selection
  // -> omit vehicleId so the server default ('uav-01') still works. The ack is read for
  // that same vehicle, so a fleet's acks don't clobber each other.
  const [broadcast, setBroadcast] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const selectedId = useUiStore((s) => s.selectedVehicleId)
  // Broadcast ("All") sends one command with vehicleId "*"; the gateway fans it to every
  // producer (each acks with its own id). Otherwise target the selected vehicle.
  const target = broadcast ? '*' : (selectedId ?? undefined)
  const lastAck = useCommandStore((s) => (selectedId ? s.acks[selectedId] : undefined))
  // Live roster for the selector. Shallow-compare the id LIST so this re-renders only when
  // a vehicle joins/leaves, not on every 10 Hz telemetry tick (keeps the hot path off React).
  const vehicleIds = useTrackStore(useShallow((s) => Object.keys(s.vehicles).sort()))

  // Waypoint editor state: the path belongs to the selected vehicle (default uav-01).
  const targetKey = selectedId ?? 'uav-01'
  const editing = useMissionStore((s) => s.editing)
  const waypoints = useMissionStore((s) => s.paths[targetKey] ?? EMPTY_WAYPOINTS)
  const revision = useMissionStore((s) => s.revision)
  const warning = useMissionStore((s) => s.warning)
  // Broadcast targets the whole roster; fall back to the single target if none reported yet.
  const targetIds = vehicleIds.length > 0 ? vehicleIds : [targetKey]

  // Stepping away from Waypoint mode with map-click placement still armed would leave a
  // stray, invisible "click to place" trap on the map with no way to see or turn it off.
  useEffect(() => {
    if (cmdType !== 'waypoint' && useMissionStore.getState().editing) {
      useMissionStore.getState().setEditing(false)
    }
  }, [cmdType])

  // Auto-clear the transient waypoint warning; keyed on nonce so a repeated message re-fires it.
  const [warnText, setWarnText] = useState<string | null>(null)
  useEffect(() => {
    if (!warning) return
    setWarnText(warning.text)
    const t = setTimeout(() => setWarnText(null), 2500)
    return () => clearTimeout(t)
  }, [warning])

  // Empty OR non-numeric -> undefined, so a blank/typo cleanly means "leave unchanged"
  // (rather than sending NaN, which JSON turns into a silent null).
  const num = (s: string): number | undefined => {
    if (s.trim() === '') return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }

  const sendHsa = () =>
    sendCommand({ kind: 'hsa', headingDeg: num(heading), speedMps: num(speed), altM: num(altitude) }, target)
  // One orbit sender: dispatch on the selected pattern (loiter vs racetrack).
  const sendOrbit = () =>
    pattern === 'loiter'
      ? sendCommand({ kind: 'loiter', radiusM: num(radius), direction }, target)
      : sendCommand(
          {
            kind: 'racetrack',
            semiMajorM: num(semiMajor) ?? 0,
            semiMinorM: num(semiMinor) ?? 0,
            bearingDeg: num(bearing),
            direction,
          },
          target,
        )

  const missionCmd = (wps: typeof waypoints) => ({
    kind: 'mission' as const,
    waypoints: wps.map((w) => ({ lng: w.lng, lat: w.lat, altM: w.altM })),
  })

  const sendWaypoints = () => {
    const mission = useMissionStore.getState()
    if (broadcast) {
      mission.setPathForAll(targetIds, waypoints) // every vehicle keeps its own copy
      mission.markActive(targetIds, true)
      mission.markSent(targetIds, waypoints) // survives a later Clear, for replay markers
      sendCommand(missionCmd(waypoints), '*')
    } else {
      mission.markActive([targetKey], true)
      mission.markSent([targetKey], waypoints)
      sendCommand(missionCmd(waypoints), selectedId ?? undefined)
    }
  }

  const clearWaypoints = () => {
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

  // Commit a waypoint's altitude on blur, not on every keystroke: the field is UNCONTROLLED
  // (defaultValue, not value) so the browser owns the text while typing. A controlled input
  // bound straight to a number can't represent "the box is empty" — clearing it to retype
  // snaps back to 0 mid-edit and swallows keystrokes. Committing on blur, and only when the
  // text parses to a finite number, avoids that and stops a bad edit from ever reaching deck.
  const commitAlt = (index: number) => (e: React.FocusEvent<HTMLInputElement>) => {
    const n = Number(e.target.value)
    if (Number.isFinite(n)) {
      useMissionStore.getState().updateAlt(targetKey, index, n)
    } else {
      e.target.value = String(waypoints[index]?.altM ?? '') // snap back to last-known-good
    }
  }

  return (
    <Card className="absolute top-3 left-3 z-10 w-56 gap-3 py-3">
      <CardHeader className="px-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle className="text-sm">Command → {broadcast ? 'ALL' : (selectedId ?? 'uav-01 (default)')}</CardTitle>
          <span className="text-muted-foreground text-xs">{collapsed ? '▸' : '▾'}</span>
        </button>
      </CardHeader>
      <CardContent className="gap-4 px-3">
        <div className="flex flex-col gap-1">
          <Label className="text-muted-foreground text-xs">Vehicles: pick a target</Label>
          <div className="flex flex-wrap gap-1">
            {vehicleIds.length === 0 && <span className="text-muted-foreground text-xs">none connected</span>}
            {vehicleIds.map((id) => (
              <Button
                key={id}
                size="sm"
                variant={!broadcast && selectedId === id ? 'default' : 'outline'}
                onClick={() => {
                  setBroadcast(false)
                  useUiStore.getState().setSelected(id)
                }}
              >
                {id}
              </Button>
            ))}
            {vehicleIds.length > 1 && (
              <Button size="sm" variant={broadcast ? 'default' : 'outline'} onClick={() => setBroadcast(true)}>
                All
              </Button>
            )}
          </div>
        </div>

        {!collapsed && (
        <>
        <div className="flex flex-col gap-1">
          <Label className="text-muted-foreground text-xs">Command type</Label>
          <select
            value={cmdType}
            onChange={(e) => setCmdType(e.target.value as CommandType)}
            className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px]"
          >
            <option value="hsa" className="bg-background text-foreground">HSA (heading / speed / alt)</option>
            <option value="orbit" className="bg-background text-foreground">Loiter / Racetrack</option>
            <option value="waypoint" className="bg-background text-foreground">Waypoint path</option>
          </select>
        </div>

        {cmdType === 'hsa' && (
        <div className="flex flex-col gap-2">
          <Input type="number" placeholder="heading °" value={heading} onChange={(e) => setHeading(e.target.value)} />
          <Input type="number" placeholder="speed m/s (30–60)" value={speed} onChange={(e) => setSpeed(e.target.value)} />
          <Input type="number" placeholder="altitude m" value={altitude} onChange={(e) => setAltitude(e.target.value)} />
          <Button size="sm" onClick={sendHsa}>
            Send HSA
          </Button>
        </div>
        )}

        {cmdType === 'orbit' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            <Button
              size="sm"
              className="flex-1"
              variant={pattern === 'loiter' ? 'default' : 'outline'}
              onClick={() => setPattern('loiter')}
            >
              Loiter
            </Button>
            <Button
              size="sm"
              className="flex-1"
              variant={pattern === 'racetrack' ? 'default' : 'outline'}
              onClick={() => setPattern('racetrack')}
            >
              Racetrack
            </Button>
          </div>
          {pattern === 'loiter' ? (
            <div className="flex flex-col gap-1">
              <Label className="text-muted-foreground text-[10px]">Radius (m)</Label>
              <Input type="number" value={radius} onChange={(e) => setRadius(e.target.value)} />
              <Help>Size of the circle the aircraft flies around this point. Minimum ~386 m at cruise speed.</Help>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-[10px]">Semi-major (m)</Label>
                <Input type="number" value={semiMajor} onChange={(e) => setSemiMajor(e.target.value)} />
                <Help>Half the overall length of the oval, from center to a straight-away end.</Help>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-[10px]">Semi-minor (m)</Label>
                <Input type="number" value={semiMinor} onChange={(e) => setSemiMinor(e.target.value)} />
                <Help>Half the width; also the turn radius at each end. Minimum ~386 m at cruise speed.</Help>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-muted-foreground text-[10px]">Bearing (deg)</Label>
                <Input type="number" value={bearing} onChange={(e) => setBearing(e.target.value)} />
                <Help>Compass heading of the long axis. Leave blank to use the current heading.</Help>
              </div>
            </>
          )}
          <div className="flex flex-col gap-1">
            <Label className="text-muted-foreground text-[10px]">Direction</Label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'cw' | 'ccw')}
              className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px]"
            >
              <option value="ccw" className="bg-background text-foreground">CCW (counter-clockwise)</option>
              <option value="cw" className="bg-background text-foreground">CW (clockwise)</option>
            </select>
            <Help>Which way the aircraft travels around the pattern.</Help>
          </div>
          <Button size="sm" onClick={sendOrbit}>
            Send orbit ({pattern})
          </Button>
        </div>
        )}

        {cmdType === 'waypoint' && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={editing ? 'default' : 'outline'}
              onClick={() => useMissionStore.getState().setEditing(!editing)}
            >
              {editing ? '● Placing' : 'Edit'}
            </Button>
            <Button size="sm" variant="outline" disabled={waypoints.length === 0} onClick={clearWaypoints}>
              Clear
            </Button>
            <Button size="sm" className="ml-auto" disabled={waypoints.length < 2} onClick={sendWaypoints}>
              Send
            </Button>
          </div>

          {editing && (
            <Label className="text-muted-foreground text-xs">Click inside a geozone to add a waypoint to {targetKey}.</Label>
          )}

          {waypoints.length === 0 ? (
            <span className="text-muted-foreground text-xs">No waypoints for {targetKey}.</span>
          ) : (
            <div className="flex flex-col gap-2">
              {waypoints.map((w, i) => (
                <div key={`${i}-${revision}`} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary" className="w-5 justify-center tabular-nums">
                      {i + 1}
                    </Badge>
                    <Input type="number" className="h-7 w-20" defaultValue={w.altM} onBlur={commitAlt(i)} />
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
                  <span className="text-muted-foreground pl-6 text-[10px] tabular-nums">
                    {w.lat.toFixed(4)}, {w.lng.toFixed(4)}
                    {i < waypoints.length - 1 &&
                      ` · ${Math.round(metersBetween([w.lng, w.lat], [waypoints[i + 1].lng, waypoints[i + 1].lat]))}m to #${i + 2}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {warnText && (
            <Badge variant="destructive" className="w-full justify-start whitespace-normal">
              {warnText}
            </Badge>
          )}
        </div>
        )}

        {lastAck && (
          <Badge
            variant={lastAck.accepted ? 'secondary' : 'destructive'}
            className="w-full justify-start whitespace-normal"
          >
            {lastAck.accepted ? '✓ accepted' : `✗ rejected: ${lastAck.reason}`}
          </Badge>
        )}
        </>
        )}
      </CardContent>
    </Card>
  )
}
