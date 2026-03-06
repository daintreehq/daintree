import type { AppThemeConfig } from "@shared/types";

export const appThemeClient = {
  get: (): Promise<AppThemeConfig> => {
    return window.electron.appTheme.get();
  },

  setColorScheme: (schemeId: string): Promise<void> => {
    return window.electron.appTheme.setColorScheme(schemeId);
  },

  setCustomSchemes: (schemesJson: string): Promise<void> => {
    return window.electron.appTheme.setCustomSchemes(schemesJson);
  },

  importTheme: () => {
    return window.electron.appTheme.importTheme();
  },
} as const;
