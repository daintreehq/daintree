import { create } from "zustand";
import type { ITheme } from "@xterm/xterm";
import {
  DEFAULT_APP_SCHEME_ID,
  getTerminalScrollbarDefaults,
  getTerminalThemeFromAppScheme,
  resolveAppTheme,
  type AppColorScheme,
} from "@shared/theme";
import {
  BUILT_IN_SCHEMES,
  DEFAULT_SCHEME_ID,
  type TerminalColorScheme,
} from "@/config/terminalColorSchemes";
import { useAppThemeStore } from "@/store/appThemeStore";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";

const RECENT_SCHEMES_LIMIT = 5;

interface TerminalColorSchemeState {
  selectedSchemeId: string;
  customSchemes: TerminalColorScheme[];
  recentSchemeIds: string[];
  /**
   * Ephemeral override used by the picker for live hover/focus preview.
   * When non-null, `selectEffectiveTheme` / `selectWrapperBackground` /
   * `getEffectiveTheme` treat this id as the currently selected scheme
   * without mutating `selectedSchemeId`. Never persisted.
   */
  previewSchemeId: string | null;
  setSelectedSchemeId: (id: string) => void;
  setPreviewSchemeId: (id: string | null) => void;
  addCustomScheme: (scheme: TerminalColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  setRecentSchemeIds: (ids: string[]) => void;
  getEffectiveTheme: () => ITheme;
}

/**
 * Resolves the active scheme ID with precedence:
 * 1. Terminal picker preview (hover/focus in picker)
 * 2. App theme preview (active theme browser preview)
 * 3. Committed terminal selection
 */
function resolveActiveSchemeId(state: TerminalColorSchemeState): string {
  if (state.previewSchemeId) return state.previewSchemeId;

  const appPreviewSchemeId = useAppThemeStore.getState().previewSchemeId;
  if (appPreviewSchemeId) return "app-preview";

  return state.selectedSchemeId;
}

export function selectWrapperBackground(state: TerminalColorSchemeState): string {
  const activeId = resolveActiveSchemeId(state);

  if (activeId === "app-preview") {
    const appPreviewId = useAppThemeStore.getState().previewSchemeId;
    const appCustomSchemes = useAppThemeStore.getState().customSchemes;
    const appScheme = resolveAppTheme(appPreviewId ?? DEFAULT_APP_SCHEME_ID, appCustomSchemes);
    return appScheme.tokens["terminal-background"] ?? "var(--theme-surface-canvas)";
  }

  const allSchemes = [...BUILT_IN_SCHEMES, ...state.customSchemes];
  const scheme = allSchemes.find((s) => s.id === activeId);

  if (!scheme) {
    return "var(--theme-surface-canvas)";
  }

  if (scheme.id === DEFAULT_SCHEME_ID) {
    const appThemeId = useAppThemeStore.getState().selectedSchemeId;
    const appCustomSchemes = useAppThemeStore.getState().customSchemes;
    const appScheme = resolveAppTheme(appThemeId, appCustomSchemes);
    return appScheme.tokens["terminal-background"] ?? "var(--theme-surface-canvas)";
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
    const appCustomSchemes = useAppThemeStore.getState().customSchemes;
    const appScheme = resolveAppTheme(appThemeId, appCustomSchemes);
    return getTerminalThemeFromAppScheme(appScheme);
  }

  return {
    ...scheme.colors,
    ...getTerminalScrollbarDefaults(scheme.type),
  };
}

/**
 * Computes the terminal theme when an app theme preview is active.
 * Derives colors directly from the app theme tokens.
 */
function computeAppPreviewTheme(appPreviewId: string, appCustomSchemes: unknown[]): ITheme {
  const appScheme = resolveAppTheme(appPreviewId, appCustomSchemes as AppColorScheme[]);
  return getTerminalThemeFromAppScheme(appScheme);
}

let _cachedTheme: ITheme | null = null;
let _cachedSchemeId: string | null = null;
let _cachedPreviewSchemeId: string | null = null;
let _cachedCustomSchemes: TerminalColorScheme[] | null = null;
let _cachedAppThemeId: string | null = null;
let _cachedAppPreviewSchemeId: string | null = null;
let _cachedAppCustomSchemes: unknown[] | null = null;

/**
 * Clears the internal cache. Exported for testing.
 */
export function clearThemeCache(): void {
  _cachedTheme = null;
  _cachedSchemeId = null;
  _cachedPreviewSchemeId = null;
  _cachedCustomSchemes = null;
  _cachedAppThemeId = null;
  _cachedAppPreviewSchemeId = null;
  _cachedAppCustomSchemes = null;
}

export function selectEffectiveTheme(state: TerminalColorSchemeState): ITheme {
  const appThemeId = useAppThemeStore.getState().selectedSchemeId;
  const appPreviewSchemeId = useAppThemeStore.getState().previewSchemeId;
  const appCustomSchemes = useAppThemeStore.getState().customSchemes;
  const activeId = resolveActiveSchemeId(state);

  if (
    _cachedTheme !== null &&
    _cachedSchemeId === state.selectedSchemeId &&
    _cachedPreviewSchemeId === state.previewSchemeId &&
    _cachedCustomSchemes === state.customSchemes &&
    _cachedAppThemeId === appThemeId &&
    _cachedAppPreviewSchemeId === appPreviewSchemeId &&
    _cachedAppCustomSchemes === appCustomSchemes
  ) {
    return _cachedTheme;
  }
  _cachedSchemeId = state.selectedSchemeId;
  _cachedPreviewSchemeId = state.previewSchemeId;
  _cachedCustomSchemes = state.customSchemes;
  _cachedAppThemeId = appThemeId;
  _cachedAppPreviewSchemeId = appPreviewSchemeId;
  _cachedAppCustomSchemes = appCustomSchemes;

  if (activeId === "app-preview") {
    _cachedTheme = computeAppPreviewTheme(
      appPreviewSchemeId ?? DEFAULT_APP_SCHEME_ID,
      appCustomSchemes
    );
  } else {
    _cachedTheme = computeEffectiveTheme(activeId, state.customSchemes);
  }
  return _cachedTheme;
}

export const useTerminalColorSchemeStore = create<TerminalColorSchemeState>()((set, get) => ({
  selectedSchemeId: DEFAULT_SCHEME_ID,
  customSchemes: [],
  recentSchemeIds: [],
  previewSchemeId: null,

  setSelectedSchemeId: (id) =>
    set((state) => ({
      selectedSchemeId: id,
      recentSchemeIds: [id, ...state.recentSchemeIds.filter((x) => x !== id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    })),

  setPreviewSchemeId: (id) => set({ previewSchemeId: id }),

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) =>
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: state.selectedSchemeId === id ? DEFAULT_SCHEME_ID : state.selectedSchemeId,
      previewSchemeId: state.previewSchemeId === id ? null : state.previewSchemeId,
      recentSchemeIds: state.recentSchemeIds.filter((x) => x !== id),
    })),

  setRecentSchemeIds: (ids) =>
    set({ recentSchemeIds: Array.from(new Set(ids)).slice(0, RECENT_SCHEMES_LIMIT) }),

  getEffectiveTheme: (): ITheme => {
    const state = get();
    const activeId = resolveActiveSchemeId(state);

    if (activeId === "app-preview") {
      const appPreviewSchemeId = useAppThemeStore.getState().previewSchemeId;
      const appCustomSchemes = useAppThemeStore.getState().customSchemes;
      return computeAppPreviewTheme(
        appPreviewSchemeId ?? DEFAULT_APP_SCHEME_ID,
        appCustomSchemes as AppColorScheme[]
      );
    }

    return computeEffectiveTheme(activeId, state.customSchemes);
  },
}));
