import { create } from 'zustand'
import type { CommandAckMsg } from '../ws/types'

// The "cold lane": human-speed command/ack UI state. Unlike the telemetry hot lane,
// normal React re-renders are fine here — acks arrive at click speed, not 10 Hz.
type CommandState = {
  lastAck: CommandAckMsg | null
  setAck: (ack: CommandAckMsg) => void
}

export const useCommandStore = create<CommandState>()((set) => ({
  lastAck: null,
  setAck: (ack) => set({ lastAck: ack }),
}))
