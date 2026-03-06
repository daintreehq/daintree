import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { CANOPY_TERMINAL_THEME } from "@/utils/terminalTheme";

interface TerminalColorSchemeState {
  selectedSchemeId: string;
  customSchemes: TerminalColorScheme[];
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: TerminalColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  getEffectiveTheme: () => ITheme;
}

const SCROLLBAR_DEFAULTS = {
  scrollbarSliderBackground: "rgba(82, 82, 91, 0.4)",
  scrollbarSliderHoverBackground: "rgba(82, 82, 91, 0.6)",
  scrollbarSliderActiveBackground: "rgba(82, 82, 91, 0.8)",
};

export const useTerminalColorSchemeStore = create<TerminalColorSchemeState>()((set, get) => ({
  selectedSchemeId: DEFAULT_SCHEME_ID,
  customSchemes: [],

  setSelectedSchemeId: (id) => set({ selectedSchemeId: id }),

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) =>
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: state.selectedSchemeId === id ? DEFAULT_SCHEME_ID : state.selectedSchemeId,
    })),

  getEffectiveTheme: (): ITheme => {
    const { selectedSchemeId, customSchemes } = get();
    const allSchemes = [...BUILT_IN_SCHEMES, ...customSchemes];
    const scheme = allSchemes.find((s) => s.id === selectedSchemeId);

    if (!scheme || scheme.id === DEFAULT_SCHEME_ID) {
      return { ...CANOPY_TERMINAL_THEME };
    }

    return {
      ...scheme.colors,
      ...SCROLLBAR_DEFAULTS,
    };
  },
}));
