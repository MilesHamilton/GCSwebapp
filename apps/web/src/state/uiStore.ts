import { create } from 'zustand'

// Cold lane: operator HUD state. All click/toggle-speed, so normal React
// subscriptions/re-renders are fine — none of this touches the telemetry hot path.
export type LayerKey = 'geozones' | 'trail' | 'aircraft'

type UiState = {
  selectedVehicleId: string | null
  follow: boolean
  connected: boolean
  visibility: Record<LayerKey, boolean>
  setSelected: (id: string | null) => void
  toggleFollow: () => void
  setConnected: (connected: boolean) => void
  toggleLayer: (key: LayerKey) => void
}

export const useUiStore = create<UiState>()((set) => ({
  selectedVehicleId: null,
  follow: false,
  connected: false,
  visibility: { geozones: true, trail: true, aircraft: true },
  setSelected: (selectedVehicleId) => set({ selectedVehicleId }),
  toggleFollow: () => set((s) => ({ follow: !s.follow })),
  setConnected: (connected) => set({ connected }),
  toggleLayer: (key) => set((s) => ({ visibility: { ...s.visibility, [key]: !s.visibility[key] } })),
}))
