import { randomUUID } from "node:crypto";
import { AppError } from "../utils/errorTypes.js";
import type { GlobalAssistantState } from "../../shared/types/ipc/help.js";

/**
 * The installation's one global Daintree Assistant (#14159).
 *
 * Main owns it: its provisioning, its PTY, its credentials and its resume
 * pointer. A window's Assistant panel only ever attaches to it. An attachment
 * is a reader that can be added or dropped at any time — a project switch, a
 * hidden panel, a closed window or an evicted project view removes the
 * attachment and nothing else — so no `webContents` id is pinned to the
 * session, which is what ends a project lane with its view.
 *
 * Input has one owner at a time. Every attachment shows the same PTY; the
 * owner is the one whose keystrokes are accepted. Taking input from another
 * owner is an explicit claim, never a side effect of focus. A vacancy is
 * filled, though (#16098): when the owner's attachment goes, or input has no
 * owner, it goes to the attachment in the most recently focused window that
 * can type, so one person moving between windows never has to take it back.
 * Each change of owner bumps an epoch so a write queued by the previous owner
 * is refused rather than landing in the new owner's line. Composer drafts live
 * in the windows, not here, so a handover cannot overwrite one.
 */

/** Why a run ended; decides whether its conversation is kept for the next one. */
export type GlobalAssistantEndReason =
  "restart" | "discard" | "agent-change" | "launch-failed" | "exited" | "shutdown";

export interface GlobalAssistantProvision {
  sessionId: string;
  sessionPath: string;
  token: string;
  mcpUrl: string | null;
}

export interface GlobalAssistantResume {
  agentId: string;
  agentSessionId: string;
  claimId: string;
}

export interface GlobalAssistantSpawnSpec {
  terminalId: string;
  agentId: string;
  cwd: string;
  env: Record<string, string>;
  /** Reopen this exact conversation; absent, start one. */
  resumeAgentSessionId?: string;
}

export interface GlobalAssistantDeps {
  /** The agent the global assistant runs as now, or null when none can. */
  agentId(): Promise<string | null>;
  provision(agentId: string): Promise<GlobalAssistantProvision | null>;
  /** Claim the exact conversation a previous run left, if any. */
  takeResume(): Promise<GlobalAssistantResume | null>;
  releaseResume(claimId: string): Promise<void>;
  /** Forget the conversation: the next run starts a new one. */
  discardResume(): Promise<void>;
  /** Spawn the PTY; false when nothing started. */
  spawn(spec: GlobalAssistantSpawnSpec): Promise<boolean>;
  /**
   * Revoke the session's credentials, then end its PTY. With `capture` the
   * agent is given the chance to flush and its conversation id is recorded.
   */
  revoke(sessionId: string, options: { capture: boolean }): Promise<void>;
  /** Kill a PTY the session record may not know yet. */
  kill(terminalId: string): void;
  /** Ids of the windows that have been focused, most recent first; read when input needs an owner. */
  focusedWindows(): readonly number[];
}

interface Attachment {
  attachmentId: string;
  webContentsId: number;
  windowId: number;
  /**
   * Whether its view could type to the run now (not behind Canopy, say), so
   * an empty owner's seat may be given to it. An owner keeps input either way.
   */
  eligible: boolean;
}

interface Run {
  sessionId: string;
  terminalId: string;
  agentId: string;
}

const LAUNCH_ENV_KEYS = {
  token: "DAINTREE_MCP_TOKEN",
  url: "DAINTREE_MCP_URL",
} as const;

function refuse(
  code: "VALIDATION" | "STALE_GENERATION" | "NOT_FOUND" | "UNSUPPORTED" | "INTERNAL" | "CANCELLED",
  message: string
): AppError {
  return new AppError({ code, message });
}

export class GlobalAssistantService {
  private generation = 0;
  private launch: Promise<GlobalAssistantState> | null = null;
  private launchGeneration = -1;
  /** The agent the launch in flight chose, so a change of agent can cancel it. */
  private launchAgentId: string | null = null;
  private startingExited = false;
  /** The run being started, known before its PTY is confirmed so teardown can reach it. */
  private starting: Run | null = null;
  private run: Run | null = null;
  private closed = false;
  private teardownTail: Promise<void> = Promise.resolve();
  private readonly attachments = new Map<string, Attachment>();
  private inputOwner: string | null = null;
  private inputEpoch = 0;
  private readonly listeners = new Set<(state: GlobalAssistantState) => void>();

