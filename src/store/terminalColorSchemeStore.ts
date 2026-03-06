import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { TERMINAL_SCROLLBAR_DEFAULTS } from "@shared/theme";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";

interface TerminalColorSchemeState {
  selectedSchemeId: string;
  customSchemes: TerminalColorScheme[];
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: TerminalColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  getEffectiveTheme: () => ITheme;
}

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
      return getTerminalThemeFromCSS();
    }

    return {
      ...scheme.colors,
      ...TERMINAL_SCROLLBAR_DEFAULTS,
    };
  },
}));
