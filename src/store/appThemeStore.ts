import { create } from "zustand";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";
import { applyAppThemeToRoot, applyColorVisionMode } from "@/theme/applyAppTheme";

const RECENT_SCHEMES_LIMIT = 5;

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
  colorVisionMode: ColorVisionMode;
  followSystem: boolean;
  preferredDarkSchemeId: string;
  preferredLightSchemeId: string;
  recentSchemeIds: string[];
  setSelectedSchemeId: (id: string) => void;
  /**
   * Like setSelectedSchemeId, but does NOT update recentSchemeIds. Used for
   * OS-driven follow-system changes and startup hydration, where the change
   * does not reflect direct user intent.
   */
  setSelectedSchemeIdSilent: (id: string) => void;
  addCustomScheme: (scheme: AppColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  injectTheme: (scheme: AppColorScheme) => void;
  setColorVisionMode: (mode: ColorVisionMode) => void;
  setFollowSystem: (enabled: boolean) => void;
  setPreferredDarkSchemeId: (id: string) => void;
  setPreferredLightSchemeId: (id: string) => void;
  setRecentSchemeIds: (ids: string[]) => void;
}

function injectSchemeToDOM(scheme: AppColorScheme): void {
  applyAppThemeToRoot(document.documentElement, scheme);
  // Reapply CVD overrides after theme injection so they aren't overwritten
  const { colorVisionMode } = useAppThemeStore.getState();
  if (colorVisionMode !== "default") {
    applyColorVisionMode(document.documentElement, colorVisionMode);
  }
}

export const useAppThemeStore = create<AppThemeState>()((set) => ({
  selectedSchemeId: DEFAULT_APP_SCHEME_ID,
  customSchemes: [],
  colorVisionMode: "default" as ColorVisionMode,
  followSystem: false,
  preferredDarkSchemeId: "daintree",
  preferredLightSchemeId: "bondi",
  recentSchemeIds: [],

  setSelectedSchemeId: (id) => {
    const { customSchemes } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(id, customSchemes);
    set((state) => ({
      selectedSchemeId: scheme.id,
      recentSchemeIds: [scheme.id, ...state.recentSchemeIds.filter((x) => x !== scheme.id)].slice(
        0,
        RECENT_SCHEMES_LIMIT
      ),
    }));
    injectSchemeToDOM(scheme);
  },

  setSelectedSchemeIdSilent: (id) => {
    const { customSchemes } = useAppThemeStore.getState();
    const scheme = resolveAppTheme(id, customSchemes);
    set({ selectedSchemeId: scheme.id });
    injectSchemeToDOM(scheme);
  },

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) => {
    const { selectedSchemeId } = useAppThemeStore.getState();
    const needsFallback = selectedSchemeId === id;
    set((state) => ({
      customSchemes: state.customSchemes.filter((s) => s.id !== id),
      selectedSchemeId: needsFallback ? DEFAULT_APP_SCHEME_ID : state.selectedSchemeId,
      recentSchemeIds: state.recentSchemeIds.filter((x) => x !== id),
    }));
    if (needsFallback) {
      const defaultScheme = BUILT_IN_APP_SCHEMES.find((s) => s.id === DEFAULT_APP_SCHEME_ID)!;
      injectSchemeToDOM(defaultScheme);
    }
  },

  injectTheme: (scheme) => {
    injectSchemeToDOM(scheme);
  },

  setColorVisionMode: (mode) => {
    set({ colorVisionMode: mode });
    applyColorVisionMode(document.documentElement, mode);
  },

  setFollowSystem: (enabled) => set({ followSystem: enabled }),
  setPreferredDarkSchemeId: (id) => set({ preferredDarkSchemeId: id }),
  setPreferredLightSchemeId: (id) => set({ preferredLightSchemeId: id }),
  setRecentSchemeIds: (ids) =>
    set({ recentSchemeIds: Array.from(new Set(ids)).slice(0, RECENT_SCHEMES_LIMIT) }),
}));

export { injectSchemeToDOM };
