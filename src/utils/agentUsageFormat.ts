import type { AgentUsageReadout } from "@shared/types/ipc/agentUsage";
import { AGENT_USAGE_STALE_AFTER_MS, isAgentUsagePastAttention } from "@shared/utils/agentUsage";
import { claudeWindowLabel, formatResetClock } from "./agentAccountHeadroom";
import { windowLabel } from "./codexQuotaFormat";
import { formatTimeAgo } from "./timeAgo";

/** How a window on a host names a reading from the machine it runs on. */
export const THIS_MACHINE = "This machine";

export interface AgentUsageLine {
  /** The row: "Codex 82% · Work · resets 14:05". */
  text: string;
  /** What the row leaves out or shortens: the limit, the login and machine, the age. */
  detail: string[];
  /** Past the threshold, or a message that says the limit is near or reached. */
  attention: boolean;
  /** A Codex reading that missed its read; already spoken in `text`. */
  stale: boolean;
  /**
   * How long ago Claude Code printed it, for a slot of its own that the row
   * never cuts: a message's age is part of what it says. Null for Codex,
   * whose cadence `stale` already speaks for.
   */
  age: string | null;
}

// Floored, so a figure shown as 80% always carries the tone 80% does.
function percent(value: number): string {
  return `${Math.floor(value)}%`;
}

function figure(readout: AgentUsageReadout): string {
  const { reading } = readout;
  if (reading.agentId === "codex") return percent(reading.usedPercent);
  if (reading.statement === "reached") return `${reading.window} reached`;
  if (reading.usedPercent !== null && reading.statement === "used") {
    return percent(reading.usedPercent);
  }
  if (reading.usedPercent !== null && reading.statement === "over") {
    return `over ${percent(reading.usedPercent)}`;
  }
  return `approaching ${reading.window}`;
}

function limitLine(readout: AgentUsageReadout): string {
  const { reading } = readout;
  if (reading.agentId === "codex") {
    return `${windowLabel(reading.windowDurationMins)} ${percent(reading.usedPercent)} used`;
  }
  const limit = claudeWindowLabel(reading.window);
  if (reading.statement === "reached") return `${limit} reached`;
  if (reading.usedPercent !== null && reading.statement === "used") {
    return `${limit} ${percent(reading.usedPercent)} used`;
  }
  if (reading.usedPercent !== null && reading.statement === "over") {
    return `${limit} over ${percent(reading.usedPercent)} used`;
  }
  return `Approaching ${reading.window}`;
}

function accountLabel(readout: AgentUsageReadout): string {
  const { reading } = readout;
  const names = reading.accountNames.join(", ");
  if (reading.agentId === "codex") {
    if (reading.isDefault) return names ? `Default profile · ${names}` : "Default profile";
    return names || "Other profile";
  }
  if (reading.isDefault) return names ? `Default login · ${names}` : "Default login";
  return names || "Other config folder";
}

/**
 * One sidebar row for a readout (#17318): what was read or printed, the
 * login and machine it is for, and how old it is. Never a verdict about the
 * account beyond the fixed threshold's tone.
 */
export function describeAgentUsage(
  readout: AgentUsageReadout,
  agentName: string,
  now: number,
  /** The machine to name: the host's name, "This machine" in a window on another, or null. */
  machine: string | null = readout.hostName
): AgentUsageLine {
  const { reading } = readout;
  const stale =
    reading.agentId === "codex" && now - reading.observedAt > AGENT_USAGE_STALE_AFTER_MS;
  const reset =
    reading.resetsAt === null ? undefined : `resets ${formatResetClock(reading.resetsAt, now)}`;
  const parts = [
    `${agentName} ${figure(readout)}`,
    reading.accountNames.length > 0 ? reading.accountNames.join(", ") : undefined,
    machine ?? undefined,
    reset,
  ].filter((part): part is string => Boolean(part));
  const text = parts.join(" · ");
  const account = accountLabel(readout);
  const age = formatTimeAgo(reading.observedAt, now);
  return {
    text: stale ? `Stale · ${text}` : text,
    detail: [
      [limitLine(readout), reset].filter(Boolean).join(" · "),
      machine ? `${account} on ${machine === THIS_MACHINE ? "this machine" : machine}` : account,
      reading.agentId === "codex" ? `Read from Codex ${age}` : `Printed in a terminal ${age}`,
    ],
    attention: isAgentUsagePastAttention(reading),
    stale,
    age: reading.agentId === "claude" ? age : null,
  };
}
