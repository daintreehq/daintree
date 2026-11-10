import { randomUUID } from "node:crypto";
import {
  COMPOSER_HOLD_TTL_MS,
  type ComposerHoldDropReason,
  type ComposerHoldChange,
  type ComposerHoldOutcome,
  type ComposerHoldSendNowResult,
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
  /**
   * Read once a line stops taking a held send, to say why, and to follow one
   * sent now by its `submissionToken`. Null when it can't be read.
   */
  readTerminal(terminalId: string, submissionToken?: string): Promise<NotifyTerminalInfo | null>;
  /**
   * Type a held send now, as the composer types a send: whatever the pane is
   * doing, filed as the person's prompt.
   */
  submit(
    terminalId: string,
    text: string,
    submissionToken: string,
    imagePaths: readonly string[]
  ): void;
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

export interface ComposerSendNowRequest {
  terminalId: string;
  token: string;
  projectId: string;
  /** The view asking can't take input: the send ends dropped rather than typed. */
  inputBlocked: boolean;
  /** Whether the screen asking drives the project, read now. */
  authorize(): boolean;
}

/**
 * Reads of a send typed now, until its write is confirmed: about half a
 * minute, for a send whose images take a while to paste.
 */
const SEND_NOW_CONFIRM_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

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
  /** Sent now, outside the pane's notice line, which lets it go unreported. */
  sentNow: boolean;
  /** The next read of a send typed now. */
  confirmTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Sends a pane's composer held while its agent works (#16379), one per pane.
 * Each rides the pane's own notice line as a lane wake, so one writer types
 * into that prompt, and goes only when the pane waits at its own prompt: never
 * mid-turn, at a question or at an approval. Any input that could reach the
 * prompt since it was held, a restart, or the pane closing drops it, and its
 * views are told why. Send now types one at once instead, outside that line
 * (#16745). Kept in memory only.
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
      sentNow: false,
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

  /**
   * Type `token` into its pane now, whatever the pane was last seen doing.
   * It is claimed from the pane's notice line synchronously with the submit,
   * so whichever of the two takes it first types it, once. It is dropped, and
   * its views told why, when the panel can't take input, another screen
   * drives the project, or the pane's line would have dropped it.
   */
  async sendNow(request: ComposerSendNowRequest): Promise<ComposerHoldSendNowResult> {
    const entry = this.entries.get(request.terminalId);
    if (
      this.disposed ||
      entry === undefined ||
      entry.ended ||
      entry.send.token !== request.token ||
      entry.projectId !== request.projectId
    ) {
      return { outcome: "not-held" };
    }
    if (entry.send.status !== "held") return { outcome: "already-sending" };
    const drop = (reason: ComposerHoldDropReason): ComposerHoldSendNowResult => {
      this.end(entry, { kind: "dropped", reason });
      return { outcome: "dropped" };
    };
    // Main's word on who drives first: a view blocked for that reason says so.
    if (!safely(request.authorize)) return drop("driven-elsewhere");
    if (request.inputBlocked) return drop("input-blocked");
    let info: NotifyTerminalInfo | null;
    try {
      info = await this.deps.readTerminal(request.terminalId);
    } catch {
      info = null;
    }
    // The pane's prompt may have taken it, or something ended it, meanwhile.
    if (entry.ended) return { outcome: "not-held" };
    if (entry.send.status !== "held") return { outcome: "already-sending" };
    if (info === null) return drop("ended");
    const reason = this.dropReason(entry, info);
    if (reason !== null) return drop(reason);
    if (!safely(request.authorize)) return drop("driven-elsewhere");
    // Nothing awaited from here to the submit: the line's `beforeType` refuses it now.
    entry.sentNow = true;
    entry.send.status = "sending";
    this.publish(entry);
    const submissionToken = this.deps.newToken?.() ?? randomUUID();
    try {
      this.deps.submit(request.terminalId, entry.send.text, submissionToken, entry.send.imagePaths);
    } catch (err) {
      console.error("[ComposerSendHold] Sending a held send now failed:", err);
      // Whether any of it reached the terminal is unknown: it is never typed again.
      this.end(entry, { kind: "dropped", reason: "unconfirmed" });
      return { outcome: "dropped" };
    }
    this.followSendNow(entry, submissionToken, 0);
    return { outcome: "sending" };
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
    // Sent now, outside the line: the line lets it go and its outcome stays with the send.
    if (entry.sentNow) return { kind: "unavailable", reason: "sent-now" };
    const reason = this.dropReason(entry, info);
    if (reason !== null) {
      this.end(entry, { kind: "dropped", reason });
      return { kind: "unavailable", reason };
    }
    if (info === undefined) return { kind: "ready" };
    const verdict = evaluateWakeGate(info, EXACT_PROMPT_GATE);
    return verdict.kind === "ready" ? verdict : { kind: "held", reason: verdict.reason };
  }

  /**
   * Why a held send can no longer be typed, the pane's prompt aside; null
   * while it can. `info` is the pane's record as just read: without one, only
   * what main knows of the terminal is checked.
   */
  private dropReason(entry: Entry, info?: NotifyTerminalInfo): ComposerHoldDropReason | null {
    const { terminalId } = entry.send;
    if (this.now() >= entry.send.expiresAt) return "expired";
    const projectId = this.deps.getTerminalProjectId(terminalId);
    if (projectId === null) return "ended";
    if (projectId !== entry.projectId) return "closed";
    const generation = this.deps.getLiveGeneration(terminalId);
    if (generation !== entry.generation) return generation === null ? "ended" : "restarted";
    if (info === undefined) return null;
    if (info.isTrashed === true) return "closed";
    if (
      info.isExited === true ||
      info.hasPty === false ||
      info.isClosing === true ||
      info.agentState === "exited"
    ) {
      return "ended";
    }
    if (info.projectId !== undefined && info.projectId !== entry.projectId) return "closed";
    if (
      info.agentIncarnation !== entry.agentIncarnation ||
      (info.launchGeneration !== undefined && info.launchGeneration !== entry.generation) ||
      (entry.agentSessionId !== undefined && info.agentSessionId !== entry.agentSessionId) ||
      (info.worktreeId ?? "") !== (entry.worktreeId ?? "")
    ) {
      return "restarted";
    }
    // Keys pressed at an approval dialog aren't prompt input and leave it be;
    // anything else reaching the agent since it was held moved the moment on.
    if (foreignPromptInputMoved(info, COMPOSER_PROMPT_OWNER, entry.promptBaseline)) {
      return "typed";
    }
    if (!safely(entry.authorize)) return "driven-elsewhere";
    return null;
  }

  /** Read a send typed now after the next delay, until its write is confirmed. */
  private followSendNow(entry: Entry, submissionToken: string, attempt: number): void {
    if (entry.ended) return;
    const delayMs = SEND_NOW_CONFIRM_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      this.end(entry, { kind: "dropped", reason: "unconfirmed" });
      return;
    }
    entry.confirmTimer = setTimeout(() => {
      entry.confirmTimer = undefined;
      void this.confirmSendNow(entry, submissionToken, attempt);
    }, delayMs);
  }

  private async confirmSendNow(
    entry: Entry,
    submissionToken: string,
    attempt: number
  ): Promise<void> {
    if (entry.ended) return;
    let info: NotifyTerminalInfo | null;
    try {
      info = await this.deps.readTerminal(entry.send.terminalId, submissionToken);
    } catch {
      info = null;
    }
    if (entry.ended) return;
    // Only this send's own record speaks for it.
    const phase = info?.submission?.token === submissionToken ? info.submission.phase : undefined;
    if (phase === "pty_written") {
      this.end(entry, { kind: "delivered" });
      return;
    }
    // Refused before any of it was written: the terminal ended or stopped taking input.
    if (phase === "cancelled") {
      const reason = this.stopReason(
        entry,
        info,
        this.deps.getLiveGeneration(entry.send.terminalId)
      );
      this.end(entry, { kind: "dropped", reason: reason ?? "input-blocked" });
      return;
    }
    // Part of it may have been written: never typed again.
    if (phase === "failed" || phase === "unknown") {
      this.end(entry, { kind: "dropped", reason: "unconfirmed" });
      return;
    }
    this.followSendNow(entry, submissionToken, attempt + 1);
  }

  private beforeType(entry: Entry): boolean {
    if (entry.ended || entry.send.status !== "held") return false;
    entry.send.status = "sending";
    this.publish(entry);
    return true;
  }

  private report(entry: Entry, outcome: LaneWakeOutcome, evidence?: LaneWakeEvidence): void {
    if (outcome.kind === "held" || entry.ended || entry.sentNow) return;
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
      reason = this.stopReason(entry, info, generation) ?? "stopped";
    } catch {
      // An unreadable terminal says nothing more than that it stopped.
    }
    this.end(entry, { kind: "dropped", reason });
  }

  /** What the terminal says of why a send stopped going to it, if anything. */
  private stopReason(
    entry: Entry,
    info: NotifyTerminalInfo | null,
    generation: number | null
  ): ComposerHoldDropReason | null {
    if (generation !== null && generation !== entry.generation) return "restarted";
    if (info === null || info.hasPty === false || info.isExited === true) return "ended";
    if (info.isTrashed === true) return "closed";
    if (info.agentState === "exited" || info.isClosing === true) return "ended";
    if (info.agentIncarnation !== entry.agentIncarnation) return "restarted";
    return null;
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
    if (entry.confirmTimer !== undefined) {
      clearTimeout(entry.confirmTimer);
      entry.confirmTimer = undefined;
    }
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

/** A drive-lease read that throws counts as not driving. */
function safely(authorize: () => boolean): boolean {
  try {
    return authorize();
  } catch {
    return false;
  }
}

function copyOf(send: HeldComposerSend): HeldComposerSend {
  return { ...send, imagePaths: [...send.imagePaths] };
}
