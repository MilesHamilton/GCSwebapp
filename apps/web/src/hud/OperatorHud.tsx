import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUiStore } from '../state/uiStore'
import { useTrackStore, type Vehicle } from '../state/trackStore'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// 5 Hz: sample the hot store at human-refresh rate rather than subscribing to every
// telemetry tick — that's how live telemetry reaches React without dragging the hot
// path (10 Hz data / 60 fps draw) back through the render cycle.
const SAMPLE_MS = 200

function useSampledVehicle(id: string | null): Vehicle | null {
  const [v, setV] = useState<Vehicle | null>(null)
  useEffect(() => {
    if (!id) {
      setV(null)
      return
    }
    const read = () => setV(useTrackStore.getState().vehicles[id] ?? null)
    read()
    const timer = setInterval(read, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [id])
  return v
}

export default function OperatorHud() {
  const connected = useUiStore((s) => s.connected)
  const follow = useUiStore((s) => s.follow)
  const showGeozones = useUiStore((s) => s.showGeozones)
  const hidden = useUiStore((s) => s.hiddenVehicles)
  const selectedId = useUiStore((s) => s.selectedVehicleId)
  // Roster for the fleet list. Shallow-compare the id LIST so this re-renders only on
  // join/leave — not on every 10 Hz telemetry tick (keeps the hot path off React).
  const vehicleIds = useTrackStore(useShallow((s) => Object.keys(s.vehicles).sort()))
  const v = useSampledVehicle(selectedId)

  return (
    <Card className="absolute top-3 right-3 z-10 w-60 gap-3 py-3">
      <CardHeader className="flex-row items-center justify-between px-3">
        <CardTitle className="text-sm">Operator HUD</CardTitle>
        <Badge variant={connected ? 'secondary' : 'destructive'}>{connected ? 'link ●' : 'no link'}</Badge>
      </CardHeader>
      <CardContent className="gap-3 px-3">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Fleet — select · show/hide</span>
          {vehicleIds.length === 0 && <span className="text-muted-foreground text-xs">no vehicles</span>}
          {vehicleIds.map((id) => (
            <div key={id} className="flex items-center gap-1">
              <Button
                size="sm"
                variant={selectedId === id ? 'default' : 'outline'}
                className="flex-1 justify-start"
                onClick={() => useUiStore.getState().setSelected(id)}
              >
                {id}
              </Button>
              <Button
                size="sm"
                variant={hidden[id] ? 'outline' : 'secondary'}
                className="text-muted-foreground w-16"
                onClick={() => useUiStore.getState().toggleVehicleHidden(id)}
              >
                {hidden[id] ? 'hidden' : 'shown'}
              </Button>
            </div>
          ))}
        </div>

        <div className="flex gap-1">
          <Button
            size="sm"
            variant={showGeozones ? 'default' : 'outline'}
            onClick={() => useUiStore.getState().toggleGeozones()}
          >
            Zones
          </Button>
          <Button
            size="sm"
            variant={follow ? 'default' : 'outline'}
            disabled={!selectedId}
            onClick={() => useUiStore.getState().toggleFollow()}
          >
            {follow ? 'Following' : selectedId ? 'Follow' : 'Follow (select first)'}
          </Button>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Selected vehicle</span>
          {v ? (
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs tabular-nums">
              <span className="text-muted-foreground">id</span>
              <span>{v.id}</span>
              <span className="text-muted-foreground">mode</span>
              <span>{v.mode ?? '—'}</span>
              <span className="text-muted-foreground">lng</span>
              <span>{v.position[0].toFixed(4)}</span>
              <span className="text-muted-foreground">lat</span>
              <span>{v.position[1].toFixed(4)}</span>
              <span className="text-muted-foreground">alt</span>
              <span>{Math.round(v.altM ?? 0)} m</span>
              <span className="text-muted-foreground">spd</span>
              <span>{Math.round(v.speedMps ?? 0)} m/s</span>
              <span className="text-muted-foreground">hdg</span>
              <span>{Math.round(v.headingDeg)}°</span>
              <span className="text-muted-foreground">bat</span>
              <span>{Math.round(v.batteryPct ?? 0)}%</span>
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">select a vehicle above or click it on the map</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
