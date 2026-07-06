import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { sendCommand } from '../ws/client'
import { useCommandStore } from '../state/commandStore'
import { useUiStore } from '../state/uiStore'
import { useTrackStore } from '../state/trackStore'
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

export default function CommandPanel() {
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
        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">HSA: heading / speed / alt</Label>
          <Input type="number" placeholder="heading °" value={heading} onChange={(e) => setHeading(e.target.value)} />
          <Input type="number" placeholder="speed m/s (30–60)" value={speed} onChange={(e) => setSpeed(e.target.value)} />
          <Input type="number" placeholder="altitude m" value={altitude} onChange={(e) => setAltitude(e.target.value)} />
          <Button size="sm" onClick={sendHsa}>
            Send HSA
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Orbit: fly a repeating pattern about this point</Label>
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
