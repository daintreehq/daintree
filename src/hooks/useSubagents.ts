import { useCallback, useEffect, useRef, useState } from "react";
import { SUBAGENT_PROVIDERS } from "@/clients/subagentProviders";
import { isElectronAvailable } from "./useElectron";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentState } from "@/types";
import type { AgentSubagentsResult, SubagentProvider } from "@shared/types/ipc/agentSubagents";

/**
 * Floor between automatic refreshes. A Codex lookup spawns a short-lived
 * `codex app-server` and a Claude one opens every child's transcript, so a
 * terminal that flickers between states can't turn either into a storm. Manual
 * refresh bypasses it — the user asked.
 */
export const SUBAGENT_REFRESH_THROTTLE_MS = 20_000;

/**
 * States where the parent has stopped producing output, so any subagent it
 * spawned has had a chance to reach the provider's store.
 */
const SETTLED_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "idle",
  "waiting",
  "completed",
]);

export interface UseSubagentsResult {
  result: AgentSubagentsResult | null;
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
  result: AgentSubagentsResult;
}

const lookupCache = new Map<string, CachedLookup>();
/** Terminal keys with a request in flight, shared across hook instances. */
const inFlightKeys = new Set<string>();

/** Hard bound on the cache — a long session cycles through many terminals. */
const MAX_CACHED_TERMINALS = 64;

/**
 * A reused panel id is not the same session. Folding the PTY's start time into
 * the key means a respawned terminal looks up its own subagents instead of
 * adopting the answer for the process that used to live there, and folding in
 * the provider keeps a pane that switched agents from reading the old one's.
 */
function cacheKey(
  provider: SubagentProvider,
  terminalId: string,
  generation: number | undefined
): string {
  return `${provider}:${terminalId}:${generation ?? 0}`;
}

function rememberLookup(key: string, result: AgentSubagentsResult, at: number): void {
  lookupCache.set(key, { at, result });
  if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
  // Expired entries first — they would be refetched anyway — then oldest-first
  // until the cap actually holds, since every entry can be fresh at once.
  for (const [entryKey, entry] of lookupCache) {
    if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
    if (at - entry.at > SUBAGENT_REFRESH_THROTTLE_MS) lookupCache.delete(entryKey);
  }
  for (const entryKey of lookupCache.keys()) {
    if (lookupCache.size <= MAX_CACHED_TERMINALS) return;
    lookupCache.delete(entryKey);
  }
}

/**
 * Poll-free view of a terminal's spawned subagents: one query on mount, one
 * whenever the parent settles, and one per manual refresh. Which store gets
 * asked is the provider adapter's business, not this hook's.
 */
export function useSubagents(
  terminalId: string,
  options: {
    provider: SubagentProvider | null;
    agentState?: AgentState;
    generation?: number;
  }
): UseSubagentsResult {
  const { provider, agentState, generation } = options;
  const key = cacheKey(provider ?? "codex", terminalId, generation);
  const [entry, setEntry] = useState<{ key: string; result: AgentSubagentsResult } | null>(() => {
    const cached = lookupCache.get(key)?.result;
    return cached ? { key, result: cached } : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);
  // The key a settling request was issued under. A respawn or an agent switch
  // moves the key, and the old request must not land on the new one.
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchSubagents = useCallback(
    (force: boolean) => {
      if (!provider || !isElectronAvailable()) return;
      // Module-scoped, so two panes remounting the same terminal at once issue
      // one lookup rather than one each.
      if (inFlightKeys.has(key)) return;
      const now = Date.now();
      const cached = lookupCache.get(key);
      if (!force && cached && now - cached.at < SUBAGENT_REFRESH_THROTTLE_MS) {
        // Still fresh: adopt it so a remount inside the window shows the same
        // list it had before, without spawning anything.
        setEntry({ key, result: cached.result });
        return;
      }
      const adapter = SUBAGENT_PROVIDERS[provider];
      inFlightKeys.add(key);
      setIsLoading(true);
      void adapter
        .list({ terminalId })
        .then((next) => {
          rememberLookup(key, next, Date.now());
          // Answers the key it was asked under. Without this an in-flight
          // lookup that outlives an agent switch overwrites the new agent's
          // list with the old one's, and stays wrong until something refetches.
          if (mountedRef.current && keyRef.current === key) setEntry({ key, result: next });
        })
        .catch((error: unknown) => {
          logWarn(`[useSubagents] list failed: ${formatErrorMessage(error, "unknown error")}`);
          if (mountedRef.current && keyRef.current === key) {
            setEntry({ key, result: { status: "unavailable", reason: adapter.fallbackReason } });
          }
        })
        .finally(() => {
          inFlightKeys.delete(key);
          if (mountedRef.current) setIsLoading(false);
        });
    },
    [provider, key, terminalId]
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

  // An answer for a key that is no longer current is not this session's answer.
  // Reporting null rather than the stale list is what keeps a respawned pane
  // from showing the dead process's children until the new lookup returns.
  return { result: entry?.key === key ? entry.result : null, isLoading, refresh };
}

/** Test-only: the lookup cache is module state and outlives a render tree. */
export function __resetSubagentThrottle(): void {
  lookupCache.clear();
  inFlightKeys.clear();
}
