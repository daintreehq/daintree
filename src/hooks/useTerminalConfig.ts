import { useEffect } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useTerminalFontStore } from "@/store";
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
  const customSchemes = useTerminalColorSchemeStore((state) => state.customSchemes);
  const setSelectedSchemeId = useTerminalColorSchemeStore((state) => state.setSelectedSchemeId);
  const addCustomScheme = useTerminalColorSchemeStore((state) => state.addCustomScheme);

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
          setSelectedSchemeId(config.colorSchemeId);
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
      })
      .catch((error) => {
        console.error("Failed to load terminal config:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setFontSize, setFontFamily, setSelectedSchemeId, addCustomScheme]);

  const colorVisionMode = useAppThemeStore((state) => state.colorVisionMode);

  useEffect(() => {
    const theme = useTerminalColorSchemeStore.getState().getEffectiveTheme();
    terminalInstanceService.applyGlobalOptions({
      theme,
      fontSize,
      fontFamily,
    });
    // customSchemes in deps ensures re-run when a custom scheme is added/changed
    // colorVisionMode in deps ensures terminal ANSI colors update when CVD mode changes
  }, [selectedSchemeId, customSchemes, fontSize, fontFamily, colorVisionMode]);
}
