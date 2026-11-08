import type { HostId } from "../../../shared/types/remoteHosts.js";

/** The tools that start agents in a host's project and name each one's terminal in their answer. */
const AGENT_LAUNCH_TOOLS: ReadonlySet<string> = new Set([
  "agent.launch",
  "agent.launchMany",
  "agent.launchInNewWorktree",
  "workflow.startWorkOnIssue",
]);

/** Agents remembered at once; past it the oldest are let go, as if their bound had passed. */
const MAX_LAUNCHED_AGENTS = 512;
/** Agents seen ended, kept so an answer replayed from before can't bring one back. */
const MAX_ENDED_AGENTS = 1024;
/**
 * How long an agent the host has never listed is given to show up: a launch
 * answers once its pane exists, and the pane may wait on memory pressure or a
 * drive lease before its process starts. One that never shows, a spawn that
 * failed after the answer, is let go after this rather than held for days.
 */
export const LAUNCHED_AGENT_UNLISTED_MS = 10 * 60_000;
/**
 * How long an agent the host has listed may go unlisted before it counts as
 * ended: a restart takes its terminal down and back up under the same id.
 */
export const LAUNCHED_AGENT_GONE_MS = 60_000;

export function launchesAgents(tool: string): boolean {
  return AGENT_LAUNCH_TOOLS.has(tool);
}

/**
 * The host terminals an answered launch started agents in: the launch's own,
 * or each of a batch's items that ran. A launch that declined names none.
 */
export function launchedTerminalIds(structured: unknown): string[] {
  const found = new Set<string>();
  const learn = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    if (Reflect.get(value, "launched") === false) return;
    const terminalId: unknown = Reflect.get(value, "terminalId");
    if (typeof terminalId === "string" && terminalId !== "") found.add(terminalId);
  };
  learn(structured);
  const items: unknown =
    structured !== null && typeof structured === "object"
      ? Reflect.get(structured, "results")
      : undefined;
  if (Array.isArray(items)) {
    for (const item of items as unknown[]) {
      if (item === null || typeof item !== "object") continue;
      if (Reflect.get(item, "ok") === true) learn(Reflect.get(item, "result"));
    }
  }
  return [...found];
}

interface Hold {
  hostId: HostId;
  /** Past this the host's link is no longer held for it, whatever the host says. */
  until: number;
}

interface Launch extends Hold {
  helpSessionId: string;
}

interface Agent extends Hold {
  terminalId: string;
  learntAt: number;
  /** The host has listed it: missing from full lists for long enough, it ended. */
  listed: boolean;
  /** When the first full list since it was last listed was asked for without it. */
  missingSince: number | null;
}

const agentKey = (hostId: HostId, terminalId: string): string => `${hostId}\u0000${terminalId}`;

/**
 * The agents this Shell's assistants launched on hosts (#16492), so a host's
 * link stays up while they may still run there and every window reads the
 * host's own counts of them. Each is held until full lists of the host's
 * agents have stopped naming it for a while (one it never listed is first
 * given time to start), or its bound passes. A launch whose answer was lost or unreadable
 * may have started an agent this Shell can't name, so it is held for the
 * whole bound. Bounds are kept on a monotonic clock, and nothing here runs a
 * timer: each is read when the idle sweep asks.
 */
export class LaunchedAgents {
  /** Launches sent whose answer hasn't named their terminals yet, by callId. */
  private readonly launches = new Map<string, Launch>();
  private readonly agents = new Map<string, Agent>();
  private readonly ended = new Set<string>();

  constructor(
    private readonly mono: () => number,
    private readonly holdMs: number
  ) {}

  /** A launch about to be sent: held until its answer names what it started. */
  launching(hostId: HostId, helpSessionId: string, callId: string): void {
    const now = this.mono();
    this.prune(now);
    if (this.launches.has(callId)) return;
    this.launches.set(callId, { hostId, helpSessionId, until: now + this.holdMs });
    trim(this.launches, MAX_LAUNCHED_AGENTS);
  }

  /** Who a launch still held under `callId` was sent by, so another can't take its id over. */
  launchOf(callId: string): { hostId: HostId; helpSessionId: string } | null {
    const launch = this.launches.get(callId);
    return launch ? { hostId: launch.hostId, helpSessionId: launch.helpSessionId } : null;
  }

  /** The launch sent to `hostId` under `callId` is known not to have started anything. */
  launchFailed(hostId: HostId, callId: string): void {
    if (this.launches.get(callId)?.hostId === hostId) this.launches.delete(callId);
  }

  /** A launch's answer named the terminals it started, none when it started nothing. */
  launched(hostId: HostId, callId: string, terminalIds: readonly string[]): void {
    const now = this.mono();
    this.prune(now);
    const sent = this.launches.get(callId);
    if (sent !== undefined && sent.hostId !== hostId) return;
    this.launches.delete(callId);
    const until = sent?.until ?? now + this.holdMs;
    for (const terminalId of terminalIds) {
      const key = agentKey(hostId, terminalId);
      if (this.ended.has(key) || this.agents.has(key)) continue;
      this.agents.set(key, {
        hostId,
        terminalId,
        until,
        learntAt: now,
        listed: false,
        missingSince: null,
      });
    }
    trim(this.agents, MAX_LAUNCHED_AGENTS);
  }

  /** Whether an agent launched on `hostId` may still be running there. */
  holds(hostId: HostId): boolean {
    this.prune(this.mono());
    for (const hold of this.launches.values()) if (hold.hostId === hostId) return true;
    for (const agent of this.agents.values()) if (agent.hostId === hostId) return true;
    return false;
  }

  /**
   * A full list of the host's agent terminals, asked for at `readAt`. An
   * agent missing from it has ended there once full lists have gone without
   * it for a while since the host last listed it, or, never listed, once it
   * was named long enough before the read to have started.
   */
  listed(hostId: HostId, terminalIds: ReadonlySet<string>, readAt: number): void {
    for (const [key, agent] of [...this.agents]) {
      if (agent.hostId !== hostId) continue;
      if (terminalIds.has(agent.terminalId)) {
        agent.listed = true;
        agent.missingSince = null;
        continue;
      }
      if (agent.listed) {
        agent.missingSince ??= readAt;
        if (readAt - agent.missingSince < LAUNCHED_AGENT_GONE_MS) continue;
      } else if (agent.learntAt + LAUNCHED_AGENT_UNLISTED_MS > readAt) {
        continue;
      }
      this.agents.delete(key);
      this.ended.add(key);
    }
    trim(this.ended, MAX_ENDED_AGENTS);
  }

  /** The host was removed: nothing on it is held any more. */
  forgetHost(hostId: HostId): void {
    for (const [callId, hold] of [...this.launches]) {
      if (hold.hostId === hostId) this.launches.delete(callId);
    }
    for (const [key, agent] of [...this.agents]) {
      if (agent.hostId === hostId) this.agents.delete(key);
    }
  }

  clear(): void {
    this.launches.clear();
    this.agents.clear();
    this.ended.clear();
  }

  private prune(now: number): void {
    for (const [callId, hold] of [...this.launches]) {
      if (hold.until <= now) this.launches.delete(callId);
    }
    for (const [key, agent] of [...this.agents]) {
      if (agent.until <= now) this.agents.delete(key);
    }
  }
}

function trim<K>(entries: Map<K, unknown> | Set<K>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done === true) return;
    entries.delete(oldest.value);
  }
}
