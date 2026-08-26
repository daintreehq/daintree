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
 * Last answer per terminal, outliving the hook instance on purpose. Refs reset
 * on every remount, and a project restore or hibernate/wake remounts every pane
 * at once — a per-instance throttle would let that burst re-spawn a process per
 * terminal. Keeping the result alongside the timestamp also means a remount
 * inside the throttle window rehydrates instantly instead of showing nothing
 * until the window expires.
 */
interface CachedLookup {
  at: number;
  result: CodexSubagentsResult;
}

const lookupCache = new Map<string, CachedLookup>();
/** Terminal keys with a request in flight, shared across hook instances. */
const inFlightKeys = new Set<string>();

/** Hard bound on the cache — a long session cycles through many terminals. */
const MAX_CACHED_TERMINALS = 64;

/**
 * A reused panel id is not the same session. Folding the PTY's start time into
 * the key means a respawned terminal looks up its own subagents instead of
 * adopting the answer for the process that used to live there.
 */
function cacheKey(terminalId: string, generation: number | undefined): string {
  return `${terminalId}:${generation ?? 0}`;
}

function rememberLookup(key: string, result: CodexSubagentsResult, at: number): void {
  lookupCache.set(key, { at, result });
  if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
  // Expired entries first — they would be refetched anyway — then oldest-first
  // until the cap actually holds, since every entry can be fresh at once.
  for (const [entryKey, entry] of lookupCache) {
    if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
    if (at - entry.at > CODEX_SUBAGENT_REFRESH_THROTTLE_MS) lookupCache.delete(entryKey);
  }
  for (const entryKey of lookupCache.keys()) {
    if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
    lookupCache.delete(entryKey);
  }
}

/**
 * Poll-free view of a Codex terminal's spawned subagents: one query on mount,
 * one whenever the parent settles, and one per manual refresh.
 */
export function useCodexSubagents(
  terminalId: string,
  options: { enabled: boolean; agentState?: AgentState; generation?: number }
): UseCodexSubagentsResult {
  const { enabled, agentState, generation } = options;
  const key = cacheKey(terminalId, generation);
  const [result, setResult] = useState<CodexSubagentsResult | null>(
    () => lookupCache.get(key)?.result ?? null
  );
  const [isLoading, setIsLoading] = useState(false);
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
      // Module-scoped, so two panes remounting the same terminal at once issue
      // one lookup rather than one each.
      if (inFlightKeys.has(key)) return;
      const now = Date.now();
      const cached = lookupCache.get(key);
      if (!force && cached && now - cached.at < CODEX_SUBAGENT_REFRESH_THROTTLE_MS) {
        // Still fresh: adopt it so a remount inside the window shows the same
        // list it had before, without spawning anything.
        setResult(cached.result);
        return;
      }
      inFlightKeys.add(key);
      setIsLoading(true);
      void codexClient
        .listSubagents({ terminalId })
        .then((next) => {
          rememberLookup(key, next, Date.now());
          if (mountedRef.current) setResult(next);
        })
        .catch((error: unknown) => {
          logWarn(`[useCodexSubagents] list failed: ${formatErrorMessage(error, "unknown error")}`);
          if (mountedRef.current) setResult({ status: "unavailable", reason: "protocol-error" });
        })
        .finally(() => {
          inFlightKeys.delete(key);
          if (mountedRef.current) setIsLoading(false);
        });
    },
    [enabled, key, terminalId]
  );

  // First look. Throttled like any other automatic fetch — a restore remounts
  // every pane at once, and the cache above already covers what it would show.
  useEffect(() => {
    fetchSubagents(false);
  }, [fetchSubagents]);

  useEffect(() => {
    if (!agentState || !SETTLED_STATES.has(agentState)) return;
    fetchSubagents(false);
  }, [agentState, fetchSubagents]);

  const refresh = useCallback(() => fetchSubagents(true), [fetchSubagents]);

  return { result, isLoading, refresh };
}

/** Test-only: the lookup cache is module state and outlives a render tree. */
export function __resetCodexSubagentThrottle(): void {
  lookupCache.clear();
  inFlightKeys.clear();
}
