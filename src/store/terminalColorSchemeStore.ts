import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import { getTerminalScrollbarDefaults } from "@shared/theme";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  getMappedTerminalScheme,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";

const RECENT_SCHEMES_LIMIT = 5;

interface TerminalColorSchemeState {
  selectedSchemeId: string;
  customSchemes: TerminalColorScheme[];
  recentSchemeIds: string[];
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: TerminalColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  setRecentSchemeIds: (ids: string[]) => void;
  getEffectiveTheme: () => ITheme;
}

export function selectWrapperBackground(state: TerminalColorSchemeState): string {
  const allSchemes = [...BUILT_IN_SCHEMES, ...state.customSchemes];
  const scheme = allSchemes.find((s) => s.id === state.selectedSchemeId);

  if (!scheme) {
    return "var(--theme-surface-canvas)";
  }

  if (scheme.id === DEFAULT_SCHEME_ID) {
    const appThemeId = useAppThemeStore.getState().selectedSchemeId;
    const mapped = getMappedTerminalScheme(appThemeId);
    if (mapped?.colors.background) return mapped.colors.background;
    return "var(--theme-surface-canvas)";
  }

  return scheme.colors.background ?? "var(--theme-surface-canvas)";
}

function computeEffectiveTheme(
  selectedSchemeId: string,
  customSchemes: TerminalColorScheme[]
): ITheme {
  const allSchemes = [...BUILT_IN_SCHEMES, ...customSchemes];
  const scheme = allSchemes.find((s) => s.id === selectedSchemeId);

  if (!scheme) {
    return getTerminalThemeFromCSS();
  }

  if (scheme.id === DEFAULT_SCHEME_ID) {
    const appThemeId = useAppThemeStore.getState().selectedSchemeId;
    const mapped = getMappedTerminalScheme(appThemeId);
    if (mapped) {
      return { ...mapped.colors, ...getTerminalScrollbarDefaults(mapped.type) };
    }
    return getTerminalThemeFromCSS();
  }

  return {
    ...scheme.colors,
    ...getTerminalScrollbarDefaults(scheme.type),
  };
}

let _cachedTheme: ITheme | null = null;
let _cachedSchemeId: string | null = null;
let _cachedCustomSchemes: TerminalColorScheme[] | null = null;
let _cachedAppThemeId: string | null = null;

export function selectEffectiveTheme(state: TerminalColorSchemeState): ITheme {
  const appThemeId = useAppThemeStore.getState().selectedSchemeId;
  if (
    _cachedTheme !== null &&
    _cachedSchemeId === state.selectedSchemeId &&
    _cachedCustomSchemes === state.customSchemes &&
    _cachedAppThemeId === appThemeId
  ) {
    return _cachedTheme;
  }
  _cachedSchemeId = state.selectedSchemeId;
  _cachedCustomSchemes = state.customSchemes;
  _cachedAppThemeId = appThemeId;
  _cachedTheme = computeEffectiveTheme(state.selectedSchemeId, state.customSchemes);
  return _cachedTheme;
}

export const useTerminalColorSchemeStore = create<TerminalColorSchemeState>()((set, get) => ({
  selectedSchemeId: DEFAULT_SCHEME_ID,
  customSchemes: [],
  recentSchemeIds: [],

  setSelectedSchemeId: (id) =>
    set((state) => ({
      selectedSchemeId: id,
      recentSchemeIds: [id, ...state.recentSchemeIds.filter((x) => x !== id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    })),

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) =>
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: state.selectedSchemeId === id ? DEFAULT_SCHEME_ID : state.selectedSchemeId,
      recentSchemeIds: state.recentSchemeIds.filter((x) => x !== id),
    })),

  setRecentSchemeIds: (ids) =>
    set({ recentSchemeIds: Array.from(new Set(ids)).slice(0, RECENT_SCHEMES_LIMIT) }),

  getEffectiveTheme: (): ITheme => {
    const { selectedSchemeId, customSchemes } = get();
    return computeEffectiveTheme(selectedSchemeId, customSchemes);
  },
}));
