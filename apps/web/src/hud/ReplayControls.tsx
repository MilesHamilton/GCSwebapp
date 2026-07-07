import { useEffect, useMemo, useRef } from 'react'
import { useTrackStore } from '../state/trackStore'
import { usePlaybackStore } from '../state/playbackStore'
import { useMissionStore } from '../state/missionStore'
import { Button } from '@/components/ui/button'
import { Timeline } from '@/components/ui/timeline'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { computeTimelineEvents } from '../lib/timelineEvents'

// [start, end] epoch-ms across all recorded vehicles (needs >= 2 distinct times).
function recordingBounds(recording: Record<string, { timestamp: number }[]>): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const pts of Object.values(recording)) {
    for (const p of pts) {
      if (p.timestamp < lo) lo = p.timestamp
      if (p.timestamp > hi) hi = p.timestamp
    }
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : null
}

// Cold-lane replay controls: record/stop, play/pause, live↔replay, and a scrubber.
// The playback clock advances currentTime in real time; the deck loop reads it.
export default function ReplayControls() {
  const isRecording = useTrackStore((s) => s.isRecording)
  const mode = usePlaybackStore((s) => s.mode)
  const playing = usePlaybackStore((s) => s.playing)
  const currentTime = usePlaybackStore((s) => s.currentTime)
  const bounds = usePlaybackStore((s) => s.bounds)

  const lastRef = useRef<number | null>(null)
  useEffect(() => {
    if (mode !== 'replay' || !playing || !bounds) return
    let raf = 0
    lastRef.current = null
    const tick = (now: number) => {
      const last = lastRef.current
      lastRef.current = now
      if (last != null) {
        const pb = usePlaybackStore.getState()
        const next = pb.currentTime + (now - last)
        if (next >= bounds[1]) {
          pb.setCurrentTime(bounds[1])
          pb.pause()
          return
        }
        pb.setCurrentTime(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mode, playing, bounds])

  const startRec = () => {
    usePlaybackStore.getState().setMode('live')
    usePlaybackStore.getState().setBounds(null)
    useTrackStore.getState().startRecording()
  }
  const stopRec = () => {
    useTrackStore.getState().stopRecording()
    const b = recordingBounds(useTrackStore.getState().recording)
    const pb = usePlaybackStore.getState()
    pb.setBounds(b)
    // Only enter replay if there's a usable recording; otherwise stay live (no dead state).
    if (b) {
      pb.setMode('replay')
      pb.setCurrentTime(b[0])
    }
  }
  const togglePlay = () => {
    const pb = usePlaybackStore.getState()
    if (pb.playing) {
      pb.pause()
      return
    }
    // Play-from-end restarts: rewind to the start rather than sitting frozen at the end.
    if (pb.bounds && pb.currentTime >= pb.bounds[1]) pb.setCurrentTime(pb.bounds[0])
    pb.play()
  }

  const elapsed = bounds ? Math.max(0, currentTime - bounds[0]) : 0
  const total = bounds ? bounds[1] - bounds[0] : 0

  // Recompute markers only when a recording finalizes (bounds set on Stop). Reads the
  // hot-lane recording imperatively so telemetry ticks don't re-render this panel.
  const events = useMemo(() => {
    const track = useTrackStore.getState()
    // sentPaths (not the live-editable paths) so clearing the on-screen draft before Stop
    // can't erase the record of a route the vehicle actually flew during this recording.
    return computeTimelineEvents(track.recording, track.geozones, useMissionStore.getState().sentPaths, bounds)
  }, [bounds])

  return (
    <Card className="absolute bottom-3 left-1/2 z-10 w-[420px] -translate-x-1/2 gap-2 py-2">
      <CardContent className="gap-2 px-3">
        <div className="flex items-center gap-2">
          {!isRecording ? (
            <Button size="sm" variant="destructive" onClick={startRec}>
              ● Record
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={stopRec}>
              ■ Stop
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={mode !== 'replay' || !bounds} onClick={togglePlay}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </Button>
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant={mode === 'live' ? 'default' : 'outline'}
              onClick={() => usePlaybackStore.getState().setMode('live')}
            >
              Live
            </Button>
            <Button
              size="sm"
              variant={mode === 'replay' ? 'default' : 'outline'}
              disabled={!bounds}
              onClick={() => usePlaybackStore.getState().setMode('replay')}
            >
              Replay
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Timeline
            min={bounds ? bounds[0] : 0}
            max={bounds ? bounds[1] : 1}
            value={bounds ? currentTime : 0}
            events={events}
            disabled={mode !== 'replay' || !bounds}
            onValueChange={(t) => {
              const pb = usePlaybackStore.getState()
              pb.pause()
              pb.setCurrentTime(t)
            }}
          />
          <Badge variant="secondary" className="tabular-nums whitespace-nowrap">
            {(elapsed / 1000).toFixed(1)}s / {(total / 1000).toFixed(0)}s
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
