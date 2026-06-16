import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "../useElectron";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { logError } from "@/utils/logger";
import { matchProviderForRemoteUrl, type ForgeProviderMatcher } from "@shared/utils/forgeHostnames";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";

/**
 * Recommends enabling a forge plugin when the user opens a project whose
 * remotes match a DISABLED plugin's `forgeProviders` hostname patterns.
 * Recommendation only — enabling is always the user's explicit click; a
 * persisted disable is never overridden automatically (the auto-enable
 * alternative was rejected: it resurrects a deliberately disabled integration
 * behind the user's back).
 *
 * Evaluation runs on project switch, not on toggle: a user who just disabled
 * a plugin must not be immediately nudged to undo their own action. Fired
 * or dismissed projects are remembered across sessions: the in-memory set is
 * the fast path, seeded once from electron-store so the nudge doesn't reappear
 * on every launch.
 */
const handledProjectPaths = new Set<string>();

/**
 * Seeds `handledProjectPaths` from persisted dismissals. Memoized so the IPC
 * round-trip happens once per session regardless of how many hook instances
 * mount; best-effort — failure falls back to per-session memory only.
 */
let dismissedHydration: Promise<void> | null = null;
function hydrateDismissedPaths(): Promise<void> {
  if (!dismissedHydration) {
    dismissedHydration = window.electron.forgeRecommendation
      .getDismissed()
      .then((dismissed) => {
        for (const path of Object.keys(dismissed)) {
          handledProjectPaths.add(path);
        }
      })
      .catch(() => {});
  }
  return dismissedHydration;
}

interface DisabledProviderMatch {
  pluginId: string;
  /** Plugin display name used in the enable CTA. */
  displayName: string;
  /** Provider (forge) name used in the explanatory copy. */
  providerName: string;
}

interface DisabledPluginRow {
  manifest: {
    name: string;
    displayName?: string;
    contributes?: {
      forgeProviders?: Array<{ id: string; name: string; matches?: string[] }>;
    };
  };
  disabled: boolean;
}

/**
 * Collect hostname matchers for every DISABLED plugin's `forgeProviders`
 * contributions. The live forge registry only carries loaded providers, so
 * disabled plugins are matched from their installed manifests instead.
 */
function collectDisabledMatchers(plugins: DisabledPluginRow[]): {
  matchers: ForgeProviderMatcher[];
  metaByProviderId: Map<string, DisabledProviderMatch>;
} {
  const matchers: ForgeProviderMatcher[] = [];
  const metaByProviderId = new Map<string, DisabledProviderMatch>();
  for (const row of plugins) {
    if (!row.disabled) continue;
    for (const contribution of row.manifest.contributes?.forgeProviders ?? []) {
      const providerId = makeForgeProviderId(row.manifest.name, contribution.id);
      matchers.push({ providerId, hostnames: contribution.matches ?? [] });
      metaByProviderId.set(providerId, {
        pluginId: row.manifest.name,
        displayName: row.manifest.displayName ?? contribution.name,
        providerName: contribution.name,
      });
    }
  }
  return { matchers, metaByProviderId };
}

export function useForgeEnableRecommendation(isStateLoaded: boolean): void {
  const currentProjectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  // All notification ids created by this hook instance. Project switches can
  // leave an earlier project's recommendation visible while a new one fires —
  // each action closure must remove ITS notification (not a shared "latest"
  // ref, which would let project A's "Not now" dismiss project B's nudge),
  // and unmount cleanup sweeps whatever remains.
  const notificationIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded || !currentProjectPath) return;
    if (handledProjectPaths.has(currentProjectPath)) return;

    let cancelled = false;

    async function evaluate(projectPath: string) {
      // Seed from persisted dismissals before evaluating so a recommendation
      // dismissed in a previous session doesn't re-fire while hydration is
      // still in flight on cold start.
      await hydrateDismissedPaths();
      if (cancelled) return;
      if (handledProjectPaths.has(projectPath)) return;

      // Query main directly rather than the pluginRuntimeStore snapshot — on
      // cold start the project can load before the store's first pull lands,
      // and a missed evaluation here never re-runs for this project. The
      // trigger stays the project switch; a mid-session toggle must not
      // re-run this.
      const plugins = await window.electron.plugin.list();
      if (cancelled) return;
      const { matchers, metaByProviderId } = collectDisabledMatchers(plugins);
      if (matchers.length === 0) return;

      let remotes: Array<{ fetchUrl: string }>;
      try {
        remotes = await window.electron.project.listRemotes(projectPath);
      } catch {
        return; // not a git repo / remotes unavailable — nothing to recommend
      }
      if (cancelled) return;

      let match: DisabledProviderMatch | null = null;
      for (const remote of remotes) {
        const providerId = matchProviderForRemoteUrl(remote.fetchUrl, matchers);
        if (providerId) {
          match = metaByProviderId.get(providerId) ?? null;
          if (match) break;
        }
      }
      if (!match) return;
      const { pluginId, displayName, providerName } = match;

      handledProjectPaths.add(projectPath);
      // Persist at the same point as the in-memory guard so the nudge stays
      // suppressed across restarts (mirrors session behaviour exactly — a
      // project that showed the recommendation won't show it again).
      safeFireAndForget(window.electron.forgeRecommendation.markDismissed(projectPath), {
        context: "Persisting forge enable recommendation dismissal",
      });

      const dismissSelf = (id: string | undefined) => {
        if (!id) return;
        removeNotification(id);
        notificationIdsRef.current.delete(id);
      };

      const body = `This repository is hosted on ${providerName}, but the ${displayName} plugin is disabled — issues, pull requests, and repo stats are unavailable.`;

      // Action closures reference `notificationId` after notify() returns —
      // safe because actions only fire on user click, never synchronously.
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      const notificationId: string | undefined = notify({
        type: "info",
        placement: "grid-bar",
        title: `${providerName} integration is off`,
        message: body,
        inboxMessage: body,
        duration: 0,
        supersedeKey: `forge-enable-recommendation:${pluginId}:${projectPath}`,
        actions: [
          {
            label: `Enable ${displayName}`,
            variant: "primary",
            onClick: () => {
              safeFireAndForget(window.electron.plugin.setEnabled(pluginId, true), {
                context: `Enabling ${displayName} plugin from recommendation`,
              });
              dismissSelf(notificationId);
            },
          },
          {
            label: "Not now",
            variant: "secondary",
            onClick: () => dismissSelf(notificationId),
          },
        ],
      });
      if (notificationId) notificationIdsRef.current.add(notificationId);
    }

    evaluate(currentProjectPath).catch((err) => {
      logError("Forge enable recommendation evaluation failed", err);
    });

    return () => {
      cancelled = true;
    };
  }, [isStateLoaded, currentProjectPath, removeNotification]);

  useEffect(() => {
    const ids = notificationIdsRef.current;
    return () => {
      for (const id of ids) {
        removeNotification(id);
      }
      ids.clear();
    };
  }, [removeNotification]);
}

/** Test-only: reset the per-session fired/dismissed project memory. */
export function _resetForgeEnableRecommendationForTest(): void {
  handledProjectPaths.clear();
  dismissedHydration = null;
}
