import { useCallback, useEffect, useRef, useState } from "react";
import { codexClient } from "@/clients/codexClient";
import type { CodexQuotaProfile } from "@shared/types/ipc/agentQuota";
import { useVisibilityAwareInterval } from "./useVisibilityAwareInterval";

/** Re-read cadence while the quota is on screen. Main caches for 30s under this. */
export const CODEX_QUOTA_POLL_MS = 60_000;

/**
 * A failed read keeps the last good reading for the same profile instead of
 * replacing it: its `fetchedAt` keeps ageing, so the caller shows it as stale
 * rather than current, which says more than swapping a known value for
 * "unavailable". Matched by key, so a reading never moves to another home.
 */
export function mergeCodexQuotaProfiles(
  previous: CodexQuotaProfile[] | null,
  next: CodexQuotaProfile[]
): CodexQuotaProfile[] {
  if (!previous) return next;
  const lastGood = new Map(
    previous.filter((profile) => profile.result.status === "ok").map((p) => [p.key, p.result])
  );
  return next.map((profile) => {
    const kept = profile.result.status === "unavailable" ? lastGood.get(profile.key) : undefined;
    return kept ? { ...profile, result: kept } : profile;
  });
}

/**
 * Codex account quota, one entry per profile, while `enabled` (#12797,
 * #13686). Reads on mount and on reveal, then every minute while the view is
 * observable.
 */
export function useCodexQuota(enabled: boolean): {
  profiles: CodexQuotaProfile[] | null;
  refresh: () => void;
} {
  const [profiles, setProfiles] = useState<CodexQuotaProfile[] | null>(null);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);

  const load = useCallback((read: () => Promise<CodexQuotaProfile[]>) => {
    const request = ++requestRef.current;
    pendingRef.current = true;
    const settled = () => {
      if (request === requestRef.current) pendingRef.current = false;
    };
    read().then(
      (next) => {
        settled();
        if (request !== requestRef.current) return;
        setProfiles((previous) => mergeCodexQuotaProfiles(previous, next));
      },
      () => {
        settled();
        if (request !== requestRef.current) return;
        // Main never rejects a read, so this is the IPC itself failing. What's
        // on screen stays; with nothing yet, the default profile says so.
        setProfiles(
          (previous) =>
            previous ?? [
              {
                key: "default",
                isDefault: true,
                presetNames: [],
                result: { status: "unavailable", reason: "read-failed", fetchedAt: Date.now() },
              },
            ]
        );
      }
    );
  }, []);

  // Several profiles read one after another can outlast the poll interval; a
  // poll that superseded the batch would discard it, and the next would do the
  // same, so the section never filled in. Retry still supersedes.
  const poll = useCallback(() => {
    if (!pendingRef.current) load(codexClient.readQuota);
  }, [load]);
  const refresh = useCallback(() => load(codexClient.refreshQuota), [load]);

  useEffect(() => {
    if (!enabled) return;
    poll();
    const requests = requestRef;
    const pending = pendingRef;
    return () => {
      // Drop any answer still in flight: it belongs to a mount that's gone.
      requests.current++;
      pending.current = false;
    };
  }, [enabled, poll]);

  useVisibilityAwareInterval(poll, CODEX_QUOTA_POLL_MS, enabled);

  return { profiles: enabled ? profiles : null, refresh };
}
