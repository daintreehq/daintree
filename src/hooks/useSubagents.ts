import { useCallback, useEffect, useRef, useState } from "react";
import { SUBAGENT_PROVIDERS } from "@/clients/subagentProviders";
import { isElectronAvailable } from "./useElectron";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { AgentState } from "@/types";
import {
  isLiveSubagentStatus,
  type AgentSubagentUnavailableReason,
  type AgentSubagentsResult,
  type SubagentProvider,
} from "@shared/types/ipc/agentSubagents";

/**
 * Floor between automatic refreshes. A Codex lookup spawns a short-lived
 * `codex app-server` and a Claude one opens every child's transcript, so a
 * terminal that flickers between states can't turn either into a storm. Manual
 * refresh bypasses it — the user asked.
 */
export const SUBAGENT_REFRESH_THROTTLE_MS = 20_000;

/**
 * Claude's floor, and its polling interval while children can be running.
 * Its lookup is a directory listing plus a stat per child — a transcript is
 * only re-read once it has changed — so it can afford to keep up with a parent
 * that is delegating. Codex has no equivalent: each lookup spawns a process,
 * and `notLoaded` children give it no liveness to keep up with anyway.
 */
export const CLAUDE_SUBAGENT_POLL_MS = 5_000;

function automaticFloor(provider: SubagentProvider): number {
  return provider === "claude" ? CLAUDE_SUBAGENT_POLL_MS : SUBAGENT_REFRESH_THROTTLE_MS;
}

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
  /**
   * Set when the latest lookup failed for a reason that says nothing about
   * which children exist (a timeout, an unreadable store), while `result` still
   * holds the last list that did answer. Cleared by the next lookup that does.
   */
  refreshError: AgentSubagentUnavailableReason | null;
}

/**
 * Failures of the lookup itself rather than answers about the session. A list
 * that was already read stays on screen through these, because nothing about
 * them contradicts it. Every other reason — the session can't be matched, is
 * ambiguous, or belongs to another agent — does, so it replaces the list and
 * the chip fails closed.
 */
const TRANSIENT_REASONS: ReadonlySet<AgentSubagentUnavailableReason> = new Set([
  "timeout",
  "protocol-error",
  "store-unreadable",
  "cli-missing",
]);

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
  /** Kept with the list it qualifies, so a remount doesn't pass stale children off as current. */
  refreshError?: AgentSubagentUnavailableReason;
}

const lookupCache = new Map<string, CachedLookup>();
/**
 * Requests in flight, shared across hook instances. The promise rather than a
 * flag, so an instance that mounts while another's lookup is running — a
 * remount mid-request, a second pane on the same terminal — gets that answer
 * too instead of waiting for a settle that may never come.
 */
const inFlight = new Map<string, Promise<AgentSubagentsResult>>();

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
  generation: number | string | undefined
): string {
  return `${provider}:${terminalId}:${generation ?? 0}`;
}

