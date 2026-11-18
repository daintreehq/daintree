import type { HostId } from "../remoteHosts.js";
import type { ClaudeUsageStatement, ClaudeUsageWindow } from "./agentQuota.js";

interface AgentUsageReadingBase {
  /**
   * Names the user gave the accounts on this login (#16040), or for a Codex
   * home no account names, the presets that set it. Empty for an unnamed login.
   */
  accountNames: string[];
  /** The login a launch with no account of its own lands on. */
  isDefault: boolean;
  /** Epoch ms of the reset the reading names; null when it named none. */
  resetsAt: number | null;
  /** Epoch ms: when Codex answered, or when a Claude Code pane printed the message. */
  observedAt: number;
}

/** One Codex rate-limit window, as `account/rateLimits/read` reported it (#12797). */
export interface CodexAgentUsageReading extends AgentUsageReadingBase {
  agentId: "codex";
  windowDurationMins: number;
  usedPercent: number;
}

/** One usage message a Claude Code pane printed (#15727), as parsed fields only. */
export interface ClaudeAgentUsageReading extends AgentUsageReadingBase {
  agentId: "claude";
  window: ClaudeUsageWindow;
  statement: ClaudeUsageStatement;
  /** Exact for `used`, a floor for `over`, else null. */
  usedPercent: number | null;
}

/**
 * The tightest known window of an account that has an agent running now
 * (#17318). What was read or printed, never a verdict about the account.
 */
export type AgentUsageReading = CodexAgentUsageReading | ClaudeAgentUsageReading;

/** A reading with the machine its agents run on. */
export interface AgentUsageReadout {
  /** `local` for this machine. */
  hostId: HostId;
  /** The host's name as this machine lists it; null for this machine. */
  hostName: string | null;
  reading: AgentUsageReading;
}

/** Every readout this machine knows of: its own agents and every linked host's. */
export interface AgentUsageSnapshot {
  readouts: AgentUsageReadout[];
  /** Increases on every change, so a view can drop a seed a newer push overtook. */
  revision: number;
}
