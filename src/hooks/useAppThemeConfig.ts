import { useEffect } from "react";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { logError } from "@/utils/logger";
import { normalizeAccentHex, normalizeAppColorScheme } from "@shared/theme";
import type { AppColorScheme, AppThemeConfig } from "@shared/types/appTheme";
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

    const applyConfig = (config: AppThemeConfig) => {
      if (Array.isArray(config.customSchemes)) {
        for (const scheme of config.customSchemes) {
          addCustomScheme(normalizeAppColorScheme(scheme as AppColorScheme));
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
      if (typeof config.preferredDarkSchemeId === "string" && config.preferredDarkSchemeId.trim()) {
        setPreferredDarkSchemeId(config.preferredDarkSchemeId.trim());
      }
      if (
        typeof config.preferredLightSchemeId === "string" &&
        config.preferredLightSchemeId.trim()
      ) {
        setPreferredLightSchemeId(config.preferredLightSchemeId.trim());
      }
    };

    // Seed from the in-flight `app:boot` payload instead of firing a duplicate
    // `app-theme:get` round-trip. The live IPC remains the fallback for the
    // safe-boot {ok:false} path and for configs the main process leaves off
    // the payload (first-run defaulting, legacy customSchemes migration).
    void (async () => {
      try {
        const boot = await getSafeBootPromise();
        if (cancelled) return;
        const fromBoot = boot.ok ? (boot.result.appTheme as AppThemeConfig | undefined) : undefined;
        const config = fromBoot ?? (await appThemeClient.get());
        if (cancelled) return;
        applyConfig(config);
      } catch (error) {
        logError("Failed to load app theme config", error);
      }
    })();

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
      // OS-driven follow-system changes must not populate the recently-used list.
      // The app has already painted the outgoing theme, so crossfade rather than
      // cut — but without the directional wipe, which signals a deliberate pick.
      setSelectedSchemeIdSilent(schemeId, { crossfade: true });
    });
  }, [setSelectedSchemeIdSilent]);
}
