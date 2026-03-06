import { create } from "zustand";
import { BUILT_IN_APP_SCHEMES, DEFAULT_APP_SCHEME_ID } from "@/config/appColorSchemes";
import type { AppColorScheme } from "@shared/types/appTheme";

interface AppThemeState {
  selectedSchemeId: string;
  customSchemes: AppColorScheme[];
  setSelectedSchemeId: (id: string) => void;
  addCustomScheme: (scheme: AppColorScheme) => void;
  removeCustomScheme: (id: string) => void;
  injectTheme: (scheme: AppColorScheme) => void;
}

function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(expanded.substring(0, 2), 16);
  const g = parseInt(expanded.substring(2, 4), 16);
  const b = parseInt(expanded.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "0, 0, 0";
  return `${r}, ${g}, ${b}`;
}

function injectSchemeToDOM(scheme: AppColorScheme): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(scheme.tokens)) {
    root.style.setProperty(`--color-${key}`, value);
  }
  // Compute RGB triplet for accent to support rgba() usage patterns
  const accentHex = scheme.tokens["canopy-accent"];
  if (accentHex && accentHex.startsWith("#")) {
    root.style.setProperty("--color-canopy-accent-rgb", hexToRgbTriplet(accentHex));
  }
}

function resolveScheme(id: string, customSchemes: AppColorScheme[]): AppColorScheme {
  const allSchemes = [...BUILT_IN_APP_SCHEMES, ...customSchemes];
  return (
    allSchemes.find((s) => s.id === id) ??
    BUILT_IN_APP_SCHEMES.find((s) => s.id === DEFAULT_APP_SCHEME_ID)!
  );
}

export const useAppThemeStore = create<AppThemeState>()((set, get) => ({
  selectedSchemeId: DEFAULT_APP_SCHEME_ID,
  customSchemes: [],

  setSelectedSchemeId: (id) => {
    const { customSchemes } = get();
    const scheme = resolveScheme(id, customSchemes);
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