function rememberLookup(
  key: string,
  result: AgentSubagentsResult,
  at: number,
  refreshError?: AgentSubagentUnavailableReason
): void {
  lookupCache.set(key, { at, result, refreshError });
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
 * View of a terminal's spawned subagents: one query on mount, one whenever the
 * parent settles, and one per manual refresh. Claude is also polled while its
 * children can be running — the parent is working, or the last answer still
 * had a child live — since that is exactly when a settle-only refresh would
 * leave the count describing the past. Which store gets asked is the provider
 * adapter's business, not this hook's.
 */
export function useSubagents(
  terminalId: string,
  options: {
    provider: SubagentProvider | null;
    agentState?: AgentState;
    /** Anything that changes when the process or agent session behind the pane does. */
    generation?: number | string;
  }
): UseSubagentsResult {
  const { provider, agentState, generation } = options;
  const key = cacheKey(provider ?? "codex", terminalId, generation);
  const [entry, setEntry] = useState<{
    key: string;
    result: AgentSubagentsResult;
    refreshError?: AgentSubagentUnavailableReason;
  } | null>(() => {
    const cached = lookupCache.get(key);
    return cached ? { key, result: cached.result, refreshError: cached.refreshError } : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);
  // The key currently on screen. Written from an effect rather than during
  // render: a ref mutated mid-render is impure, and a speculative render that
  // React throws away would leave this pointing at a key that never committed.
  // Declared before the fetch effects so it is current when they run.
  const committedKeyRef = useRef(key);
  useEffect(() => {
    committedKeyRef.current = key;
  }, [key]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchSubagents = useCallback(
    (force: boolean) => {
      if (!provider || !isElectronAvailable()) return;
      const settle = (next: AgentSubagentsResult) => {
        // Answers the key it was asked under. Without this an in-flight
        // lookup that outlives an agent switch overwrites the new agent's
        // list with the old one's, and stays wrong until something refetches.
        if (!mountedRef.current || committedKeyRef.current !== key) return;
        setEntry((current) => {
          if (
            next.status === "unavailable" &&
            TRANSIENT_REASONS.has(next.reason) &&
            current?.key === key &&
            current.result.status === "ok"
          ) {
            return { key, result: current.result, refreshError: next.reason };
          }
          return { key, result: next };
        });
      };
      const follow = (request: Promise<AgentSubagentsResult>) => {
        setIsLoading(true);
        void request.then(settle).finally(() => {
          if (mountedRef.current) setIsLoading(false);
        });
      };
      // Module-scoped, so two panes remounting the same terminal at once issue
      // one lookup rather than one each — and both hear its answer.
      const pending = inFlight.get(key);
      if (pending) {
        follow(pending);
        return;
      }
      const now = Date.now();
      const cached = lookupCache.get(key);
      if (!force && cached && now - cached.at < automaticFloor(provider)) {
        // Still fresh: adopt it so a remount inside the window shows the same
        // list it had before, without spawning anything.
        setEntry({ key, result: cached.result, refreshError: cached.refreshError });
        return;
      }
      const adapter = SUBAGENT_PROVIDERS[provider];
      // A transient failure still stamps the throttle, or a pane that keeps
      // settling would retry on every settle, but it keeps the last good list
      // as what a remount rehydrates to.
      const remember = (next: AgentSubagentsResult) => {
        const previous = lookupCache.get(key)?.result;
        const keepPrevious =
          next.status === "unavailable" &&
          TRANSIENT_REASONS.has(next.reason) &&
          previous?.status === "ok";
        if (keepPrevious) rememberLookup(key, previous, Date.now(), next.reason);
        else rememberLookup(key, next, Date.now());
      };
      const request = adapter
        .list({ terminalId })
        .then(
          (next) => {
            remember(next);
            return next;
          },
          (error: unknown) => {
            logWarn(`[useSubagents] list failed: ${formatErrorMessage(error, "unknown error")}`);
            const failed: AgentSubagentsResult = {
              status: "unavailable",
              reason: adapter.fallbackReason,
            };
            remember(failed);
            return failed;
          }
        )
        .finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      follow(request);
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
  const current = entry?.key === key ? entry : null;

  // Children outlive the parent's turn when they run in the background, so a
  // live child keeps the poll going after the parent settles, until the list
  // says it has finished. Runs whether or not anything is on screen: a session
  // whose first answer was empty has to be asked again to find its first child.
  const hasLiveChild =
    current?.result.status === "ok" &&
    current.result.subagents.some((subagent) => isLiveSubagentStatus(subagent.status));
  const shouldPoll = provider === "claude" && (agentState === "working" || hasLiveChild);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => fetchSubagents(false), CLAUDE_SUBAGENT_POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, fetchSubagents]);

  return {
    result: current?.result ?? null,
    isLoading,
    refresh,
    refreshError: current?.refreshError ?? null,
  };
}

/** Test-only: the lookup cache is module state and outlives a render tree. */
export function __resetSubagentThrottle(): void {
  lookupCache.clear();
  inFlight.clear();
}
