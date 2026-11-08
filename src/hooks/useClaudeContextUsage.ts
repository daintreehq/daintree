import { useEffect, useRef, useState } from "react";
import { claudeClient } from "@/clients/claudeClient";
import { isElectronAvailable } from "./useElectron";
import type { AgentState } from "@/types";

/**
 * After a turn, the first read waits this long for Claude Code to finish
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

/** States where the agent has stopped producing output, so its turn's records are on disk. */
const SETTLED_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  "idle",
  "waiting",
  "completed",
]);

export interface ClaudeContextUsageReading {
  contextTokens: number;
  /** When the transcript says the request's reply was written, epoch ms. */
  recordedAt: number;
}

interface CachedReading {
  at: number;
  reading: ClaudeContextUsageReading | null;
}

/**
 * Last answer per session, outliving the hook instance so a remount shows the
 * reading it had instead of nothing until the next turn. An unavailable answer
 * is kept as null: it replaces the reading rather than leaving an older one up.
 */
const cache = new Map<string, CachedReading>();
/** Requests in flight, shared so two instances for one session ask once. */
const inFlight = new Map<string, Promise<ClaudeContextUsageReading | null>>();

function remember(key: string, entry: CachedReading): void {
  cache.delete(key);
  cache.set(key, entry);
  for (const oldest of cache.keys()) {
    if (cache.size <= MAX_CACHED_SESSIONS) return;
    cache.delete(oldest);
  }
}

function read(terminalId: string, key: string): Promise<ClaudeContextUsageReading | null> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const at = Date.now();
  // Started inside the chain so a bridge that throws outright still settles.
  const request = Promise.resolve()
    .then(() => claudeClient.readContextUsage({ terminalId }))
    .then(
      (result) =>
        result.status === "ok"
          ? { contextTokens: result.contextTokens, recordedAt: result.recordedAt }
          : null,
      // The failure says nothing a person could act on, and the chip simply
      // isn't there; a host path in the message is no reason to log it.
      () => null
    )
    .then((reading) => {
      remember(key, { at, reading });
      return reading;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/**
 * The context a Claude Code pane's most recent main-conversation request
 * carried, read from its transcript on the host (#16371).
 *
 * Reads follow turn boundaries, never output: two reads each time the pane
 * settles after working, and one when a pane mounts already settled. Changes
 * between settled states (waiting, then completed) are the same boundary, and
 * work resuming cancels the reads still pending. The reading stays on screen
 * through the next turn, since its time says how old it is.
 */
export function useClaudeContextUsage(
  terminalId: string,
  options: {
    enabled: boolean;
    agentState?: AgentState;
    /** Anything that changes when the process or agent session behind the pane does. */
    generation: string;
  }
): ClaudeContextUsageReading | null {
  const { enabled, agentState, generation } = options;
  const key = `${terminalId}:${generation}`;
  const settled = agentState !== undefined && SETTLED_STATES.has(agentState);
  const [entry, setEntry] = useState<{
    key: string;
    reading: ClaudeContextUsageReading | null;
  } | null>(() => {
    const cached = cache.get(key);
    return cached ? { key, reading: cached.reading } : null;
  });
  // Set while the agent works and spent by the settle that ends the turn, so
  // that settle reads even when the last reading is seconds old.
  const workedRef = useRef(false);

  useEffect(() => {
    if (agentState === "working") workedRef.current = true;
  }, [agentState]);

  useEffect(() => {
    if (!enabled || !settled || !isElectronAvailable()) return;
    const afterTurn = workedRef.current;
    workedRef.current = false;
    const cached = cache.get(key);
    if (cached) {
      setEntry((current) => (current?.key === key ? current : { key, reading: cached.reading }));
    }
    if (!afterTurn && cached && Date.now() - cached.at < CONTEXT_USAGE_MOUNT_FLOOR_MS) return;

    let live = true;
    const fetchReading = () => {
      void read(terminalId, key).then((reading) => {
        if (live) setEntry({ key, reading });
      });
    };
    const timers = [setTimeout(fetchReading, CONTEXT_USAGE_FIRST_READ_MS)];
    if (afterTurn) timers.push(setTimeout(fetchReading, CONTEXT_USAGE_FOLLOW_UP_READ_MS));
    return () => {
      live = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [enabled, settled, terminalId, key]);

  // A reading for another session, or one the pane can no longer have, is not
  // this pane's: nothing shows until its own read answers.
  return enabled && entry?.key === key ? entry.reading : null;
}

/** Test-only: the cache is module state and outlives a render tree. */
export function __resetClaudeContextUsageCache(): void {
  cache.clear();
  inFlight.clear();
}
