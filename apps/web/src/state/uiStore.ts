import { create } from 'zustand'

// Cold lane: operator HUD state. All click/toggle-speed, so normal React
// subscriptions/re-renders are fine — none of this touches the telemetry hot path.
type UiState = {
  selectedVehicleId: string | null
  follow: boolean
  connected: boolean
  showGeozones: boolean // geozones are the ONE global visibility toggle
  hiddenVehicles: Record<string, boolean> // per-vehicle hide (its mesh + trail); the vehicle keeps flying
  setSelected: (id: string | null) => void
  toggleFollow: () => void
  setConnected: (connected: boolean) => void
  toggleGeozones: () => void
  toggleVehicleHidden: (id: string) => void
  clearVehicleHidden: (id: string) => void
}

export const useUiStore = create<UiState>()((set) => ({
  selectedVehicleId: null,
  follow: false,
  connected: false,
  showGeozones: true,
  hiddenVehicles: {},
  setSelected: (selectedVehicleId) => set({ selectedVehicleId }),
  toggleFollow: () => set((s) => ({ follow: !s.follow })),
  setConnected: (connected) => set({ connected }),
  toggleGeozones: () => set((s) => ({ showGeozones: !s.showGeozones })),
  toggleVehicleHidden: (id) => set((s) => ({ hiddenVehicles: { ...s.hiddenVehicles, [id]: !s.hiddenVehicles[id] } })),
  // Drop a departed vehicle's hidden flag so a same-id rejoin starts visible.
  clearVehicleHidden: (id) =>
    set((s) => {
      if (!(id in s.hiddenVehicles)) return {}
      const hiddenVehicles = { ...s.hiddenVehicles }
      delete hiddenVehicles[id]
      return { hiddenVehicles }
    }),
}))
