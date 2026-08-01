import type { AgentState, WaitingReason } from "../agent.js";
import type { BuiltInAgentId } from "../../config/agentIds.js";

/**
 * One agent run: a single agent terminal living in a single worktree.
 *
 * The run — not the project — is the unit here, and that is the whole point of
 * the snapshot. `ProjectStatusMap` answers "how many of this project's agents
 * want something", which tells you where to go but nothing you can act on. A
 * run carries the branch, the agent and the age, so a surface can name the one
 * thing that is stuck instead of the repo it is stuck in.
 *
 * Every field here is already on the pty-host's terminal record, so the whole
 * row is free: main fetches exactly this data today and discards it.
 *
 * Deliberately excludes the terminal's `lastOutputTime`. It is rewritten on
 * every PTY data chunk (`PtyDataPipeline`), so carrying it would change the
 * payload many times a second for any working agent and defeat the snapshot's
 * unchanged-payload suppression exactly when the fleet is busiest. Stall
 * detection wants that signal, but it needs per-run calibration against the
 * run's own output rhythm and belongs beside the agent FSM, not on a list
 * projection whose whole cost model depends on changing rarely.
 */
export interface FleetRunRow {
  /** Terminal id. The run's identity, and the handle any action takes. */
  runId: string;
  /**
   * Owning workspace — a project id or a scratch id. The two formats are
   * disjoint (64-char hex vs UUID), so one snapshot carries both without
   * collision, exactly as `ProjectStatusMap` does (#11518).
   */
  workspaceId: string;
  /** Worktree the run is in, when the terminal carries one. */
  worktreeId?: string;
  /** Runtime-detected agent identity, absent before detection commits. */
  agentId?: BuiltInAgentId;
  agentState?: AgentState;
  /** `"error"` distinguishes blocked-after-failure from waiting-on-input. */
  waitingReason?: WaitingReason;
  /**
   * Transition into the current state (epoch ms). Ages the row, so absent
   * means the row can be listed but not aged — never that it is fresh.
   */
  since?: number;
  spawnedAt: number;
  /** Terminal title, preferring the last meaningful OSC title the agent set. */
  title?: string;
  cwd: string;
}

/**
 * The fleet as main sees it: every agent run across every project and scratch,
 * including those whose renderer view is evicted or parked.
 *
 * Deliberately flat and present-tense. It carries no bands, no ordering and no
 * copy — those are presentation and belong in the renderer, where the palette's
 * existing ranking already lives. Main's job is to report what is true.
 */
export interface FleetSnapshot {
  runs: FleetRunRow[];
  /**
   * When the fleet last actually CHANGED (epoch ms) — not when it was last
   * checked.
   *
   * Unchanged polls are suppressed, so this deliberately does not advance
   * while nothing moves. It answers "how long has the fleet looked like this",
   * which is genuinely useful ("quiet for 40 minutes"), and it must NOT be
   * rendered as "updated Ns ago": a healthy quiet fleet and a service that
   * died four minutes ago both read as four minutes old, and the reassuring
   * interpretation is the wrong one.
   *
   * {@link lastSuccessfulAt} is the freshness signal. Use that.
   */
  changedAt: number;
  /**
   * At least one PTY shard failed to answer the read behind this snapshot, so
   * `runs` is the last complete view rather than the current one.
   *
   * The flag exists because an incomplete read and an idle fleet are the same
   * empty list, and only one of them may render as "nothing is running". A
   * degraded snapshot is retained data — present it as stale, never as clear.
   */
  degraded: boolean;
  /**
   * When a COMPLETE read last succeeded (epoch ms), or null if one never has.
   *
   * Tracked on every healthy poll but only put on the wire when something is
   * actually broadcast, so it never defeats the unchanged-payload suppression
   * the way a per-poll heartbeat would. Null alongside `degraded` is the "we
   * have never been able to see the fleet" state, which is a different thing
   * to tell the user than "this is twelve minutes old".
   */
  lastSuccessfulAt: number | null;
}
