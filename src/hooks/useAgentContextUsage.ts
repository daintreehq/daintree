import { useEffect, useRef, useState } from "react";
import { claudeClient } from "@/clients/claudeClient";
import { codexClient } from "@/clients/codexClient";
import { isElectronAvailable } from "./useElectron";
import type { AgentState } from "@/types";
import type {
  AgentContextUsageProvider,
  AgentContextUsageResult,
} from "@shared/types/ipc/agentContextUsage";

/**
 * After a turn, the first read waits this long for the agent to finish
 * writing the turn's records, and the second catches a write that took longer.
 */
export const CONTEXT_USAGE_FIRST_READ_MS = 500;
export const CONTEXT_USAGE_FOLLOW_UP_READ_MS = 2_000;

/**
 * A pane that mounts already settled reads once, unless a reading for the same
 * session is younger than this: a restore remounts every pane at once, and the
 * reading it would get is the one already cached.
 */
export const CONTEXT_USAGE_MOUNT_FLOOR_MS = 5_000;

/** Hard bound on the cache — a long session cycles through many terminals. */
const MAX_CACHED_SESSIONS = 64;

/**
 * States where the agent has stopped producing output, so its turn's records
 * are on disk. `directing` is someone typing to a paused agent: still the same
 * boundary, so starting a reply doesn't cancel the reads the turn scheduled.
 */
const SETTLED_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "idle",
  "waiting",
  "directing",
  "completed",
]);

export interface AgentContextUsageReading {
  contextTokens: number;
  /** The context window the record states, when it states one (Codex only). */
  contextWindow?: number;
  /** When the session file says the reading was written, epoch ms. */
  recordedAt: number;
}

interface CachedReading {
  at: number;
  reading: AgentContextUsageReading | null;
}

const READERS: Record<
  AgentContextUsageProvider,
  (payload: { terminalId: string }) => Promise<AgentContextUsageResult>
> = {
  claude: (payload) => claudeClient.readContextUsage(payload),
  codex: (payload) => codexClient.readContextUsage(payload),
};

/** The reading an answer carries, if it is an answer about the agent that was asked. */
function toReading(
  provider: AgentContextUsageProvider,
  result: AgentContextUsageResult
): AgentContextUsageReading | null {
  if (result.status !== "ok" || result.provider !== provider) return null;
  const { contextTokens, recordedAt } = result;
  if (result.provider === "codex" && result.contextWindow !== undefined) {
    return { contextTokens, contextWindow: result.contextWindow, recordedAt };
  }
  return { contextTokens, recordedAt };
}

/**
 * Last answer per session, outliving the hook instance so a remount shows the
 * reading it had instead of nothing until the next turn. An unavailable answer
 * is kept as null: it replaces the reading rather than leaving an older one up.
 */
const cache = new Map<string, CachedReading>();
/**
 * Requests in flight, shared so two instances for one session ask once. One per
 * session at a time, so answers land in the order they were asked.
 */
const inFlight = new Map<
  string,
  { at: number; request: Promise<AgentContextUsageReading | null> }
>();

function remember(key: string, entry: CachedReading): void {
  cache.delete(key);
  cache.set(key, entry);
  for (const oldest of cache.keys()) {
    if (cache.size <= MAX_CACHED_SESSIONS) return;
    cache.delete(oldest);
  }
}

/**
 * A reading asked for no earlier than `due`. A request already in flight that
 * started before then may have read the transcript before the turn's last
 * records reached it, so it is waited out and a fresh one asked, unless the
 * caller has stopped wanting one by then.
 */
function read(
  provider: AgentContextUsageProvider,
  terminalId: string,
  key: string,
  due: number,
  wanted: () => boolean
): Promise<AgentContextUsageReading | null> {
  const pending = inFlight.get(key);
  if (pending) {
    if (pending.at >= due) return pending.request;
    return pending.request.then(() =>
      wanted() ? read(provider, terminalId, key, due, wanted) : null
    );
  }
  const at = Date.now();
  // Started inside the chain so a bridge that throws outright still settles.
  const request = Promise.resolve()
    .then(() => READERS[provider]({ terminalId }))
    .then(
      (result) => toReading(provider, result),
      // The failure says nothing a person could act on, and the chip simply
      // isn't there; a host path in the message is no reason to log it.
      () => null
    )
    .then((reading) => {
      remember(key, { at, reading });
      return reading;
    })
    .finally(() => {
      if (inFlight.get(key)?.request === request) inFlight.delete(key);
    });
  inFlight.set(key, { at, request });
  return request;
}

/**
 * How much context an agent pane carries, read on the host from the session
 * file its CLI writes: a Claude Code transcript (#16371) or a Codex rollout
 * (#16408).
 *
 * Reads follow turn boundaries, never output: two reads each time the pane
 * settles after working, and one when a pane mounts already settled. Changes
 * between settled states (waiting, typing a reply, completed) are the same
 * boundary, and work resuming cancels the reads still pending. The reading
 * stays on screen through the next turn, since its time says how old it is.
 */
export function useAgentContextUsage(
  terminalId: string,
  options: {
    provider: AgentContextUsageProvider;
    enabled: boolean;
    agentState?: AgentState;
    /** Anything that changes when the process or agent session behind the pane does. */
    generation: string;
  }
): AgentContextUsageReading | null {
  const { provider, enabled, agentState, generation } = options;
  const key = `${provider}:${terminalId}:${generation}`;
  const settled = agentState !== undefined && SETTLED_STATES.has(agentState);
  const [entry, setEntry] = useState<{
    key: string;
    reading: AgentContextUsageReading | null;
  } | null>(() => {
    const cached = cache.get(key);
    return cached ? { key, reading: cached.reading } : null;
  });
  // The key the agent worked under, spent by the settle that ends the turn, so
  // that settle reads even when the last reading is seconds old. A turn of
  // another agent or run in the same pane is not this one's.
  const workedRef = useRef<string | null>(null);

  useEffect(() => {
    if (agentState === "working") workedRef.current = key;
  }, [agentState, key]);

  useEffect(() => {
    if (!enabled || !settled || !isElectronAvailable()) return;
    const afterTurn = workedRef.current === key;
    workedRef.current = null;
    const cached = cache.get(key);
    if (cached) {
      setEntry((current) => (current?.key === key ? current : { key, reading: cached.reading }));
    }
    if (!afterTurn && cached && Date.now() - cached.at < CONTEXT_USAGE_MOUNT_FLOOR_MS) return;

    let live = true;
    const schedule = (delay: number) => {
      const due = Date.now() + delay;
      return setTimeout(() => {
        void read(provider, terminalId, key, due, () => live).then((reading) => {
          if (live) setEntry({ key, reading });
        });
      }, delay);
    };
    const timers = [schedule(CONTEXT_USAGE_FIRST_READ_MS)];
    if (afterTurn) timers.push(schedule(CONTEXT_USAGE_FOLLOW_UP_READ_MS));
    return () => {
      live = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [enabled, settled, provider, terminalId, key]);

  // A reading for another session, or one the pane can no longer have, is not
  // this pane's: nothing shows until its own read answers.
  return enabled && entry?.key === key ? entry.reading : null;
}

/** Test-only: the cache is module state and outlives a render tree. */
export function __resetAgentContextUsageCache(): void {
  cache.clear();
  inFlight.clear();
}
