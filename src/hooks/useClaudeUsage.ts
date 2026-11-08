import { useCallback, useEffect, useRef, useState } from "react";
import { claudeClient } from "@/clients/claudeClient";
import type { ClaudeUsageAccount } from "@shared/types/ipc/agentQuota";
import { useVisibilityAwareInterval } from "./useVisibilityAwareInterval";

/** Re-read cadence while the readings are on screen; main answers from memory. */
export const CLAUDE_USAGE_POLL_MS = 60_000;

/**
 * What Claude Code panes showed about usage, per login (#16370), while
 * `enabled`. Reads on mount and on reveal, then every minute while the view is
 * observable. A failed read keeps what's on screen and sets `failed`.
 */
export function useClaudeUsage(enabled: boolean): {
  accounts: ClaudeUsageAccount[] | null;
  failed: boolean;
  refresh: () => void;
} {
  const [accounts, setAccounts] = useState<ClaudeUsageAccount[] | null>(null);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);

  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    pendingRef.current = true;
    const settle = (apply: () => void) => {
      if (request !== requestRef.current) return;
      pendingRef.current = false;
      apply();
    };
    claudeClient.readUsage().then(
      (next) =>
        settle(() => {
          setAccounts(next);
          setFailed(false);
        }),
      () => settle(() => setFailed(true))
    );
  }, []);

  // A read slower than the interval would otherwise be superseded by every
  // tick and never land. Retry still supersedes.
  const poll = useCallback(() => {
    if (!pendingRef.current) refresh();
  }, [refresh]);

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

  useVisibilityAwareInterval(poll, CLAUDE_USAGE_POLL_MS, enabled);

  return { accounts: enabled ? accounts : null, failed: enabled && failed, refresh };
}
