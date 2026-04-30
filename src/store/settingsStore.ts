import { create } from "zustand";
import type { SettingsTab } from "@/components/Settings/SettingsDialog";

interface SettingsState {
  activeTab: SettingsTab | null;
  activeSubtab: string | null;
  activeSectionId: string | null;
  setTab: (tab: SettingsTab | null) => void;
  setSubtab: (subtab: string | null) => void;
  setSectionId: (sectionId: string | null) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeTab: null,
  activeSubtab: null,
  activeSectionId: null,
  setTab: (tab) => set({ activeTab: tab }),
  setSubtab: (subtab) => set({ activeSubtab: subtab }),
  setSectionId: (sectionId) => set({ activeSectionId: sectionId }),
}));
