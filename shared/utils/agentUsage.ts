import {
  MAX_AGENT_USAGE_ACCOUNT_NAMES,
  MAX_AGENT_USAGE_ACCOUNT_NAME_CHARS,
  type AgentUsageReading,
} from "../types/ipc/agentUsage.js";

/** Names cut to what a link carries, so a long preset list never costs a host its reading. */
export function boundAgentUsageAccountNames(names: readonly string[]): string[] {
  return names
    .slice(0, MAX_AGENT_USAGE_ACCOUNT_NAMES)
    .map((name) => name.slice(0, MAX_AGENT_USAGE_ACCOUNT_NAME_CHARS));
}

/**
 * The fixed point past which a reading takes the attention tone (#17318). It
 * applies to any percent Claude Code printed too, and its "approaching" and
 * hit-limit messages count as past it.
 */
export const AGENT_USAGE_ATTENTION_PERCENT = 80;

/** How often main asks Codex for the quota of an account with an agent running. */
export const AGENT_USAGE_CODEX_READ_INTERVAL_MS = 5 * 60_000;

/**
 * A Codex reading older than this missed its read. Judged by the five-minute
 * cadence, not the two minutes Settings uses, which would read stale most of
 * the time; the slack covers the watch's own tick and a slow read.
 */
export const AGENT_USAGE_STALE_AFTER_MS = AGENT_USAGE_CODEX_READ_INTERVAL_MS + 2 * 60_000;

/**
 * How firmly a reading says the limit is near. A hit limit outranks
 * everything; a figure at or past the threshold outranks "approaching", which
 * outranks a figure under it: the threshold is where an unquantified message
 * sits, so "12% used" never hides "approaching". No percent is made up for a
 * message that gave none.
 */
function rank(reading: AgentUsageReading): [tier: number, percent: number, over: number] {
  if (reading.agentId === "claude") {
    if (reading.statement === "reached") return [4, 0, 0];
    if (reading.usedPercent === null || reading.statement === "approaching") return [2, 0, 0];
  }
  const percent = reading.usedPercent ?? 0;
  const over = reading.agentId === "claude" && reading.statement === "over" ? 1 : 0;
  return [percent >= AGENT_USAGE_ATTENTION_PERCENT ? 3 : 1, percent, over];
}

/** Past the threshold, or a message that says it is near or reached. */
export function isAgentUsagePastAttention(reading: AgentUsageReading): boolean {
  return rank(reading)[0] >= 2;
}

/** A reading whose reset has passed describes a window that is over. */
export function hasAgentUsageReset(reading: AgentUsageReading, now: number): boolean {
  return reading.resetsAt !== null && reading.resetsAt <= now;
}

/**
 * Positive when `a` is tighter than `b`. Equal ranks go to the newer reading,
 * then to the shorter Codex window, which resets sooner.
 */
export function compareAgentUsage(a: AgentUsageReading, b: AgentUsageReading): number {
  const left = rank(a);
  const right = rank(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  if (a.agentId === "codex" && b.agentId === "codex") {
    return b.windowDurationMins - a.windowDurationMins;
  }
  return 0;
}

/**
 * The tightest reading whose reset hasn't passed, one per agent, in the order
 * each agent first appears. The first of two equal readings stands.
 */
export function tightestAgentUsage<T>(
  items: readonly T[],
  readingOf: (item: T) => AgentUsageReading,
  now: number
): T[] {
  const best = new Map<AgentUsageReading["agentId"], T>();
  for (const item of items) {
    const reading = readingOf(item);
    if (hasAgentUsageReset(reading, now)) continue;
    const current = best.get(reading.agentId);
    if (current === undefined || compareAgentUsage(reading, readingOf(current)) > 0) {
      best.set(reading.agentId, item);
    }
  }
  return [...best.values()];
}

/**
 * Per agent, the tightest reading whose reset hasn't passed and, when that
 * one names a reset, the tightest of the rest that outlast it: what shows
 * once it resets. Sent together, so a machine whose clock reaches the reset
 * first still has the next reading to show.
 */
export function agentUsageWithSuccessors(
  readings: readonly AgentUsageReading[],
  now: number
): AgentUsageReading[] {
  return tightestAgentUsage(readings, (reading) => reading, now).flatMap((winner) => {
    const until = winner.resetsAt;
    if (until === null) return [winner];
    const [successor] = tightestAgentUsage(
      readings.filter(
        (reading) =>
          reading !== winner &&
          reading.agentId === winner.agentId &&
          (reading.resetsAt === null || reading.resetsAt > until)
      ),
      (reading) => reading,
      now
    );
    return successor ? [winner, successor] : [winner];
  });
}
