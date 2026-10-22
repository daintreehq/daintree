import { resolveAppTheme, type AppColorScheme } from "@shared/theme";
import { resolveCommittedScheme, useAppThemeStore } from "@/store/appThemeStore";
import { selectSelectableSchemes } from "@/theme/selectableSchemes";

export function useActiveAppScheme(): AppColorScheme {
  const previewSchemeId = useAppThemeStore((s) => s.previewSchemeId);
  const selectableSchemes = useAppThemeStore(selectSelectableSchemes);
  // The theme on screen: a preview, else this project's own theme or the global one.
  const committed = useAppThemeStore(resolveCommittedScheme);
  return previewSchemeId !== null ? resolveAppTheme(previewSchemeId, selectableSchemes) : committed;
}