  constructor(private readonly deps: GlobalAssistantDeps) {}

  getState(): GlobalAssistantState {
    return {
      phase: this.run ? "running" : this.launch ? "launching" : "absent",
      generation: this.generation,
      agentId: this.run?.agentId ?? this.starting?.agentId ?? null,
      terminalId: this.run?.terminalId ?? null,
      attachments: [...this.attachments.values()].map(({ attachmentId, windowId }) => ({
        attachmentId,
        windowId,
      })),
      inputOwner: this.inputOwner,
      inputEpoch: this.inputEpoch,
    };
  }

  /** The live run's session and PTY, or null while none is confirmed running. */
  getRunningSession(): { sessionId: string; terminalId: string } | null {
    return this.run ? { sessionId: this.run.sessionId, terminalId: this.run.terminalId } : null;
  }

  /**
   * The view a question for the running assistant is put to the person in
   * (#14161): the one that holds its input, else the latest to attach. Null
   * while no view shows it, so nothing is asked in a window that doesn't.
   */
  presenterWebContentsId(): number | null {
    if (!this.run) return null;
    const owner = this.inputOwner !== null ? this.attachments.get(this.inputOwner) : undefined;
    if (owner) return owner.webContentsId;
    let latest: Attachment | undefined;
    for (const attachment of this.attachments.values()) latest = attachment;
    return latest?.webContentsId ?? null;
  }

