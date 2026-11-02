import type { HandbackReport } from "../../../shared/types/handback.js";
import type {
  TerminalWhenDone as TerminalWhenDoneChoice,
  TerminalWhenDoneChange,
  TerminalWhenDoneEntry,
} from "../../../shared/types/ipc/terminalWhenDone.js";
import {
  appendHandbackInstruction,
  buildHandbackInstruction,
  mintHandbackCode,
  withoutHandbackInstruction,
} from "../../../shared/utils/handback.js";

export type ArmedChoice = Exclude<TerminalWhenDoneChoice, "keep">;

/** The agent incarnation a choice is armed on, as the host answered for it. */
export interface WhenDoneIncarnation {
  readonly projectId: string;
  readonly spawnedAt: number;
  readonly launchGeneration: number | undefined;
}

export interface ArmedTerminal extends WhenDoneIncarnation {
  readonly terminalId: string;
  readonly choice: ArmedChoice;
  /**
   * The code minted for the terminal's outstanding request, the only one a
   * report may act on; null once it was answered or a later send superseded
   * it without asking.
   */
  outstanding: string | null;
  /** Moves on every send Daintree makes to the terminal, so a report can tell newer work arrived. */
  revision: number;
}

/**
 * A fresh agent launch whose first prompt already carries the instruction for
 * `code` (#16172): a recipe step's When done.
 */
export interface WhenDoneLaunch {
  readonly terminalId: string;
  readonly projectId: string;
  /** The generation main gave the spawn. */
  readonly launchGeneration: number;
  readonly choice: ArmedChoice;
  readonly code: string;
}

/** The host's answer to a spawn, as far as a launch armed on it needs. */
export interface WhenDoneSpawnResult {
  readonly success: boolean;
  readonly launchGeneration?: number;
  readonly spawnedAt?: number;
}

/**
 * An armed terminal as the service holds it. A launch armed before its spawn
 * is confirmed has no `spawnedAt` yet: nothing can act for it, and it isn't
 * shown as armed, until the host names its incarnation.
 */
type HeldTerminal = Omit<ArmedTerminal, "spawnedAt"> & { spawnedAt: number | null };

/** A submission to an armed terminal, carrying its own fresh code. */
export interface ArmedSubmission {
  readonly text: string;
  readonly handbackCode: string;
  readonly handbackInstruction: "run";
}

/** A marker the pty-host saw retire its code (`agent:run-handback-observed`). */
export interface WhenDoneReport {
  readonly terminalId: string;
  readonly spawnedAt: number;
  readonly code: string;
  readonly report: HandbackReport;
}

export type WhenDoneOutcome = "applied" | "in-use" | "not-applied";

export interface TerminalWhenDoneDeps {
  /** The terminal's live agent incarnation, or null when it has none that can be armed. */
  readIncarnation: (terminalId: string) => Promise<WhenDoneIncarnation | null>;
  /** The launch generation main last minted for the id. */
  currentGeneration: (terminalId: string) => number | undefined;
  /** Sends `text` as a prompt of its own, already carrying the instruction for `code`. */
  submitInstruction: (terminalId: string, text: string, code: string) => void;
  notify: (projectId: string, change: TerminalWhenDoneChange) => void;
  /**
   * Moves or closes the pane, unless someone is using it. `stillCurrent` turns
   * false once the choice, the request or the incarnation it acts for has
   * changed; it is asked again after every wait and just before acting.
   */
  apply: (target: ArmedTerminal, stillCurrent: () => boolean) => Promise<WhenDoneOutcome>;
  isShuttingDown: () => boolean;
  /** Called when the first terminal is armed (true) and when the last one stops being (false). */
  onActiveChange?: (active: boolean) => void;
  mintCode?: () => string;
  logWarn?: (message: string, error?: unknown) => void;
}

export class TerminalWhenDoneError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "DRIVEN_ELSEWHERE" = "NOT_FOUND"
  ) {
    super(message);
  }
}

/**
 * A When done choice on any agent terminal (#16171): keep (the default, never
 * stored), background, or close, applied when the agent reports `done` for the
 * request Daintree is waiting on.
 *
 * Arming sends the agent the handback instruction with a fresh code, and while
 * the terminal stays armed every prompt Daintree submits to it carries its own
 * fresh code ({@link decorate}), so only the newest request can answer. A
 * marker acts only for that code, from that incarnation, once; `needs-you`
 * answers the request without moving anything, and agent state, exits and
 * silence never act. The choice lives in main's memory alone and belongs to
 * one incarnation: a restart, a crash replay or the agent leaving drops it, so
 * nothing ever acts on a code minted for an agent that is no longer there.
 */
