import { useEffect, useRef } from "react";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { getSafeBootPromise } from "@/lib/bootPromise";
import { logError } from "@/utils/logger";
import { systemPrefersDark } from "@/theme/applyAppTheme";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  getAppThemeFallbackType,
  normalizeAccentHex,
  normalizeAppColorScheme,
  readPluginThemeSnapshot,
  readProjectThemeChoice,
} from "@shared/theme";
import type { AppColorScheme, AppThemeConfig } from "@shared/types/appTheme";
import type { ColorVisionMode } from "@shared/types";

const VALID_COLOR_VISION_MODES: ColorVisionMode[] = ["default", "red-green", "blue-yellow"];
const PROJECT_THEME_READ_RETRY_MS = [250, 1000, 3000] as const;

export function useAppThemeConfig() {
  const setSelectedSchemeIdSilent = useAppThemeStore((state) => state.setSelectedSchemeIdSilent);
  const addCustomScheme = useAppThemeStore((state) => state.addCustomScheme);
  const setColorVisionMode = useAppThemeStore((state) => state.setColorVisionMode);
  const setFollowSystem = useAppThemeStore((state) => state.setFollowSystem);
  const setPreferredDarkSchemeId = useAppThemeStore((state) => state.setPreferredDarkSchemeId);
  const setPreferredLightSchemeId = useAppThemeStore((state) => state.setPreferredLightSchemeId);
  const setRecentSchemeIds = useAppThemeStore((state) => state.setRecentSchemeIds);
  const setProjectTheme = useAppThemeStore((state) => state.setProjectTheme);
  // Set once main has said what this view's project shows since boot — a push,
  // or the read taken after subscribing. The boot payload is older than either.
  const projectThemeLiveRef = useRef(false);

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

      // Before the selection, which it may name: a selected plugin theme paints
      // from its persisted snapshot until its plugin has loaded (#13832).
      useAppThemeStore.setState({ pluginSnapshotScheme: readPluginThemeSnapshot(config) });

      // Also before the selection, so a project with its own theme (#13833)
      // paints it in the same frame rather than the global one first.
      if (!projectThemeLiveRef.current) {
        setProjectTheme(readProjectThemeChoice(config, getViewWorkspaceId()));
      }

      if (typeof config.colorSchemeId === "string" && config.colorSchemeId.trim()) {
        const schemeId = config.colorSchemeId.trim();
        setSelectedSchemeIdSilent(schemeId, {
          fallbackType: getAppThemeFallbackType(schemeId, config, systemPrefersDark()),
        });
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
    setProjectTheme,
  ]);

  useEffect(() => {
    const projectTheme = window.electron?.projectTheme;
    if (!projectTheme?.onChanged) return;
    let disposed = false;
    let pushed = false;
    const unsubscribe = projectTheme.onChanged(({ projectId, choice }) => {
      // Main sends it to every view of the project; anything else is not ours.
      if (projectId !== getViewWorkspaceId()) return;
      pushed = true;
      projectThemeLiveRef.current = true;
      // The outgoing theme is on screen, so fade rather than cut.
      setProjectTheme(choice, { crossfade: true });
    });
    // A change another window made between the boot payload and this
    // subscription reached no push, so read once more now that one would. A
    // relaunch restores the project before main has registered this view, so
    // a read that comes back unbound tries again a few times.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const read = (attempt: number): void => {
      if (typeof projectTheme.get !== "function") return;
      projectTheme
        .get()
        .then((snapshot) => {
          if (disposed || pushed) return;
          if (!snapshot) {
            const delay = PROJECT_THEME_READ_RETRY_MS[attempt];
            if (delay !== undefined) retryTimer = setTimeout(() => read(attempt + 1), delay);
            return;
          }
          if (snapshot.projectId !== getViewWorkspaceId()) return;
          projectThemeLiveRef.current = true;
          setProjectTheme(snapshot.choice, { crossfade: true });
        })
        .catch((error: unknown) => {
          logError("Failed to read the project theme", error);
        });
    };
    read(0);
    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [setProjectTheme]);

  useEffect(() => {
    return window.electron.appTheme.onSystemAppearanceChanged(({ isDark, schemeId }) => {
      // OS-driven follow-system changes must not populate the recently-used list.
      // The app has already painted the outgoing theme, so crossfade rather than
      // cut — but without the directional wipe, which signals a deliberate pick.
      setSelectedSchemeIdSilent(schemeId, {
        crossfade: true,
        fallbackType: isDark ? "dark" : "light",
      });
    });
  }, [setSelectedSchemeIdSilent]);
}