  onChange(listener: (state: GlobalAssistantState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The running session, or the one launch every concurrent caller joins. The
   * launch is claimed before the first await, so two windows opening at once
   * provision, spawn and mint credentials once.
   */
  ensureSession(options?: { fresh?: boolean }): Promise<GlobalAssistantState> {
    if (this.closed) {
      return Promise.reject(refuse("CANCELLED", "The app is shutting down."));
    }
    if (this.run) return Promise.resolve(this.getState());
    if (this.launch) {
      if (this.launchGeneration === this.generation) return this.launch;
      // Stopped while starting: let it clean up, then start the one asked for.
      return this.launch.catch(() => undefined).then(() => this.ensureSession(options));
    }
    const generation = this.generation;
    this.launchGeneration = generation;
    const launch: Promise<GlobalAssistantState> = this.runLaunch(
      generation,
      options?.fresh === true
    ).finally(() => {
      if (this.launch === launch) {
        this.launch = null;
        this.launchAgentId = null;
      }
      this.emit();
    });
    this.launch = launch;
    // Every window shows the launch, not only the one that asked for it.
    this.emit();
    return launch;
  }

  private async runLaunch(generation: number, fresh: boolean): Promise<GlobalAssistantState> {
    const superseded = () => generation !== this.generation || this.closed;
    const cancelled = () => refuse("CANCELLED", "The global assistant was stopped while starting.");

    // A run being torn down may still be revoking: never provision beside it,
    // or its cleanup could remove what this launch writes.
    await this.teardownTail;
    if (superseded()) throw cancelled();

    const agentId = await this.deps.agentId();
    if (!agentId) throw refuse("UNSUPPORTED", "No agent is available to run the global assistant.");
    this.launchAgentId = agentId;
    this.startingExited = false;
    if (superseded()) throw cancelled();

    const pending = fresh ? null : await this.deps.takeResume();
    const resume =
      pending && pending.agentId === agentId && pending.agentSessionId ? pending : null;
    const releaseResume = () => {
      if (pending) void this.deps.releaseResume(pending.claimId).catch(() => {});
    };
    if (superseded()) {
      releaseResume();
      throw cancelled();
    }

    let session: GlobalAssistantProvision | null;
    try {
      session = await this.deps.provision(agentId);
    } catch (err) {
      releaseResume();
      throw err;
    }
    if (!session) {
      releaseResume();
      throw refuse("INTERNAL", "The global assistant could not be provisioned.");
    }

    const terminalId = `terminal-${randomUUID()}`;
    const run: Run = { sessionId: session.sessionId, terminalId, agentId };
    this.starting = run;

    if (superseded()) {
      await this.abandon(run, "launch-failed");
      releaseResume();
      throw cancelled();
    }

    let spawned = false;
    try {
      spawned = await this.deps.spawn({
        terminalId,
        agentId,
        cwd: session.sessionPath,
        env: {
          [LAUNCH_ENV_KEYS.token]: session.token,
          ...(session.mcpUrl ? { [LAUNCH_ENV_KEYS.url]: session.mcpUrl } : {}),
        },
        ...(resume ? { resumeAgentSessionId: resume.agentSessionId } : {}),
      });
    } catch (err) {
      console.warn("[GlobalAssistant] Spawn failed:", err);
    }

    // Re-checked after the spawn: a teardown that ran during it has already
    // revoked this session, and a PTY it could not yet see is ours to end.
    if (!spawned || this.startingExited || superseded()) {
      await this.abandon(run, "launch-failed");
      releaseResume();
      throw spawned && !this.startingExited
        ? cancelled()
        : refuse("INTERNAL", "The global assistant failed to start.");
    }

    this.starting = null;
    this.run = run;
    // Teardown left input with nobody: the new run's goes to a reader that can type.
    this.fillVacancy();
    return this.getState();
  }

  /** End a run that never became the live one: credentials first, then the PTY. */
  private async abandon(run: Run, _reason: GlobalAssistantEndReason): Promise<void> {
    if (this.starting === run) this.starting = null;
    await this.deps.revoke(run.sessionId, { capture: false }).catch((err) => {
      console.warn("[GlobalAssistant] Revoking an abandoned session failed:", err);
    });
    this.deps.kill(run.terminalId);
  }

  /**
   * The one way a run ends. Idempotent and serialized: the generation moves on
   * first, so a launch still in flight sees it has been superseded; then the
   * credentials are revoked, then the PTY ends. Only a restart or discard
   * forgets the conversation; shutdown asks the agent to flush it.
   */
  teardown(reason: GlobalAssistantEndReason): Promise<void> {
    // After quit began, only the shutdown capture may end a run: a discard or
    // restart then would erase the conversation it is capturing.
    if (this.closed && reason !== "shutdown") return this.teardownTail;
    this.generation += 1;
    const run = this.run ?? this.starting;
    this.run = null;
    this.starting = null;
    this.releaseInputOwner();
    const work = this.teardownTail.then(async () => {
      if (run) {
        await this.deps
          .revoke(run.sessionId, { capture: reason === "shutdown" })
          .catch((err) => console.warn("[GlobalAssistant] Revoke failed:", err));
        this.deps.kill(run.terminalId);
      }
      if (reason === "restart" || reason === "discard") {
        await this.deps
          .discardResume()
          .catch((err) =>
            console.warn("[GlobalAssistant] Forgetting the conversation failed:", err)
          );
      }
    });
    this.teardownTail = work.catch(() => {});
    void work.finally(() => this.emit());
    this.emit();
    return work;
  }

  /** Start over on a new conversation. */
  async restart(): Promise<GlobalAssistantState> {
    if (this.closed) throw refuse("CANCELLED", "The app is shutting down.");
    await this.teardown("restart");
    return this.ensureSession({ fresh: true });
  }

  /** End the run and forget its conversation; nothing starts it again until asked. */
  discard(): Promise<void> {
    return this.teardown("discard");
  }

  /** The assistant agent changed: the run belongs to the old one. Nothing starts until asked. */
  async onAgentChanged(agentId: string | null): Promise<void> {
    const current = this.run?.agentId ?? this.starting?.agentId ?? this.launchAgentId ?? undefined;
    if (current === undefined || current === agentId) return;
    await this.teardown("agent-change");
  }

  /** The PTY ended by itself; credentials go with it. */
  handleTerminalExit(terminalId: string): void {
    if (this.starting?.terminalId === terminalId) this.startingExited = true;
    if (this.run?.terminalId !== terminalId) return;
    void this.teardown("exited");
  }

  /** Quit began: nothing new starts, however late it is asked for. */
  closeAdmission(): void {
    this.closed = true;
    this.attachments.clear();
  }

  /** App quit: stop admitting, then end the run, capturing its conversation. */
  async shutdown(): Promise<void> {
    this.closeAdmission();
    await this.teardown("shutdown");
  }

  attach(webContentsId: number, windowId: number, eligible = true): string {
    if (this.closed) throw refuse("CANCELLED", "The app is shutting down.");
    const attachmentId = randomUUID();
    this.attachments.set(attachmentId, { attachmentId, webContentsId, windowId, eligible });
    this.fillVacancy();
    this.emit();
    return attachmentId;
  }

  /** Whether the attachment's view can type now; one that can fills a vacancy. */
  setEligible(attachmentId: string, webContentsId: number, eligible: boolean): void {
    const attachment = this.requireAttachment(attachmentId, webContentsId);
    if (attachment.eligible === eligible) return;
    attachment.eligible = eligible;
    if (eligible && this.fillVacancy()) this.emit();
  }

  detach(attachmentId: string, webContentsId?: number): boolean {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) return false;
    if (webContentsId !== undefined && attachment.webContentsId !== webContentsId) return false;
    this.attachments.delete(attachmentId);
    if (this.inputOwner === attachmentId) this.setInputOwner(this.successor());
    this.emit();
    return true;
  }

  /** A view went away: drop its attachments and nothing else. */
  detachWebContents(webContentsId: number): void {
    this.detachWhere((attachment) => attachment.webContentsId === webContentsId);
  }

  /** A window closed: drop the attachments its views held and nothing else. */
  detachWindow(windowId: number): void {
    this.detachWhere((attachment) => attachment.windowId === windowId);
  }

  private detachWhere(match: (attachment: Attachment) => boolean): void {
    let changed = false;
    let ownerLeft = false;
    for (const attachment of [...this.attachments.values()]) {
      if (!match(attachment)) continue;
      this.attachments.delete(attachment.attachmentId);
      if (this.inputOwner === attachment.attachmentId) ownerLeft = true;
      changed = true;
    }
    // Chosen once every match has gone, so input never lands on one leaving with it.
    if (ownerLeft) this.setInputOwner(this.successor());
    if (changed) this.emit();
  }

  /** Take input, explicitly. Only the attachment's own view may claim for it. */
  claimInput(attachmentId: string, webContentsId: number): number {
    const attachment = this.requireAttachment(attachmentId, webContentsId);
    this.setInputOwner(attachment.attachmentId);
    this.emit();
    return this.inputEpoch;
  }

  releaseInput(attachmentId: string, webContentsId: number): void {
    this.requireAttachment(attachmentId, webContentsId);
    if (this.inputOwner !== attachmentId) return;
    this.releaseInputOwner();
    this.emit();
  }

  /** The window view whose attachment holds input now, or null when none does. */
  inputOwnerWebContentsId(): number | null {
    if (this.inputOwner === null) return null;
    return this.attachments.get(this.inputOwner)?.webContentsId ?? null;
  }

  /** Whether input from this attachment, stamped with the epoch it held, is accepted. */
  canWrite(attachmentId: string, epoch: number): boolean {
    return this.inputOwner === attachmentId && this.inputEpoch === epoch;
  }

  private requireAttachment(attachmentId: string, webContentsId: number): Attachment {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) throw refuse("NOT_FOUND", "That attachment is gone.");
    if (attachment.webContentsId !== webContentsId) {
      throw refuse("VALIDATION", "That attachment belongs to another window.");
    }
    return attachment;
  }

