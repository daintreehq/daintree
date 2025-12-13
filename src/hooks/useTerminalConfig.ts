import { useEffect, useMemo } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getTerminalThemeFromCSS } from "@/components/Terminal/XtermAdapter";
import { useTerminalFontStore } from "@/store";
import { terminalConfigClient } from "@/clients/terminalConfigClient";

/**
 * Syncs global terminal config to singleton service.
 * Terminals live outside React, so they don't receive prop updates automatically.
 */
export function useTerminalConfig() {
  const theme = useMemo(() => getTerminalThemeFromCSS(), []);
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const fontFamily = useTerminalFontStore((state) => state.fontFamily);
  const setFontSize = useTerminalFontStore((state) => state.setFontSize);
  const setFontFamily = useTerminalFontStore((state) => state.setFontFamily);

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
      })
      .catch((error) => {
        console.error("Failed to load terminal config:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setFontSize, setFontFamily]);

  useEffect(() => {
    terminalInstanceService.applyGlobalOptions({
      theme,
      fontSize,
      fontFamily,
    });
  }, [theme, fontSize, fontFamily]);
}
