import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import { useAppThemeStore } from "@/store/appThemeStore";

export function useActiveAppScheme(): AppColorScheme {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const previewSchemeId = useAppThemeStore((s) => s.previewSchemeId);
  const customSchemes = useAppThemeStore((s) => s.customSchemes);
  return resolveAppTheme(previewSchemeId ?? selectedSchemeId, customSchemes);
}
