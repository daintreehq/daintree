import { useEffect } from "react";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "../utils/performance";
import { useHibernationNotifications } from "../hooks/useHibernationNotifications";
import { useIdleTerminalNotifications } from "../hooks/useIdleTerminalNotifications";
import { useDiskSpaceWarnings } from "../hooks/useDiskSpaceWarnings";
import { useGitHubTokenHealth } from "../hooks/useGitHubTokenHealth";
import { useGitHubRateLimit } from "../hooks/useGitHubRateLimit";
import { useStoreUpdateListener } from "../hooks/useStoreUpdateListener";
import { useSoundPlaybackListener } from "../hooks/useSoundPlaybackListener";
import { useRecipeFocusReload, useWorktreeDevServerStateSync } from "../hooks/app";

/**
 * Hosts the listener hooks that only do meaningful work after app state has
 * hydrated. `AppInner` renders this behind `{isStateLoaded && ...}`, so these
 * hooks never run in the first commit and their effects stay out of the first
 * effect flush — keeping early input responsive (#9769).
 *
 * Every hook here was audited to tolerate a late mount: the notification hooks
 * carry module-scope re-attach guards, the GitHub/store hooks pull current
 * state on mount, and the rest are poll-backed or react to events that cannot
 * fire before the window is interactive. Hooks that must subscribe before first
 * paint (focus-intent, OS DND, plugin deep-link, keybindings, action registry,
 * MCP/plugin bridges) deliberately stay in `AppInner`.
 */
export function PostHydrationListeners() {
  useHibernationNotifications();
  useIdleTerminalNotifications();
  useDiskSpaceWarnings();
  useGitHubTokenHealth();
  useGitHubRateLimit();
  useRecipeFocusReload();
  useWorktreeDevServerStateSync();
  useSoundPlaybackListener();
  useStoreUpdateListener();

  useEffect(() => {
    markRendererPerformance(PERF_MARKS.POST_HYDRATION_LISTENERS_MOUNT);
  }, []);

  return null;
}
