import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { getTerminalScrollbarDefaults } from "@shared/theme";
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

export function selectWrapperBackground(state: TerminalColorSchemeState): string {
  const allSchemes = [...BUILT_IN_SCHEMES, ...state.customSchemes];
  const scheme = allSchemes.find((s) => s.id === state.selectedSchemeId);

  if (!scheme || scheme.id === DEFAULT_SCHEME_ID) {
    return "var(--theme-surface-canvas)";
  }

  return (scheme.colors.background as string) ?? "var(--theme-surface-canvas)";
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
      ...getTerminalScrollbarDefaults(scheme.type),
    };
  },
}));
