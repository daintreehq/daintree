import { useEffect, useRef } from "react";
// eslint-disable-next-line no-restricted-imports
import { githubClient } from "@/clients/githubClient";
import { notify } from "@/lib/notify";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
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
        // Inbox-only backstop (priority "low" → no toast) for the no-project
        // case where the toolbar's `useGitHubTokenExpiryNotification` isn't
        // mounted. Shares `supersedeKey` with that hook so whichever fires
        // second archives the first — one active row per token-expiry event.
        // No `correlationId`: it would only thread this row so that a second
        // expiry cycle (after the toolbar archived the first row) re-promotes
        // the backstop into an unwanted toast via the un-snooze re-toast path.
        // The supersede dedup runs on `supersedeKey` alone.
        notify({
          type: "warning",
          priority: "low",
          title: "GitHub token expired",
          message: "GitHub token expired — reconnect to restore GitHub features.",
          supersedeKey: "github.token",
          countable: false,
          context: { eventKind: "connectivity" },
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
