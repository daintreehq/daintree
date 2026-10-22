import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import { useAppThemeStore } from "@/store/appThemeStore";
import { selectSelectableSchemes } from "@/theme/selectableSchemes";

export function useActiveAppScheme(): AppColorScheme {
  const selectedSchemeId = useAppThemeStore((s) => s.selectedSchemeId);
  const previewSchemeId = useAppThemeStore((s) => s.previewSchemeId);
  const selectableSchemes = useAppThemeStore(selectSelectableSchemes);
  return resolveAppTheme(previewSchemeId ?? selectedSchemeId, selectableSchemes);
}
