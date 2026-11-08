import { randomUUID } from "node:crypto";
import {
  COMPOSER_HOLD_TTL_MS,
  type ComposerHoldDropReason,
  type ComposerHoldChange,
  type ComposerHoldOutcome,
  type HeldComposerSend,
} from "../../../shared/types/ipc/composerHold.js";
import {
  COMPOSER_PROMPT_OWNER,
  foreignPromptInputAt,
  foreignPromptInputMoved,
} from "../../../shared/utils/terminalInputProvenance.js";
import { EXACT_PROMPT_GATE, evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";
import type {
  LaneWake,
  LaneWakeCheck,
  LaneWakeEvidence,
  LaneWakeOutcome,
  NotifyTerminalInfo,
  OwnPane,
} from "../mcp-server/terminalNotify.js";

/** A hold on the wake engine's queue, which takes wakes with the MCP server off. */
export interface ComposerWakeHold {
  queueWake(pane: OwnPane, projectId: string, wake: LaneWake): void;
  release(): void;
}

export interface ComposerSendHoldDeps {
  openWakes(): ComposerWakeHold;
  /** The pane's own notice line, so its notices and this share one writer. */
  paneFor(terminalId: string): OwnPane;
  getLiveGeneration(terminalId: string): number | null;
  getTerminalProjectId(terminalId: string): string | null;
  /** Read once a line stops taking a held send, to say why. Null when it can't be read. */
  readTerminal(terminalId: string): Promise<NotifyTerminalInfo | null>;
  publish(projectId: string, change: ComposerHoldChange): void;
  now?: () => number;
  newToken?: () => string;
}

export interface ComposerHoldRequest {
  terminalId: string;
  projectId: string;
  generation: number;
  text: string;
  imagePaths: readonly string[];
  /** The terminal as read when the send was held: the run it is for and its input so far. */
  info: NotifyTerminalInfo;
  /**
   * Whether the screen that held it still drives the project, asked again
   * before it is typed: a send from a screen that stopped driving isn't.
   */
  authorize(): boolean;
}

export type ComposerHoldAdmission =
  { ok: true; send: HeldComposerSend } | { ok: false; reason: "already-held" | "unavailable" };

interface Entry {
  readonly send: HeldComposerSend;
  readonly projectId: string;
  readonly generation: number;
  readonly agentIncarnation: number | undefined;
  readonly agentSessionId: string | undefined;
  readonly worktreeId: string | undefined;
  readonly promptBaseline: number | undefined;
  readonly authorize: () => boolean;
  /** Nothing more is typed or withdrawn. */
  ended: boolean;
  /** Its outcome went to the project's views. */
  published: boolean;
}

/**
 * Sends a pane's composer held while its agent works (#16379), one per pane.
 * Each rides the pane's own notice line as a lane wake, so one writer types
 * into that prompt, and goes only when the pane waits at its own prompt: never
 * mid-turn, at a question or at an approval. Any input that could reach the
 * prompt since it was held, a restart, or the pane closing drops it, and its
 * views are told why. Kept in memory only.
 */
export class ComposerSendHold {
  private readonly entries = new Map<string, Entry>();
  private wakes: ComposerWakeHold | null = null;
  private releaseQueued = false;
  private disposed = false;

  constructor(private readonly deps: ComposerSendHoldDeps) {}

  hold(request: ComposerHoldRequest): ComposerHoldAdmission {
    if (this.disposed) return { ok: false, reason: "unavailable" };
    if (this.entries.has(request.terminalId)) return { ok: false, reason: "already-held" };
    const now = this.now();
    const token = this.deps.newToken?.() ?? randomUUID();
    const { info } = request;
    const entry: Entry = {
      send: {
        terminalId: request.terminalId,
        token,
        text: request.text,
        imagePaths: [...request.imagePaths],
        heldAt: now,
        expiresAt: now + COMPOSER_HOLD_TTL_MS,
        status: "held",
      },
      projectId: request.projectId,
      generation: request.generation,
      agentIncarnation: info.agentIncarnation,
      agentSessionId: info.agentSessionId,
      worktreeId: info.worktreeId,
      promptBaseline: foreignPromptInputAt(info, COMPOSER_PROMPT_OWNER),
      authorize: request.authorize,
      ended: false,
      published: false,
    };
    this.entries.set(request.terminalId, entry);
    const wake: LaneWake = {
      id: token,
      kind: "composer",
      composer: { text: request.text, imagePaths: entry.send.imagePaths },
      maxPendingMs: COMPOSER_HOLD_TTL_MS,
      recheck: (current) => this.recheck(entry, current),
      beforeType: () => this.beforeType(entry),
      report: (outcome, evidence) => this.report(entry, outcome, evidence),
    };
    try {
      this.wakes ??= this.deps.openWakes();
      this.wakes.queueWake(this.deps.paneFor(request.terminalId), request.projectId, wake);
    } catch (err) {
      console.error("[ComposerSendHold] Queuing a held send failed:", err);
      entry.published = true;
      this.forget(entry);
      return { ok: false, reason: "unavailable" };
    }
    // The engine answers some refusals synchronously, through `report`. The
    // caller hears it wasn't held, so its views hear nothing of it.
    if (entry.ended) {
      entry.published = true;
      this.forget(entry);
      return { ok: false, reason: "unavailable" };
    }
    this.publish(entry);
    return { ok: true, send: copyOf(entry.send) };
  }

  /** Withdraw `token` if it hasn't started on its way to the terminal. */
  withdraw(terminalId: string, token: string, projectId: string): boolean {
    const entry = this.entries.get(terminalId);
    if (entry === undefined || entry.send.token !== token || entry.projectId !== projectId) {
      return false;
    }
    if (entry.ended || entry.send.status !== "held") return false;
    this.end(entry, { kind: "withdrawn" });
    return true;
  }

  /** The pane was closed or its agent restarted: what it holds is dropped, saying which. */
  endForTerminal(terminalId: string, reason: "restarted" | "closed"): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined || entry.ended || entry.send.status !== "held") return;
    this.end(entry, { kind: "dropped", reason });
  }

  list(projectId: string): HeldComposerSend[] {
    return [...this.entries.values()]
      .filter((entry) => entry.projectId === projectId && !entry.ended)
      .map((entry) => copyOf(entry.send));
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      this.end(entry, { kind: "dropped", reason: "stopped" });
    }
    this.wakes?.release();
    this.wakes = null;
  }

  private recheck(entry: Entry, info?: NotifyTerminalInfo): LaneWakeCheck {
    if (entry.ended) return { kind: "unavailable", reason: "ended" };
    const drop = (reason: ComposerHoldDropReason): LaneWakeCheck => {
      this.end(entry, { kind: "dropped", reason });
      return { kind: "unavailable", reason };
    };
    const { terminalId } = entry.send;
    if (this.now() >= entry.send.expiresAt) return drop("expired");
    const projectId = this.deps.getTerminalProjectId(terminalId);
    if (projectId === null) return drop("ended");
    if (projectId !== entry.projectId) return drop("closed");
    const generation = this.deps.getLiveGeneration(terminalId);
    if (generation !== entry.generation) return drop(generation === null ? "ended" : "restarted");
    if (info === undefined) return { kind: "ready" };
    if (info.isTrashed === true) return drop("closed");
    if (
      info.isExited === true ||
      info.hasPty === false ||
      info.isClosing === true ||
      info.agentState === "exited"
    ) {
      return drop("ended");
    }
    if (info.projectId !== undefined && info.projectId !== entry.projectId) return drop("closed");
    if (
      info.agentIncarnation !== entry.agentIncarnation ||
      (info.launchGeneration !== undefined && info.launchGeneration !== entry.generation) ||
      (entry.agentSessionId !== undefined && info.agentSessionId !== entry.agentSessionId) ||
      (info.worktreeId ?? "") !== (entry.worktreeId ?? "")
    ) {
      return drop("restarted");
    }
    // Keys pressed at an approval dialog aren't prompt input and leave it be;
    // anything else reaching the agent since it was held moved the moment on.
    if (foreignPromptInputMoved(info, COMPOSER_PROMPT_OWNER, entry.promptBaseline)) {
      return drop("typed");
    }
    let authorized: boolean;
    try {
      authorized = entry.authorize();
    } catch {
      authorized = false;
    }
    if (!authorized) return drop("driven-elsewhere");
    const verdict = evaluateWakeGate(info, EXACT_PROMPT_GATE);
    return verdict.kind === "ready" ? verdict : { kind: "held", reason: verdict.reason };
  }

  private beforeType(entry: Entry): boolean {
    if (entry.ended || entry.send.status !== "held") return false;
    entry.send.status = "sending";
    this.publish(entry);
    return true;
  }

  private report(entry: Entry, outcome: LaneWakeOutcome, evidence?: LaneWakeEvidence): void {
    if (outcome.kind === "held" || entry.ended) return;
    const sending = entry.send.status === "sending";
    if (outcome.kind === "delivered" && sending) {
      const written = evidence?.phase === "pty_written" && evidence.submissionToken !== undefined;
      this.end(entry, written ? { kind: "delivered" } : { kind: "dropped", reason: "unconfirmed" });
      return;
    }
    if (outcome.kind === "ambiguous" || sending) {
      this.end(entry, { kind: "dropped", reason: "unconfirmed" });
      return;
    }
    if (outcome.kind === "unavailable" && outcome.reason === "expired") {
      this.end(entry, { kind: "dropped", reason: "expired" });
      return;
    }
    // The line stopped taking it without saying why: the pane exited, was
    // closed, or its notices were stopped. Nothing is typed from here on.
    this.forget(entry);
    void this.classifyStop(entry);
  }

  private async classifyStop(entry: Entry): Promise<void> {
    let reason: ComposerHoldDropReason = "stopped";
    try {
      const { terminalId } = entry.send;
      const generation = this.deps.getLiveGeneration(terminalId);
      const info = await this.deps.readTerminal(terminalId);
      if (generation !== null && generation !== entry.generation) reason = "restarted";
      else if (info === null || info.hasPty === false || info.isExited === true) reason = "ended";
      else if (info.isTrashed === true) reason = "closed";
      else if (info.agentState === "exited" || info.isClosing === true) reason = "ended";
      else if (info.agentIncarnation !== entry.agentIncarnation) reason = "restarted";
    } catch {
      // An unreadable terminal says nothing more than that it stopped.
    }
    this.end(entry, { kind: "dropped", reason });
  }

  private end(entry: Entry, outcome: ComposerHoldOutcome): void {
    if (entry.published) return;
    entry.published = true;
    this.forget(entry);
    const { terminalId } = entry.send;
    // A send held since this one stopped is what the pane holds now.
    const current = this.entries.get(terminalId);
    const { token, text, imagePaths } = entry.send;
    this.safePublish(entry.projectId, {
      terminalId,
      held: current === undefined ? null : copyOf(current.send),
      ended:
        outcome.kind === "dropped"
          ? { token, outcome, text, imagePaths: [...imagePaths] }
          : { token, outcome },
    });
  }

  private forget(entry: Entry): void {
    entry.ended = true;
    if (this.entries.get(entry.send.terminalId) === entry) {
      this.entries.delete(entry.send.terminalId);
    }
    this.queueRelease();
  }

  /**
   * Let the wake engine go once nothing is held. Never from inside one of its
   * own callbacks: the release walks the panes it is reporting from.
   */
  private queueRelease(): void {
    if (this.releaseQueued || this.wakes === null) return;
    this.releaseQueued = true;
    queueMicrotask(() => {
      this.releaseQueued = false;
      if (this.entries.size > 0 || this.wakes === null) return;
      const wakes = this.wakes;
      this.wakes = null;
      wakes.release();
    });
  }

  private publish(entry: Entry): void {
    this.safePublish(entry.projectId, {
      terminalId: entry.send.terminalId,
      held: copyOf(entry.send),
    });
  }

  private safePublish(projectId: string, change: ComposerHoldChange): void {
    try {
      this.deps.publish(projectId, change);
    } catch (err) {
      console.error("[ComposerSendHold] Publishing a held send's change failed:", err);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function copyOf(send: HeldComposerSend): HeldComposerSend {
  return { ...send, imagePaths: [...send.imagePaths] };
}
