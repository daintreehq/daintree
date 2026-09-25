import { useCallback, useEffect, useRef, useState } from "react";
import { codexClient } from "@/clients/codexClient";
import type { CodexQuotaResult } from "@shared/types/ipc/agentQuota";
import { useVisibilityAwareInterval } from "./useVisibilityAwareInterval";

/** Re-read cadence while the quota is on screen. Main caches for 30s under this. */
export const CODEX_QUOTA_POLL_MS = 60_000;

/**
 * Codex account quota while `enabled` (#12797). Reads on mount and on reveal,
 * then every minute while the view is observable.
 *
 * A failed refresh keeps the last good reading instead of replacing it: its
 * `fetchedAt` keeps ageing, so the caller shows it as stale rather than current,
 * which says more than swapping a known value for "unavailable".
 */
export function useCodexQuota(enabled: boolean): {
  result: CodexQuotaResult | null;
  refresh: () => void;
} {
  const [result, setResult] = useState<CodexQuotaResult | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    const settle = (next: CodexQuotaResult) => {
      if (request !== requestRef.current) return;
      setResult((previous) =>
        next.status === "unavailable" && previous?.status === "ok" ? previous : next
      );
    };
    codexClient
      .readQuota()
      .then(settle, () =>
        settle({ status: "unavailable", reason: "read-failed", fetchedAt: Date.now() })
      );
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const requests = requestRef;
    return () => {
      // Drop any answer still in flight: it belongs to a mount that's gone.
      requests.current++;
    };
  }, [enabled, refresh]);

  useVisibilityAwareInterval(refresh, CODEX_QUOTA_POLL_MS, enabled);

  return { result: enabled ? result : null, refresh };
}
