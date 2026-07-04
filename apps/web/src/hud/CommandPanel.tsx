import { useState } from 'react'
import { sendCommand } from '../ws/client'
import { useCommandStore } from '../state/commandStore'
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
  const lastAck = useCommandStore((s) => s.lastAck)

  // Empty OR non-numeric -> undefined, so a blank/typo cleanly means "leave unchanged"
  // (rather than sending NaN, which JSON turns into a silent null).
  const num = (s: string): number | undefined => {
    if (s.trim() === '') return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }

  const sendHsa = () =>
    sendCommand({ kind: 'hsa', headingDeg: num(heading), speedMps: num(speed), altM: num(altitude) })
  const sendLoiter = () => sendCommand({ kind: 'loiter', radiusM: num(radius), direction })

  return (
    <Card className="absolute top-3 left-3 z-10 w-56 gap-3 py-3">
      <CardHeader className="px-3">
        <CardTitle className="text-sm">Command</CardTitle>
      </CardHeader>
      <CardContent className="gap-4 px-3">
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
