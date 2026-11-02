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
}

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
  /** Moves or closes the pane, unless someone is using it. */
  apply: (target: ArmedTerminal) => Promise<WhenDoneOutcome>;
  isShuttingDown: () => boolean;
  /** Called when the first terminal is armed (true) and when the last one stops being (false). */
  onActiveChange?: (active: boolean) => void;
  mintCode?: () => string;
  logWarn?: (message: string, error?: unknown) => void;
}

export class TerminalWhenDoneError extends Error {}

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
  private readonly armed = new Map<string, ArmedTerminal>();
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
  async set(terminalId: string, choice: TerminalWhenDoneChoice, projectId: string): Promise<void> {
    if (choice === "keep") {
      const current = this.armed.get(terminalId);
      if (current && current.projectId !== projectId) {
        throw new TerminalWhenDoneError(`Terminal ${terminalId} isn't in this project.`);
      }
      this.disarm(terminalId);
      return;
    }
    const incarnation = await this.deps.readIncarnation(terminalId);
    if (!incarnation || incarnation.projectId !== projectId) {
      throw new TerminalWhenDoneError(`Terminal ${terminalId} has no running agent to hand back.`);
    }
    // The read was async: a restart asked for meanwhile is a new incarnation.
    if (this.deps.currentGeneration(terminalId) !== incarnation.launchGeneration) {
      throw new TerminalWhenDoneError(`Terminal ${terminalId} restarted. Nothing was armed.`);
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
    });
    if (!wasActive) this.deps.onActiveChange?.(true);
    this.deps.notify(projectId, { terminalId, choice });
    this.deps.submitInstruction(terminalId, buildHandbackInstruction(code, "run"), code);
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
    if (!armed || armed.spawnedAt !== report.spawnedAt) return;
    if (armed.outstanding === null || armed.outstanding !== report.code) return;
    armed.outstanding = null;
    if (report.report !== "done") return;
    if (this.deps.currentGeneration(report.terminalId) !== armed.launchGeneration) {
      this.disarm(report.terminalId);
      return;
    }
    // A quit is closing every terminal its own way.
    if (this.deps.isShuttingDown()) return;
    void this.deps
      .apply({ ...armed })
      .then((outcome) => {
        if (outcome === "applied" && armed.choice === "close") this.disarmIf(armed);
      })
      .catch((error: unknown) => {
        this.logWarn(`[TerminalWhenDone] Couldn't apply terminal ${armed.terminalId}'s choice:`, error);
      });
  }

  /** The incarnation exited, or its agent left the PTY. `spawnedAt` absent matches any. */
  handleExit(terminalId: string, spawnedAt?: number): void {
    const armed = this.armed.get(terminalId);
    if (!armed) return;
    if (spawnedAt !== undefined && armed.spawnedAt !== spawnedAt) return;
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
      // A restart the lifecycle events haven't reported yet still isn't armed.
      if (this.deps.currentGeneration(armed.terminalId) !== armed.launchGeneration) continue;
      entries.push({ terminalId: armed.terminalId, choice: armed.choice });
    }
    return entries;
  }

  /** @internal Tests only. */
  peek(terminalId: string): Readonly<ArmedTerminal> | undefined {
    return this.armed.get(terminalId);
  }

  private disarmIf(armed: ArmedTerminal): void {
    if (this.armed.get(armed.terminalId) === armed) this.disarm(armed.terminalId);
  }

  private disarm(terminalId: string): void {
    const armed = this.armed.get(terminalId);
    if (!armed) return;
    this.armed.delete(terminalId);
    this.deps.notify(armed.projectId, { terminalId, choice: "keep" });
    if (this.armed.size === 0) this.deps.onActiveChange?.(false);
  }
}