export class TerminalWhenDone {
  private readonly armed = new Map<string, HeldTerminal>();
  /** The latest `set` asked for each terminal, so an older one answering later commits nothing. */
  private readonly setSeq = new Map<string, number>();
  private nextSetSeq = 0;
  private readonly mintCode: () => string;
  private readonly logWarn: (message: string, error?: unknown) => void;

  constructor(private readonly deps: TerminalWhenDoneDeps) {
    this.mintCode = deps.mintCode ?? mintHandbackCode;
    this.logWarn = deps.logWarn ?? console.warn;
  }

  /**
   * Sets a terminal's choice. Any choice but keep sends the instruction with a
   * fresh code at once, so an agent working on a prompt typed straight into it
   * hands that work back; choosing again renews the request.
   */
  async set(
    terminalId: string,
    choice: TerminalWhenDoneChoice,
    projectId: string,
    /** The caller may still type into the terminal; asked again once the host answers. */
    mayArm: () => boolean = () => true
  ): Promise<void> {
    const seq = ++this.nextSetSeq;
    this.setSeq.set(terminalId, seq);
    const current = this.armed.get(terminalId);
    // A new choice is newer word than any done already being applied.
    if (current?.projectId === projectId) current.revision += 1;
    if (choice === "keep") {
      // Keep commits at once, so nothing asked before it may commit after.
      this.setSeq.delete(terminalId);
      if (current && current.projectId !== projectId) {
        throw new TerminalWhenDoneError(`Terminal ${terminalId} isn't in this project.`);
      }
      this.disarm(terminalId);
      return;
    }
    const incarnation = await this.deps.readIncarnation(terminalId);
    // A later choice for the terminal was asked for meanwhile, Keep included: it stands.
    if (this.setSeq.get(terminalId) !== seq) return;
    this.setSeq.delete(terminalId);
    if (!incarnation || incarnation.projectId !== projectId) {
      throw new TerminalWhenDoneError(`Terminal ${terminalId} has no running agent to hand back.`);
    }
    // The read was async: a restart asked for meanwhile is a new incarnation.
    if (this.deps.currentGeneration(terminalId) !== incarnation.launchGeneration) {
      throw new TerminalWhenDoneError(`Terminal ${terminalId} restarted. Nothing was armed.`);
    }
    if (!mayArm()) {
      throw new TerminalWhenDoneError(
        "This project is being driven from another screen.",
        "DRIVEN_ELSEWHERE"
      );
    }
    const code = this.mintCode();
    const wasActive = this.armed.size > 0;
    this.armed.set(terminalId, {
      terminalId,
      projectId: incarnation.projectId,
      spawnedAt: incarnation.spawnedAt,
      launchGeneration: incarnation.launchGeneration,
      choice,
      outstanding: code,
      revision: 0,
    });
    if (!wasActive) this.deps.onActiveChange?.(true);
    this.deps.notify(projectId, { terminalId, choice });
    this.deps.submitInstruction(terminalId, buildHandbackInstruction(code, "run"), code);
  }

  /**
   * Arms a fresh agent launch with the choice a recipe step asked for
   * (#16172). Nothing is sent: the launch's own prompt carries the instruction
   * and is the outstanding request. It counts as armed once the host confirms
   * the spawn ({@link handleSpawnResult}). False, arming nothing, when the id
   * already holds a choice or has been respawned since.
   */
  armLaunch(launch: WhenDoneLaunch): boolean {
    const { terminalId } = launch;
    if (this.armed.has(terminalId)) return false;
    if (this.deps.currentGeneration(terminalId) !== launch.launchGeneration) return false;
    const wasActive = this.armed.size > 0;
    this.armed.set(terminalId, {
      terminalId,
      projectId: launch.projectId,
      spawnedAt: null,
      launchGeneration: launch.launchGeneration,
      choice: launch.choice,
      outstanding: launch.code,
      revision: 0,
    });
    if (!wasActive) this.deps.onActiveChange?.(true);
    return true;
  }

  /**
   * The host answered a spawn. A launch armed on it is confirmed with the
   * incarnation the host names, or dropped when the spawn failed.
   */
  handleSpawnResult(terminalId: string, result: WhenDoneSpawnResult): void {
    const armed = this.armed.get(terminalId);
    if (!armed || armed.spawnedAt !== null) return;
    const generation = result.launchGeneration ?? this.deps.currentGeneration(terminalId);
    if (generation !== armed.launchGeneration) return;
    if (
      !result.success ||
      result.spawnedAt === undefined ||
      this.deps.currentGeneration(terminalId) !== armed.launchGeneration
    ) {
      this.disarm(terminalId);
      return;
    }
    armed.spawnedAt = result.spawnedAt;
    this.deps.notify(armed.projectId, { terminalId, choice: armed.choice });
  }

