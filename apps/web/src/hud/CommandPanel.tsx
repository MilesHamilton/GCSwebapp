import { useState } from 'react'
import { sendCommand } from '../ws/client'
import { useCommandStore } from '../state/commandStore'

// The app's first cold-lane UI: an operator command panel. Interaction is human-speed,
// so ordinary React state + re-renders are fine here — this is OFF the telemetry hot path.

const panel: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  width: 180,
  padding: 12,
  background: 'rgba(17,24,39,0.85)',
  color: '#f3f4f6',
  font: '13px system-ui, sans-serif',
  borderRadius: 8,
}
const input: React.CSSProperties = { padding: '4px 6px', background: '#111827', color: '#f3f4f6', border: '1px solid #374151', borderRadius: 4 }
const button: React.CSSProperties = { padding: '5px 8px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 4, cursor: 'pointer' }
const label: React.CSSProperties = { fontWeight: 600, opacity: 0.8 }

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

  const sendHsa = () => sendCommand({ kind: 'hsa', headingDeg: num(heading), speedMps: num(speed), altM: num(altitude) })
  const sendLoiter = () => sendCommand({ kind: 'loiter', radiusM: num(radius), direction })

  return (
    <div style={panel}>
      <div style={label}>HSA — heading / speed / alt</div>
      <input type="number" style={input} placeholder="heading °" value={heading} onChange={(e) => setHeading(e.target.value)} />
      <input type="number" style={input} placeholder="speed m/s (30–60)" value={speed} onChange={(e) => setSpeed(e.target.value)} />
      <input type="number" style={input} placeholder="altitude m" value={altitude} onChange={(e) => setAltitude(e.target.value)} />
      <button style={button} onClick={sendHsa}>Send HSA</button>

      <div style={{ ...label, marginTop: 6 }}>Loiter (CAP) — here</div>
      <input type="number" style={input} placeholder="radius m (≥ ~386)" value={radius} onChange={(e) => setRadius(e.target.value)} />
      <select style={input} value={direction} onChange={(e) => setDirection(e.target.value as 'cw' | 'ccw')}>
        <option value="ccw">CCW</option>
        <option value="cw">CW</option>
      </select>
      <button style={button} onClick={sendLoiter}>Loiter here</button>

      {lastAck && (
        <div style={{ marginTop: 6, color: lastAck.accepted ? '#4ade80' : '#f87171' }}>
          {lastAck.accepted ? '✓ accepted' : `✗ rejected: ${lastAck.reason}`}
        </div>
      )}
    </div>
  )
}
