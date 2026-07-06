import { Slider } from './slider'
import { cn } from '@/lib/utils'

// A discrete moment worth marking on the replay track (recording endpoints, geozone
// breaches, …). `t` is epoch-ms; the marker's x-position is its fraction of [min, max].
export type TimelineEvent = {
  t: number
  label: string
  kind: 'start' | 'end' | 'breach' | 'return' | 'waypoint'
}

const MARKER_COLOR: Record<TimelineEvent['kind'], string> = {
  start: 'bg-emerald-400',
  end: 'bg-slate-400',
  breach: 'bg-red-500',
  return: 'bg-sky-400',
  waypoint: 'bg-amber-400',
}

type TimelineProps = {
  min: number
  max: number
  value: number
  events: TimelineEvent[]
  disabled?: boolean
  onValueChange: (t: number) => void
}

// Enhanced replay scrubber: the shadcn Slider handles drag/click-to-seek, with event
// markers overlaid on the rail. Hover a marker for its label (CSS-only tooltip, no dep).
export function Timeline({ min, max, value, events, disabled, onValueChange }: TimelineProps) {
  const span = max - min
  const pct = (t: number) => (span <= 0 ? 0 : ((t - min) / span) * 100)

  return (
    <div className="relative w-full">
      {/* Inset by the thumb radius (8px) so 0%/100% markers line up with the slider ends.
          Zero-height container; only the thin marker lines capture pointer events. */}
      <div className="pointer-events-none absolute inset-x-2 top-1/2 z-10 -translate-y-1/2">
        {events.map((e, i) => (
          <div
            key={i}
            className="group pointer-events-auto absolute -translate-x-1/2"
            style={{ left: `${pct(e.t)}%` }}
          >
            <div className={cn('h-3 w-0.5 rounded-full', MARKER_COLOR[e.kind])} />
            <div className="bg-secondary text-secondary-foreground absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap shadow group-hover:block">
              {e.label}
            </div>
          </div>
        ))}
      </div>
      <Slider
        min={min}
        max={max}
        value={[value]}
        step={100}
        disabled={disabled}
        onValueChange={(v) => onValueChange(v[0])}
      />
    </div>
  )
}
