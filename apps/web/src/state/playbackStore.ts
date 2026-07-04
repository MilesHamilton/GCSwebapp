import { create } from 'zustand'

// Cold lane: replay playback controls. `mode` switches what the render loop draws
// (live store vs the recording sampled @currentTime); the clock advances currentTime
// while playing. Human-speed state, so normal React subscriptions/re-renders are fine.
type PlaybackState = {
  mode: 'live' | 'replay'
  playing: boolean
  currentTime: number // epoch-ms cursor into the recording
  bounds: [number, number] | null // [start, end] of the recording, set when recording stops
  setMode: (mode: 'live' | 'replay') => void
  setCurrentTime: (t: number) => void
  setBounds: (bounds: [number, number] | null) => void
  play: () => void
  pause: () => void
}

export const usePlaybackStore = create<PlaybackState>()((set) => ({
  mode: 'live',
  playing: false,
  currentTime: 0,
  bounds: null,
  setMode: (mode) => set({ mode, playing: false }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setBounds: (bounds) => set({ bounds }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
}))
