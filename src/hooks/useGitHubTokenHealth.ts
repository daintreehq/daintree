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
    let pushApplied = false;

    const apply = (payload: GitHubTokenHealthPayload, source: "push" | "replay") => {
      if (cancelled) return;
      // If a live push already updated state, ignore a stale initial-replay
      // response (the IPC race is rare but real — see review notes).
      if (source === "replay" && pushApplied) return;
      if (source === "push") pushApplied = true;

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

    const cleanup = githubClient.onTokenHealthChanged((payload) => apply(payload, "push"));

    // Replay current state on mount so secondary windows / late mounts see the
    // unhealthy flag without waiting for a transition.
    void githubClient
      .getTokenHealth()
      .then((payload) => apply(payload, "replay"))
      .catch(() => {
        // Initial-state fetch is best-effort; transitions still work.
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
}
