import { create } from 'zustand'
import type { CommandAckMsg } from '../ws/types'

// The "cold lane": human-speed command/ack UI state. Unlike the telemetry hot lane,
// normal React re-renders are fine here — acks arrive at click speed, not 10 Hz.
// Phase 11: acks are keyed by vehicleId so a fleet's acks don't overwrite each other and
// the panel can show the ack for the *selected* vehicle.
type CommandState = {
  acks: Record<string, CommandAckMsg> // vehicleId -> its most recent ack
  setAck: (ack: CommandAckMsg) => void
}

export const useCommandStore = create<CommandState>()((set) => ({
  acks: {},
  setAck: (ack) => set((s) => ({ acks: { ...s.acks, [ack.vehicleId]: ack } })),
}))
