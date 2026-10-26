import { useEffect } from "react";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useTerminalFontStore, useScreenReaderStore } from "@/store";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { resolveCommittedScheme, useAppThemeStore } from "@/store/appThemeStore";

/**
 * Applies the terminal settings in this view's stores to every live terminal.
 * Terminals live outside React, so they don't receive prop updates
 * automatically. The stores themselves are kept current by
 * `initTerminalConfigSync`.
 */
export function useTerminalConfig() {
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);

  const selectedSchemeId = useTerminalColorSchemeStore((state) => state.selectedSchemeId);
  const previewSchemeId = useTerminalColorSchemeStore((state) => state.previewSchemeId);
  const customSchemes = useTerminalColorSchemeStore((state) => state.customSchemes);

  const screenReaderEnabled = useScreenReaderStore((s) => s.resolvedScreenReaderEnabled());

  useEffect(() => {
    let cancelled = false;

    window.electron.accessibility
      .getEnabled()
      .then((enabled) => {
        if (!cancelled) {
          useScreenReaderStore.getState().setOsAccessibilityEnabled(enabled);
        }
      })
      .catch((err) => {
        // Background probe — `onSupportChanged` will repopulate state when the
        // OS event fires. Falling through with the prior store value is fine.
        logWarn("Failed to read OS accessibility state", {
          error: formatErrorMessage(err, "Accessibility probe failed"),
        });
      });

    const cleanup = window.electron.accessibility.onSupportChanged(({ enabled }) => {
      if (!cancelled) {
        useScreenReaderStore.getState().setOsAccessibilityEnabled(enabled);
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const colorVisionMode = useAppThemeStore((state) => state.colorVisionMode);
  // The app theme on screen: the project's own when it has one.
  const appThemeId = useAppThemeStore((state) => resolveCommittedScheme(state).id);
  const appPreviewSchemeId = useAppThemeStore((state) => state.previewSchemeId);

  useEffect(() => {
    // The cached selector returns the same object XtermAdapter already applied,
    // so xterm dedups the set instead of recomputing the palette a second time.
    const theme = selectEffectiveTheme(useTerminalColorSchemeStore.getState());
    peekTerminalService()?.applyGlobalOptions({
      theme,
      fontSize,
      fontFamily,
      screenReaderMode: screenReaderEnabled,
    });
    // customSchemes in deps ensures re-run when a custom scheme is added/changed
    // colorVisionMode in deps ensures terminal ANSI colors update when CVD mode changes
    // appThemeId in deps ensures terminal updates when app theme changes while "daintree" is selected
    // appPreviewSchemeId in deps ensures terminal updates when app theme preview changes
    // screenReaderEnabled in deps ensures terminals update when screen reader mode changes
  }, [
    selectedSchemeId,
    previewSchemeId,
    customSchemes,
    fontSize,
    fontFamily,
    colorVisionMode,
    appThemeId,
    appPreviewSchemeId,
    screenReaderEnabled,
  ]);
}
