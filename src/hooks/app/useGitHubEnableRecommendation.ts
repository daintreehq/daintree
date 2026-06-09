import { useEffect, useRef } from "react";
import { useProjectStore } from "@/store/projectStore";
import { GITHUB_PLUGIN_ID } from "@/store/pluginRuntimeStore";
import { useNotificationStore } from "@/store/notificationStore";
import { notify } from "@/lib/notify";
import { isElectronAvailable } from "../useElectron";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { logError } from "@/utils/logger";

/**
 * Recommends enabling the GitHub plugin when the user opens a project whose
 * remotes point at github.com while the plugin is disabled. Recommendation
 * only — enabling is always the user's explicit click; a persisted disable is
 * never overridden automatically (the auto-enable alternative was rejected:
 * it resurrects a deliberately disabled integration behind the user's back).
 *
 * Evaluation runs on project switch, not on toggle: a user who just disabled
 * the plugin must not be immediately nudged to undo their own action. Fired
 * or dismissed projects are remembered for the session.
 */
const handledProjectPaths = new Set<string>();

/**
 * Extract the host from an HTTPS or scp-like SSH remote URL. Substring
 * matching is not enough — `git@notgithub.com:x/y.git` and path segments
 * containing `github.com/` must not count as GitHub remotes.
 */
function remoteHost(fetchUrl: string): string | null {
  const url = fetchUrl.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      return new URL(url).hostname.toLowerCase();
    }
  } catch {
    return null;
  }
  // scp-like SSH form: [user@]host:path
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(url);
  return scpMatch?.[1]?.toLowerCase() ?? null;
}

function hasGitHubRemote(remotes: Array<{ fetchUrl: string }>): boolean {
  return remotes.some((remote) => {
    const host = remoteHost(remote.fetchUrl);
    return host === "github.com" || host?.endsWith(".github.com") === true;
  });
}

export function useGitHubEnableRecommendation(isStateLoaded: boolean): void {
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
      // Query main directly rather than the pluginRuntimeStore snapshot — on
      // cold start the project can load before the store's first pull lands,
      // and a missed evaluation here never re-runs for this project. The
      // trigger stays the project switch; a mid-session toggle must not
      // re-run this.
      const plugins = await window.electron.plugin.list();
      if (cancelled) return;
      const githubRow = plugins.find((p) => p.manifest.name === GITHUB_PLUGIN_ID);
      if (!githubRow || !githubRow.disabled) return;

      let remotes: Array<{ fetchUrl: string }>;
      try {
        remotes = await window.electron.project.listRemotes(projectPath);
      } catch {
        return; // not a git repo / remotes unavailable — nothing to recommend
      }
      if (cancelled || !hasGitHubRemote(remotes)) return;

      handledProjectPaths.add(projectPath);

      const dismissSelf = (id: string | undefined) => {
        if (!id) return;
        removeNotification(id);
        notificationIdsRef.current.delete(id);
      };

      // Action closures reference `notificationId` after notify() returns —
      // safe because actions only fire on user click, never synchronously.
      const notificationId: string | undefined = notify({
        type: "info",
        placement: "grid-bar",
        title: "GitHub integration is off",
        message:
          "This repository is hosted on GitHub, but the GitHub plugin is disabled — issues, pull requests, and repo stats are unavailable.",
        inboxMessage:
          "This repository is hosted on GitHub, but the GitHub plugin is disabled — issues, pull requests, and repo stats are unavailable.",
        duration: 0,
        supersedeKey: `github-enable-recommendation:${projectPath}`,
        actions: [
          {
            label: "Enable GitHub",
            variant: "primary",
            onClick: () => {
              safeFireAndForget(window.electron.plugin.setEnabled(GITHUB_PLUGIN_ID, true), {
                context: "Enabling GitHub plugin from recommendation",
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
      logError("GitHub enable recommendation evaluation failed", err);
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
export function _resetGitHubEnableRecommendationForTest(): void {
  handledProjectPaths.clear();
}
