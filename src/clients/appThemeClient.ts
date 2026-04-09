import type { AppThemeConfig, AppColorScheme, ColorVisionMode } from "@shared/types";

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

  exportTheme: (scheme: AppColorScheme): Promise<boolean> => {
    return window.electron.appTheme.exportTheme(scheme);
  },

  setColorVisionMode: (mode: ColorVisionMode): Promise<void> => {
    return window.electron.appTheme.setColorVisionMode(mode);
  },

  setFollowSystem: (enabled: boolean): Promise<void> => {
    return window.electron.appTheme.setFollowSystem(enabled);
  },

  setPreferredDarkScheme: (schemeId: string): Promise<void> => {
    return window.electron.appTheme.setPreferredDarkScheme(schemeId);
  },

  setPreferredLightScheme: (schemeId: string): Promise<void> => {
    return window.electron.appTheme.setPreferredLightScheme(schemeId);
  },

  setRecentSchemeIds: (ids: string[]): Promise<void> => {
    return window.electron.appTheme.setRecentSchemeIds(ids);
  },
} as const;
