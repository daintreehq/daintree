import { useCallback, useEffect, useRef, useState } from "react";
import { codexClient } from "@/clients/codexClient";
import { isElectronAvailable } from "./useElectron";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentState } from "@/types";
import type { CodexSubagentsResult } from "@shared/types/ipc/codexSubagents";

/**
 * Floor between automatic refreshes. Each one spawns a short-lived
 * `codex app-server`, so a terminal that flickers between states can't turn
 * into a spawn storm. Manual refresh bypasses it — the user asked.
 */
export const CODEX_SUBAGENT_REFRESH_THROTTLE_MS = 20_000;

/**
 * States where the parent has stopped producing output, so any subagent it
 * spawned has had a chance to be written to Codex's thread store.
 */
const SETTLED_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "idle",
  "waiting",
  "completed",
]);

export interface UseCodexSubagentsResult {
  result: CodexSubagentsResult | null;
  isLoading: boolean;
  refresh: () => void;
}

/**
 * Poll-free view of a Codex terminal's spawned subagents: one query on mount,
 * one whenever the parent settles, and one per manual refresh.
 */
export function useCodexSubagents(
  terminalId: string,
  options: { enabled: boolean; agentState?: AgentState }
): UseCodexSubagentsResult {
  const { enabled, agentState } = options;
  const [result, setResult] = useState<CodexSubagentsResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastFetchRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchSubagents = useCallback(
    (force: boolean) => {
      if (!enabled || !isElectronAvailable()) return;
      if (inFlightRef.current) return;
      const now = Date.now();
      if (!force && now - lastFetchRef.current < CODEX_SUBAGENT_REFRESH_THROTTLE_MS) return;
      inFlightRef.current = true;
      lastFetchRef.current = now;
      setIsLoading(true);
      void codexClient
        .listSubagents({ terminalId })
        .then((next) => {
          if (mountedRef.current) setResult(next);
        })
        .catch((error: unknown) => {
          logWarn(`[useCodexSubagents] list failed: ${formatErrorMessage(error, "unknown error")}`);
          if (mountedRef.current) setResult({ status: "unavailable", reason: "protocol-error" });
        })
        .finally(() => {
          inFlightRef.current = false;
          if (mountedRef.current) setIsLoading(false);
        });
    },
    [enabled, terminalId]
  );

  // First look. Forced so a freshly restored panel doesn't sit blank behind a
  // throttle window inherited from a previous mount.
  useEffect(() => {
    fetchSubagents(true);
  }, [fetchSubagents]);

  useEffect(() => {
    if (!agentState || !SETTLED_STATES.has(agentState)) return;
    fetchSubagents(false);
  }, [agentState, fetchSubagents]);

  const refresh = useCallback(() => fetchSubagents(true), [fetchSubagents]);

  return { result, isLoading, refresh };
}
