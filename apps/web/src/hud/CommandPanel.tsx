import { useState } from 'react'
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
// human-speed, so ordinary React state + re-renders are fine here — OFF the telemetry hot path.
export default function CommandPanel() {
  const [heading, setHeading] = useState('')
  const [speed, setSpeed] = useState('')
  const [altitude, setAltitude] = useState('')
  const [radius, setRadius] = useState('2226')
  const [direction, setDirection] = useState<'cw' | 'ccw'>('ccw')
  const [semiMajor, setSemiMajor] = useState('3000')
  const [semiMinor, setSemiMinor] = useState('600')
  const [bearing, setBearing] = useState('')
  // Commands target the SELECTED vehicle (map click or the panel selector). No selection
  // -> omit vehicleId so the server default ('uav-01') still works. The ack is read for
  // that same vehicle, so a fleet's acks don't clobber each other.
  const selectedId = useUiStore((s) => s.selectedVehicleId)
  const target = selectedId ?? undefined
  const lastAck = useCommandStore((s) => (selectedId ? s.acks[selectedId] : undefined))
  // Live roster for the selector. Shallow-compare the id LIST so this re-renders only when
  // a vehicle joins/leaves — not on every 10 Hz telemetry tick (keeps the hot path off React).
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
  const sendLoiter = () => sendCommand({ kind: 'loiter', radiusM: num(radius), direction }, target)
  const sendRacetrack = () =>
    sendCommand(
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
        <CardTitle className="text-sm">Command → {selectedId ?? 'uav-01 (default)'}</CardTitle>
      </CardHeader>
      <CardContent className="gap-4 px-3">
        <div className="flex flex-col gap-1">
          <Label className="text-muted-foreground text-xs">Vehicles — pick a target</Label>
          <div className="flex flex-wrap gap-1">
            {vehicleIds.length === 0 && <span className="text-muted-foreground text-xs">none connected</span>}
            {vehicleIds.map((id) => (
              <Button
                key={id}
                size="sm"
                variant={selectedId === id ? 'default' : 'outline'}
                onClick={() => useUiStore.getState().setSelected(id)}
              >
                {id}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">HSA — heading / speed / alt</Label>
          <Input type="number" placeholder="heading °" value={heading} onChange={(e) => setHeading(e.target.value)} />
          <Input type="number" placeholder="speed m/s (30–60)" value={speed} onChange={(e) => setSpeed(e.target.value)} />
          <Input type="number" placeholder="altitude m" value={altitude} onChange={(e) => setAltitude(e.target.value)} />
          <Button size="sm" onClick={sendHsa}>
            Send HSA
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Loiter (CAP) — here</Label>
          <Input type="number" placeholder="radius m (≥ ~386)" value={radius} onChange={(e) => setRadius(e.target.value)} />
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'cw' | 'ccw')}
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px]"
          >
            <option value="ccw">CCW</option>
            <option value="cw">CW</option>
          </select>
          <Button size="sm" onClick={sendLoiter}>
            Loiter here
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Racetrack — semi-major / semi-minor</Label>
          <Input type="number" placeholder="semi-major m (½ length)" value={semiMajor} onChange={(e) => setSemiMajor(e.target.value)} />
          <Input type="number" placeholder="semi-minor m (turn r, ≥ ~386)" value={semiMinor} onChange={(e) => setSemiMinor(e.target.value)} />
          <Input type="number" placeholder="bearing ° (blank = current)" value={bearing} onChange={(e) => setBearing(e.target.value)} />
          <Button size="sm" onClick={sendRacetrack}>
            Racetrack here
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
      </CardContent>
    </Card>
  )
}
