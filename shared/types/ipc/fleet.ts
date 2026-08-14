import type { AgentState, WaitingReason } from "../agent.js";
import type { BuiltInAgentId } from "../../config/agentIds.js";
import type { PanelTitleMode } from "../panel.js";

/**
 * A user's decision that a run does not need them right now.
 *
 * Parking is intent, not state: the agent underneath keeps doing whatever it
 * was doing, and every attention surface (bands, demand counts, filters) treats
 * the run as shelved until the record is removed — by hand, or automatically
 * when the gate terminal next comes free. Owned by Main
 * (`RunAttentionService`) for the same reason the snapshot is: intent must
 * survive view eviction and app restart, and terminal ids do.
 */
export interface RunParkRecord {
  /** When the user parked the run (epoch ms). */
  parkedAt: number;
  /** Why it's parked — the user's own words, shown wherever the run is listed. */
  note?: string;
  /**
   * Terminal id whose next busy→ready transition releases this park. Absent
   * means the park holds until the user lifts it.
   */
  gateRunId?: string;
}

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
  /**
   * The panel's own title — its identity, not its task.
   *
   * Deliberately NOT pre-merged with `lastObservedTitle`. Composing the two is
   * `getTerminalDisplayTitle`'s job and it is not a `??`: it strips identity
   * affixes, drops titles that merely echo the agent's own name ("Claude
   * Code"), suppresses cwd echoes and useless strings, and yields to a
   * user-locked title. Collapsing them here would hand the renderer a string
   * that has already lost the inputs that decision needs.
   */
  title?: string;
  /** Raw OSC title the agent last set. Ingredient, never displayed as-is. */
  lastObservedTitle?: string;
  /** `"user"` means the title was set by hand and no task may override it. */
  titleMode?: PanelTitleMode;
  cwd: string;
  /**
   * Launch-time agent affinity, which carries chrome through the window before
   * detection commits — without it a run shows a generic terminal glyph for its
   * first seconds and then pops into its brand.
   *
   * Deliberately a bare string: it arrives from the PTY host unvalidated, and
   * the chrome resolver already treats an unrecognised id as no id.
   */
  launchAgentId?: string;
  /** Detection has committed at least once, so a later gap is a demotion. */
  everDetectedAgent?: boolean;
  /** User-chosen preset colour, which outranks the agent's default brand hue. */
  agentPresetColor?: string;
  /**
   * Present iff the user parked this run. Rides the row so every surface reads
   * one source of truth; the band logic demotes a parked run below the fold and
   * the note travels with it.
   */
  park?: RunParkRecord;
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
