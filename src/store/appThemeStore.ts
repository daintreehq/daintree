import { create } from "zustand";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: AppColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  injectTheme: (scheme: AppColorScheme) => void;
}

function injectSchemeToDOM(scheme: AppColorScheme): void {
  applyAppThemeToRoot(document.documentElement, scheme);
}

export const useAppThemeStore = create<AppThemeState>()((set, get) => ({
  selectedSchemeId: DEFAULT_APP_SCHEME_ID,
  customSchemes: [],

  setSelectedSchemeId: (id) => {
    const { customSchemes } = get();
    const scheme = resolveAppTheme(id, customSchemes);
    set({ selectedSchemeId: scheme.id });
    injectSchemeToDOM(scheme);
  },

  addCustomScheme: (scheme) =>
    set((state) => ({
      customSchemes: [...state.customSchemes.filter((s) => s.id !== scheme.id), scheme],
    })),

  removeCustomScheme: (id) => {
    const { selectedSchemeId } = get();
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
}));

export { injectSchemeToDOM };
