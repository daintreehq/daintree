import { useEffect, useRef } from "react";
import { githubClient } from "@/clients/githubClient";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import type { GitHubTokenHealthPayload } from "@shared/types";

/**
 * Subscribes to main-process GitHub token health state pushes and writes the
 * unhealthy flag to a thin Zustand store. The renderer surfaces the state via
 * `<GitHubTokenBanner />`, which is a persistent inline banner — toasts were a
 * poor fit for state that persists until the user reconnects.
 */
export function useGitHubTokenHealth(): void {
  const hasInboxedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const apply = (payload: GitHubTokenHealthPayload) => {
      if (cancelled) return;

      const isUnhealthy = payload.status === "unhealthy";
      const wasUnhealthy = useGitHubTokenHealthStore.getState().isUnhealthy;
      useGitHubTokenHealthStore.getState().setUnhealthy(isUnhealthy);

      if (isUnhealthy && !wasUnhealthy && !hasInboxedRef.current) {
        hasInboxedRef.current = true;
        useNotificationHistoryStore.getState().addEntry({
          type: "warning",
          title: "GitHub token expired",
          message: "GitHub token expired — reconnect to restore GitHub features.",
          correlationId: "github-token-health",
          countable: false,
        });
      }

      if (!isUnhealthy) {
        hasInboxedRef.current = false;
      }
    };

    const cleanup = githubClient.onTokenHealthChanged(apply);

    // Replay current state on mount so secondary windows / late mounts see the
    // unhealthy flag without waiting for a transition.
    void githubClient
      .getTokenHealth()
      .then(apply)
      .catch(() => {
        // Initial-state fetch is best-effort; transitions still work.
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
}
