import { useEffect } from "react";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { normalizeAppColorScheme } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";
import type { ColorVisionMode } from "@shared/types";

const VALID_COLOR_VISION_MODES: ColorVisionMode[] = ["default", "red-green", "blue-yellow"];

export function useAppThemeConfig() {
  const setSelectedSchemeId = useAppThemeStore((state) => state.setSelectedSchemeId);
  const addCustomScheme = useAppThemeStore((state) => state.addCustomScheme);
  const setColorVisionMode = useAppThemeStore((state) => state.setColorVisionMode);

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
                addCustomScheme(normalizeAppColorScheme(scheme as AppColorScheme));
              }
            }
          } catch {
            // ignore malformed custom schemes
          }
        }

        if (typeof config.colorSchemeId === "string" && config.colorSchemeId.trim()) {
          setSelectedSchemeId(config.colorSchemeId.trim());
        }

        if (
          typeof config.colorVisionMode === "string" &&
          VALID_COLOR_VISION_MODES.includes(config.colorVisionMode as ColorVisionMode)
        ) {
          setColorVisionMode(config.colorVisionMode as ColorVisionMode);
        }
      })
      .catch((error) => {
        console.error("Failed to load app theme config:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setSelectedSchemeId, addCustomScheme, setColorVisionMode]);
}