  /**
   * The submission as an armed terminal receives it: `text` with the
   * instruction for a fresh code, which becomes the outstanding request. A
   * caller's own code is kept, with its instruction swapped for the one that
   * offers `needs-you`, so its own wait still sees the marker. Null leaves the
   * submission as it was: the terminal isn't armed, or the send is no prompt
   * (a bare Enter, an agent CLI's slash command), which answers nothing and
   * supersedes the outstanding request on the host.
   */
  decorate(terminalId: string, text: string, handbackCode?: string): ArmedSubmission | null {
    const armed = this.armed.get(terminalId);
    if (!armed) return null;
    if (this.deps.currentGeneration(terminalId) !== armed.launchGeneration) {
      this.disarm(terminalId);
      return null;
    }
    // Any send is newer work, so a done already being applied stops short.
    armed.revision += 1;
    const trimmed = text.trimStart();
    if (trimmed === "" || trimmed.startsWith("/")) {
      armed.outstanding = null;
      return null;
    }
    const code = handbackCode ?? this.mintCode();
    armed.outstanding = code;
    return {
      text: appendHandbackInstruction(withoutHandbackInstruction(text, code), code, "run"),
      handbackCode: code,
      handbackInstruction: "run",
    };
  }

  /** A marker retired its code on the host. Acts only for the outstanding request, once. */
  handleReport(report: WhenDoneReport): void {
    const armed = this.armed.get(report.terminalId);
    if (!armed || armed.spawnedAt === null || armed.spawnedAt !== report.spawnedAt) return;
    if (armed.outstanding === null || armed.outstanding !== report.code) return;
    armed.outstanding = null;
    if (report.report !== "done") return;
    if (this.deps.currentGeneration(report.terminalId) !== armed.launchGeneration) {
      this.disarm(report.terminalId);
      return;
    }
    // A quit is closing every terminal its own way.
    if (this.deps.isShuttingDown()) return;
    const revision = armed.revision;
    const stillCurrent = (): boolean =>
      this.armed.get(armed.terminalId) === armed &&
      armed.revision === revision &&
      this.deps.currentGeneration(armed.terminalId) === armed.launchGeneration &&
      !this.deps.isShuttingDown();
    void this.deps
      .apply({ ...armed, spawnedAt: report.spawnedAt }, stillCurrent)
      .then((outcome) => {
        if (outcome === "applied" && armed.choice === "close") this.disarmIf(armed);
      })
      .catch((error: unknown) => {
        this.logWarn(
          `[TerminalWhenDone] Couldn't apply terminal ${armed.terminalId}'s choice:`,
          error
        );
      });
  }

  /** The incarnation exited, or its agent left the PTY. `spawnedAt` absent matches any. */
  handleExit(terminalId: string, spawnedAt?: number): void {
    const armed = this.armed.get(terminalId);
    if (!armed) return;
    // A launch not yet confirmed has no other incarnation an exit could be.
    if (spawnedAt !== undefined && armed.spawnedAt !== null && armed.spawnedAt !== spawnedAt) {
      return;
    }
    this.disarm(terminalId);
  }

  /** The host holding the incarnation died; a replay is a new one. */
  handleIncarnationLost(terminalId: string, launchGeneration: number): void {
    const armed = this.armed.get(terminalId);
    if (!armed) return;
    if (armed.launchGeneration !== undefined && armed.launchGeneration !== launchGeneration) return;
    this.disarm(terminalId);
  }

  list(projectId: string): TerminalWhenDoneEntry[] {
    const entries: TerminalWhenDoneEntry[] = [];
    for (const armed of this.armed.values()) {
      if (armed.projectId !== projectId) continue;
      // A launch the host hasn't confirmed isn't armed yet.
      if (armed.spawnedAt === null) continue;
      // A restart the lifecycle events haven't reported yet still isn't armed.
      if (this.deps.currentGeneration(armed.terminalId) !== armed.launchGeneration) continue;
      entries.push({ terminalId: armed.terminalId, choice: armed.choice });
    }
    return entries;
  }

  /** @internal Tests only. */
  peek(terminalId: string): Readonly<HeldTerminal> | undefined {
    return this.armed.get(terminalId);
  }

  private disarmIf(armed: HeldTerminal): void {
    if (this.armed.get(armed.terminalId) === armed) this.disarm(armed.terminalId);
  }

  private disarm(terminalId: string): void {
    const armed = this.armed.get(terminalId);
    if (!armed) return;
    this.armed.delete(terminalId);
    // A launch dropped before its spawn was confirmed was never shown as armed.
    if (armed.spawnedAt !== null) {
      this.deps.notify(armed.projectId, { terminalId, choice: "keep" });
    }
    if (this.armed.size === 0) this.deps.onActiveChange?.(false);
  }
}
