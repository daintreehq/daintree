import { create } from "zustand";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import type { ColorVisionMode } from "@shared/types";
import { applyAppThemeToRoot, applyColorVisionMode } from "@/theme/applyAppTheme";

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
  colorVisionMode: ColorVisionMode;
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: AppColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  injectTheme: (scheme: AppColorScheme) => void;
  setColorVisionMode: (mode: ColorVisionMode) => void;
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

  setSelectedSchemeId: (id) => {
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
}));

export { injectSchemeToDOM };
