import { useEffect } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { logError } from "@/utils/logger";
import { useTerminalFontStore, useScreenReaderStore } from "@/store";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";
import { terminalConfigClient } from "@/clients/terminalConfigClient";

/**
 * Syncs global terminal config to singleton service.
 * Terminals live outside React, so they don't receive prop updates automatically.
 */
export function useTerminalConfig() {
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);
  const setFontSize = useTerminalFontStore((state) => state.setFontSize);
  const setFontFamily = useTerminalFontStore((state) => state.setFontFamily);

  const selectedSchemeId = useTerminalColorSchemeStore((state) => state.selectedSchemeId);
  const previewSchemeId = useTerminalColorSchemeStore((state) => state.previewSchemeId);
  const customSchemes = useTerminalColorSchemeStore((state) => state.customSchemes);
  const addCustomScheme = useTerminalColorSchemeStore((state) => state.addCustomScheme);
  const setRecentSchemeIds = useTerminalColorSchemeStore((state) => state.setRecentSchemeIds);

  useEffect(() => {
    let cancelled = false;

    terminalConfigClient
      .get()
      .then((config) => {
        if (cancelled) return;
        if (typeof config.fontSize === "number" && Number.isFinite(config.fontSize)) {
          setFontSize(config.fontSize);
        }
        if (typeof config.fontFamily === "string" && config.fontFamily.trim()) {
          setFontFamily(config.fontFamily);
        }
        if (typeof config.colorSchemeId === "string" && config.colorSchemeId.trim()) {
          // Hydrate directly to avoid polluting the recently-used list on startup
          useTerminalColorSchemeStore.setState({ selectedSchemeId: config.colorSchemeId.trim() });
        }
        if (typeof config.customSchemes === "string" && config.customSchemes.trim()) {
          try {
            const schemes = JSON.parse(config.customSchemes);
            if (Array.isArray(schemes)) {
              for (const scheme of schemes) {
                addCustomScheme(scheme);
              }
            }
          } catch {
            // ignore malformed custom schemes
          }
        }
        if (Array.isArray(config.recentSchemeIds)) {
          const sanitized = config.recentSchemeIds
            .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim())
            .slice(0, 5);
          setRecentSchemeIds(sanitized);
        }
      })
      .catch((error) => {
        logError("Failed to load terminal config", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setFontSize, setFontFamily, addCustomScheme, setRecentSchemeIds]);

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
      .catch(() => {});

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
  const appThemeId = useAppThemeStore((state) => state.selectedSchemeId);
  const appPreviewSchemeId = useAppThemeStore((state) => state.previewSchemeId);

  useEffect(() => {
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    terminalInstanceService.applyGlobalOptions({
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
