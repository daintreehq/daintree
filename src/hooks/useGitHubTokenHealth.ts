import { useEffect, useRef } from "react";
import { githubClient } from "@/clients/githubClient";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * Subscribes to main-process GitHub token health state pushes and surfaces a
 * non-blocking "Reconnect to GitHub" notification when the background probe
 * detects a 401. Dismisses the notification automatically when the token is
 * restored to a healthy state.
 *
 * The main-process service is the source of truth for state; this hook
 * simply reflects transitions into the shared notification store.
 */
export function useGitHubTokenHealth(): void {
  const notificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    const cleanup = githubClient.onTokenHealthChanged((payload) => {
      const store = useNotificationStore.getState();

      if (payload.status === "unhealthy") {
        // Coalesce: if we already have a live notification, refresh it rather
        // than stacking a duplicate. We key on the notification id returned
        // from the first `addNotification` because the store has no built-in
        // correlationId-based dedup.
        const existing = notificationIdRef.current
          ? store.notifications.find((n) => n.id === notificationIdRef.current)
          : undefined;

        if (existing && !existing.dismissed) {
          return;
        }

        const id = store.addNotification({
          type: "warning",
          priority: "high",
          title: "GitHub token expired",
          message:
            "Your GitHub personal access token is no longer valid. Reconnect to restore issue, PR, and project-health data.",
          inboxMessage: "GitHub token expired — reconnect to restore GitHub features.",
          correlationId: "github-token-health",
          duration: 0,
          action: {
            label: "Reconnect to GitHub",
            onClick: () => {
              window.dispatchEvent(
                new CustomEvent("daintree:open-settings-tab", { detail: { tab: "github" } })
              );
            },
          },
        });
        notificationIdRef.current = id;
        return;
      }

      if (payload.status === "healthy" || payload.status === "unknown") {
        const id = notificationIdRef.current;
        if (id) {
          store.dismissNotification(id);
          notificationIdRef.current = null;
        }
      }
    });

    return cleanup;
  }, []);
}
