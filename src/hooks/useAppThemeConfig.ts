import { useEffect } from "react";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { logError } from "@/utils/logger";
import { normalizeAccentHex, normalizeAppColorScheme } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";
import type { ColorVisionMode } from "@shared/types";

const VALID_COLOR_VISION_MODES: ColorVisionMode[] = ["default", "red-green", "blue-yellow"];

export function useAppThemeConfig() {
  const setSelectedSchemeIdSilent = useAppThemeStore((state) => state.setSelectedSchemeIdSilent);
  const addCustomScheme = useAppThemeStore((state) => state.addCustomScheme);
  const setColorVisionMode = useAppThemeStore((state) => state.setColorVisionMode);
  const setFollowSystem = useAppThemeStore((state) => state.setFollowSystem);
  const setPreferredDarkSchemeId = useAppThemeStore((state) => state.setPreferredDarkSchemeId);
  const setPreferredLightSchemeId = useAppThemeStore((state) => state.setPreferredLightSchemeId);
  const setRecentSchemeIds = useAppThemeStore((state) => state.setRecentSchemeIds);

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

        // Seed accent override before scheme injection so the first injection
        // already reflects the persisted override. Use the raw Zustand setter
        // (not setAccentColorOverride) to avoid a redundant DOM inject — the
        // subsequent setSelectedSchemeIdSilent call below performs it once.
        const normalizedAccent = normalizeAccentHex(config.accentColorOverride);
        if (normalizedAccent || config.accentColorOverride === null) {
          useAppThemeStore.setState({ accentColorOverride: normalizedAccent });
        }

        if (typeof config.colorSchemeId === "string" && config.colorSchemeId.trim()) {
          setSelectedSchemeIdSilent(config.colorSchemeId.trim());
        }

        if (Array.isArray(config.recentSchemeIds)) {
          const sanitized = config.recentSchemeIds
            .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim())
            .slice(0, 5);
          setRecentSchemeIds(sanitized);
        }

        if (
          typeof config.colorVisionMode === "string" &&
          VALID_COLOR_VISION_MODES.includes(config.colorVisionMode as ColorVisionMode)
        ) {
          setColorVisionMode(config.colorVisionMode as ColorVisionMode);
        }

        if (typeof config.followSystem === "boolean") {
          setFollowSystem(config.followSystem);
        }
        if (
          typeof config.preferredDarkSchemeId === "string" &&
          config.preferredDarkSchemeId.trim()
        ) {
          setPreferredDarkSchemeId(config.preferredDarkSchemeId.trim());
        }
        if (
          typeof config.preferredLightSchemeId === "string" &&
          config.preferredLightSchemeId.trim()
        ) {
          setPreferredLightSchemeId(config.preferredLightSchemeId.trim());
        }
      })
      .catch((error) => {
        logError("Failed to load app theme config", error);
      });

    return () => {
      cancelled = true;
    };
  }, [
    setSelectedSchemeIdSilent,
    addCustomScheme,
    setColorVisionMode,
    setFollowSystem,
    setPreferredDarkSchemeId,
    setPreferredLightSchemeId,
    setRecentSchemeIds,
  ]);

  useEffect(() => {
    return window.electron.appTheme.onSystemAppearanceChanged(({ schemeId }) => {
      // OS-driven follow-system changes must not populate the recently-used list
      setSelectedSchemeIdSilent(schemeId);
    });
  }, [setSelectedSchemeIdSilent]);
}
