import { useEffect } from "react";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import type { AppColorScheme } from "@shared/types/appTheme";

export function useAppThemeConfig() {
  const setSelectedSchemeId = useAppThemeStore((state) => state.setSelectedSchemeId);
  const addCustomScheme = useAppThemeStore((state) => state.addCustomScheme);

  useEffect(() => {
    let cancelled = false;

    appThemeClient
      .get()
      .then((config) => {
        if (cancelled) return;

        if (typeof config.customSchemes === "string" && config.customSchemes.trim()) {
          try {
            const schemes = JSON.parse(config.customSchemes);
            if (Array.isArray(schemes)) {
              for (const scheme of schemes) {
                addCustomScheme(scheme as AppColorScheme);
              }
            }
          } catch {
            // ignore malformed custom schemes
          }
        }

        if (typeof config.colorSchemeId === "string" && config.colorSchemeId.trim()) {
          setSelectedSchemeId(config.colorSchemeId.trim());
        }
      })
      .catch((error) => {
        console.error("Failed to load app theme config:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setSelectedSchemeId, addCustomScheme]);
}