  private setInputOwner(attachmentId: string | null): void {
    this.inputOwner = attachmentId;
    this.inputEpoch += 1;
  }

  private releaseInputOwner(): void {
    if (this.inputOwner === null) return;
    this.setInputOwner(null);
  }

  /** Give input with no owner to the best attachment for it; true when one took it. */
  private fillVacancy(): boolean {
    if (this.inputOwner !== null) return false;
    const next = this.successor();
    if (next === null) return false;
    this.setInputOwner(next);
    return true;
  }

  /**
   * The attachment input goes to when nobody holds it: one that can type, in
   * the most recently focused window, the latest to attach breaking ties and
   * standing in where no window it is in has been focused.
   */
  private successor(): string | null {
    const focused = this.deps.focusedWindows();
    let best: Attachment | null = null;
    let bestRank = Infinity;
    // Attachments iterate in the order they attached, so `<=` lets the later one win a tie.
    for (const attachment of this.attachments.values()) {
      if (!attachment.eligible) continue;
      const at = focused.indexOf(attachment.windowId);
      const rank = at === -1 ? focused.length : at;
      if (rank <= bestRank) {
        best = attachment;
        bestRank = rank;
      }
    }
    return best?.attachmentId ?? null;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch (err) {
        console.warn("[GlobalAssistant] A state listener threw:", err);
      }
    }
  }
}
