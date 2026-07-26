import type { ProjectStatusMap } from "../../shared/types/ipc/project.js";
import { getWritesSuppressed } from "./diskPressureState.js";

/**
 * How long the project must stay observed before its completions count as
 * seen. Two seconds filters accidental switch-throughs; a completion arriving
 * mid-dwell restarts the clock for itself (see the anchor computation).
 */
export const COMPLETION_ACK_DWELL_MS = 2_000;

/** Sampling cadence. Coarse on purpose — the check is a few map lookups. */
export const COMPLETION_ACK_SAMPLE_INTERVAL_MS = 1_000;

export interface CompletionAcknowledgementDeps {
  /**
   * The project the user is looking at right now: the focused, visible,
   * non-minimized window's active project view. Null when no Daintree window
   * has focus or the focused window shows no project — completions must never
   * be acknowledged while the user is elsewhere.
   */
  getObservedProjectId: () => string | null;
  /** Latest pushed status map (ProjectStatsService.getLastBroadcast). */
  getStatusMap: () => ProjectStatusMap;
  /** Persist the acknowledgement watermark for a project. */
  markSeen: (projectId: string, seenUpTo: number) => void;
  /** Fired after a stamp so the stats push can clear the attention state. */
  onAcknowledged: () => void;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Turns "the user looked at the project" into the acknowledgement watermark
 * behind the switcher's completed-agent surfacing.
 *
 * A completed agent is a hand-back, not ambient state: the project stays in
 * "Needs attention" until the user has actually had it on screen — current
 * project, focused window — for a continuous dwell. There is deliberately no
 * elapsed-time expiry anywhere in this pipeline; an unseen completion from
 * yesterday is exactly the event the acknowledgement model exists to preserve.
 *
 * Polling rather than event wiring: the observed project is a function of
 * window focus, view activation, and project switches, which have no single
 * event source across windows. A 1s sample of in-memory state is cheap,
 * uniform, and cannot leak subscriptions. Known bound: a focus blip shorter
 * than one sample interval is invisible, so "continuous" is proven only at
 * sample granularity — the dwell can be short by strictly less than one
 * second, against a threshold chosen with that slack in mind. Sub-second
 * focus round-trips while the same project stays active read as continued
 * attention, which is close enough to the truth not to buy event plumbing.
 */
export class CompletionAcknowledgementService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dwellProjectId: string | null = null;
  private dwellSince = 0;

  constructor(private readonly deps: CompletionAcknowledgementDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sample(), COMPLETION_ACK_SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.dwellProjectId = null;
    this.dwellSince = 0;
  }

  /** One observation tick. Exposed for tests; production runs it on a timer. */
  sample(): void {
    const now = this.deps.now?.() ?? Date.now();
    const observed = this.deps.getObservedProjectId();

    // Losing focus or switching away resets the dwell — the two seconds must
    // be continuous, so a sub-dwell glance can never clear review work.
    if (observed === null) {
      this.dwellProjectId = null;
      return;
    }
    if (observed !== this.dwellProjectId) {
      this.dwellProjectId = observed;
      this.dwellSince = now;
      return;
    }

    const entry = this.deps.getStatusMap()[observed];
    if (!entry || entry.unacknowledgedCompletedAgentCount <= 0) return;
    const latest = entry.latestUnacknowledgedCompletionAt;
    if (latest === undefined) return;

    // The dwell clock starts at whichever is later: when the project came
    // under observation, or when the newest completion landed. A completion
    // that arrives while the user is already looking still gets its own two
    // seconds on screen before it is considered seen.
    const anchor = Math.max(this.dwellSince, latest);
    if (now - anchor < COMPLETION_ACK_DWELL_MS) return;

    // Under disk pressure the stamp would be dropped; retry on a later tick
    // rather than pretending the acknowledgement happened.
    if (getWritesSuppressed()) return;

    // Stamp exactly what the dwell proved was seen. Everything visible is
    // covered; a completion landing after `latest` stays unacknowledged and
    // re-anchors the dwell above.
    this.deps.markSeen(observed, latest);
    this.deps.onAcknowledged();
  }
}
