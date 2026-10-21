import PQueue from "p-queue";
import type {
  ProjectAttachmentObservation,
  WorktreeAttachment,
  WorktreeTeardownPhasePreview,
} from "../../shared/types/worktree.js";
import type { WorktreePortAttachmentAction } from "../../shared/types/worktree-port.js";
import type { WorktreeMonitor } from "./WorktreeMonitor.js";
import {
  LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
  type AttachmentConfig,
  type ResolvedLifecycleConfig,
  type RunCommandsResult,
  type WorktreeLifecycleService,
} from "./WorktreeLifecycleService.js";
import type { ProjectAttachmentRecord, ProjectAttachmentStore } from "./projectAttachmentStore.js";

const ATTACH_TIMEOUT_MS = 300_000;
const DETACH_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 60_000;
// Kept short: a delete runs these ahead of the whole teardown, under the
// delete-worktree port deadline (worktreePortTimeouts.ts).
const DELETE_DETACH_TIMEOUT_MS = 60_000;
const DELETE_DETACH_BUDGET_MS = 120_000;

export const ATTACHMENT_HOLDER_REMOVED_ERROR =
  "The worktree holding it was removed before its detach could run.";

export interface AttachmentServiceContext {
  getProjectRootPath(): string | null;
  getMonitor(worktreeId: string): WorktreeMonitor | undefined;
  getMonitors(): Iterable<WorktreeMonitor>;
  getProjectEnvVars(): Record<string, string>;
  emitUpdate(monitor: WorktreeMonitor): void;
  readonly lifecycleService: WorktreeLifecycleService;
}

export interface AttachmentActionResult {
  success: boolean;
  error?: string;
}

type Declarations = {
  resolved: ResolvedLifecycleConfig;
  attachments: Map<string, AttachmentConfig>;
};

/**
 * Project attachments (#13703): resources the whole project shares that sit on
 * one worktree at a time — a tunnel on a fixed URL, a physical test device.
 *
 * Holding is only ever changed by an explicit request, a delete, or the holder
 * disappearing; never by which worktree is active. Every operation runs on one
 * queue, so a move's detach and attach can never interleave with another
 * move, delete or status check. What a card shows is what was observed: the
 * holder changes only after a command succeeded, and a failure is recorded as
 * a failure against the worktree it ran on.
 */
export class AttachmentService {
  private records = new Map<string, ProjectAttachmentRecord>();
  private declarations: Declarations | null = null;
  private running = new Map<string, { worktreeId: string; action: WorktreePortAttachmentAction }>();
  // Requests accepted per attachment and not yet settled, queued or running.
  // Every card disables its rows while one is outstanding, so nobody asks for
  // a move against a holder that is about to change.
  private pending = new Map<string, number>();
  // Worktrees whose delete has started, counted per delete in flight. Nothing
  // may attach to one: its delete has already run the detaches it will run.
  private deleting = new Map<string, number>();
  // Settles once the current project's holders are read. Every operation waits
  // on it: before then the records are empty, and an attach would skip the
  // detach of a holder that simply hasn't been read yet.
  private ready: Promise<void> = Promise.resolve();
  private queue = new PQueue({ concurrency: 1 });
  private abort = new AbortController();
  private loadedRoot: string | null = null;
  // Bumped per load so a command that outlives a project reload or dispose
  // never writes into the state that replaced it.
  private epoch = 0;

  constructor(
    private readonly ctx: AttachmentServiceContext,
    private readonly store: ProjectAttachmentStore
  ) {}

  async load(projectRootPath: string): Promise<void> {
    // A repeat load of the same project (prefetch, recovery) must not abort a
    // move halfway through or drop holders it has recorded since.
    if (this.loadedRoot === projectRootPath) {
      await this.ready;
      await this.refreshDeclarations();
      return;
    }
    // Queued work is left to settle through its epoch guard rather than
    // cleared: a cleared p-queue entry never resolves its caller.
    const epoch = ++this.epoch;
    this.abort.abort();
    this.abort = new AbortController();
    this.running.clear();
    this.pending.clear();
    this.deleting.clear();
    this.loadedRoot = projectRootPath;
    this.records = new Map();
    this.declarations = null;
    this.ready = (async () => {
      const stored = await this.store.load(projectRootPath);
      if (epoch !== this.epoch) return;
      this.records = new Map(Object.entries(stored));
    })();
    await this.ready;
    await this.refreshDeclarations();
  }

  /** Re-read the declarations. Runs nothing. */
  async refreshDeclarations(): Promise<void> {
    const root = this.loadedRoot;
    if (!root) return;
    const epoch = this.epoch;
    const declarations = await this.readDeclarations(root);
    if (epoch !== this.epoch) return;
    this.declarations = declarations;
    this.publishAll();
  }

  /** What `worktreeId`'s card shows, or `undefined` when there is nothing to show. */
  projectionFor(worktreeId: string): WorktreeAttachment[] | undefined {
    const names = new Set(this.declarations?.attachments.keys() ?? []);
    // A held attachment whose declaration was removed still shows on its
    // holder: something may still be attached there, and hiding it would
    // conceal that.
    for (const [name, record] of this.records) {
      if (record.holderWorktreeId) names.add(name);
    }
    if (names.size === 0) return undefined;
    return [...names].sort().map((name) => {
      const record = this.records.get(name);
      const holder = record?.holderWorktreeId ?? undefined;
      const running = this.running.get(name);
      const entry: WorktreeAttachment = {
        name,
        heldHere: holder === worktreeId,
        hasStatusCommand: !!this.declarations?.attachments.get(name)?.status,
      };
      if (holder) entry.holderWorktreeId = holder;
      if ((this.pending.get(name) ?? 0) > 0) entry.busy = true;
      if (running?.worktreeId === worktreeId) entry.running = running.action;
      if (record?.lastResult?.worktreeId === worktreeId) entry.lastResult = record.lastResult;
      if (holder === worktreeId && record?.status) entry.status = record.status;
      return entry;
    });
  }

  /**
   * `expectedHolderWorktreeId` is who the user saw holding it when they asked
   * to attach (`null` for nobody). A move detaches that holder, so the request
   * is refused if someone else holds it by the time it runs — the user
   * confirmed moving it away from one worktree, not whichever holds it now.
   */
  run(
    worktreeId: string,
    name: string,
    action: WorktreePortAttachmentAction,
    expectedHolderWorktreeId?: string | null
  ): Promise<AttachmentActionResult> {
    const epoch = this.epoch;
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1);
    this.publishAll();
    return this.queue
      .add(async () => {
        await this.ready;
        if (epoch !== this.epoch) return { success: false, error: "Aborted" };
        if (action === "attach") {
          return this.attach(worktreeId, name, epoch, expectedHolderWorktreeId);
        }
        if (action === "detach") return this.detach(worktreeId, name, epoch);
        return this.checkStatus(worktreeId, name, epoch);
      })
      .then((result) => result ?? { success: false, error: "Aborted" })
      .finally(() => {
        // A reload cleared the counts this request added to.
        if (epoch !== this.epoch) return;
        const left = (this.pending.get(name) ?? 1) - 1;
        if (left > 0) this.pending.set(name, left);
        else this.pending.delete(name);
        this.publishAll();
      });
  }

  /**
   * Run the detach of every attachment `worktreeId` holds, ahead of its delete.
   * A detach that succeeded releases it there and then. One that failed or was
   * skipped keeps the holder — the delete can still fail and leave the
   * worktree, and whatever is attached, in place — and is recorded, so when
   * the removal lands ({@link handleWorktreeRemoved}) it is released with that
   * failure still showing rather than read as a clean release.
   *
   * Until {@link endDelete}, nothing may attach to the worktree.
   */
  async detachForDelete(worktreeId: string): Promise<void> {
    this.deleting.set(worktreeId, (this.deleting.get(worktreeId) ?? 0) + 1);
    const epoch = this.epoch;
    // Ahead of any queued request, so a delete waits at most for the one
    // command already running — its port deadline is sized to that.
    await this.queue.add(
      async () => {
        await this.ready;
        if (epoch !== this.epoch) return;
        const held = [...this.records].filter(([, r]) => r.holderWorktreeId === worktreeId);
        if (held.length === 0) return;
        const monitor = this.ctx.getMonitor(worktreeId);
        const declarations = await this.freshDeclarations(epoch);
        if (epoch !== this.epoch) return;
        const approved = declarations ? await this.isApproved(declarations) : false;
        if (epoch !== this.epoch) return;
        // One budget for every detach, so a delete's whole teardown stays under
        // the delete-worktree port deadline however many attachments it holds.
        const deadline = Date.now() + DELETE_DETACH_BUDGET_MS;
        for (const [name, record] of held) {
          const config = declarations?.attachments.get(name);
          const remainingMs = deadline - Date.now();
          let observation: ProjectAttachmentObservation;
          if (!monitor || !config) {
            observation = this.observe("detach", worktreeId, {
              state: "failed",
              error: config ? ATTACHMENT_HOLDER_REMOVED_ERROR : "Its declaration was removed.",
            });
          } else if (!approved) {
            observation = this.observe("detach", worktreeId, {
              state: "needs-approval",
              error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
            });
          } else if (remainingMs <= 0) {
            observation = this.observe("detach", worktreeId, {
              state: "timed-out",
              error: "The delete's time for detaching ran out before this one started.",
            });
          } else {
            const result = await this.runTracked(
              name,
              "detach",
              monitor,
              config.detach,
              Math.min(DELETE_DETACH_TIMEOUT_MS, remainingMs)
            );
            if (epoch !== this.epoch) return;
            observation = this.observeResult("detach", worktreeId, result);
          }
          record.lastResult = observation;
          if (observation.state === "success") {
            record.holderWorktreeId = null;
            record.status = undefined;
          }
        }
        await this.persist(epoch);
        this.publishAll();
      },
      { priority: 1 }
    );
  }

  /** A delete that ran {@link detachForDelete} failed and left the worktree in place. */
  endDelete(worktreeId: string): void {
    const left = (this.deleting.get(worktreeId) ?? 1) - 1;
    if (left > 0) this.deleting.set(worktreeId, left);
    else this.deleting.delete(worktreeId);
  }

  /** The detach phases a delete of `monitor` would run, for its confirm surfaces. */
  async previewDetachForDelete(monitor: WorktreeMonitor): Promise<WorktreeTeardownPhasePreview[]> {
    const root = this.loadedRoot;
    if (!root) return [];
    const held = [...this.records]
      .filter(([, r]) => r.holderWorktreeId === monitor.id)
      .map(([name]) => name)
      .sort();
    if (held.length === 0) return [];
    const declarations = await this.readDeclarations(root);
    const approved = declarations ? await this.isApproved(declarations) : false;
    const vars = this.ctx.lifecycleService.buildVariables(
      monitor.path,
      root,
      monitor.name,
      monitor.branch
    );
    return held.map((name) => ({
      phase: "attachment-detach" as const,
      attachment: name,
      commands: (declarations?.attachments.get(name)?.detach ?? []).map((cmd) =>
        this.ctx.lifecycleService.substituteVariables(cmd, vars)
      ),
      approved,
    }));
  }

  /**
   * The holder is gone without a detach Daintree ran (removed outside the app,
   * or while it was closed). Nothing can run in a directory that no longer
   * exists, so the attachment is released and the missing cleanup recorded.
   */
  handleWorktreeRemoved(worktreeId: string): void {
    this.deleting.delete(worktreeId);
    let changed = false;
    for (const record of this.records.values()) {
      if (record.holderWorktreeId !== worktreeId) continue;
      record.holderWorktreeId = null;
      record.status = undefined;
      // A delete's own failed or skipped detach is the more specific account
      // of what was (not) cleaned up, so it is what stays showing.
      const deleteDetach =
        record.lastResult?.action === "detach" && record.lastResult.worktreeId === worktreeId;
      if (!deleteDetach) {
        record.lastResult = this.observe("removed", worktreeId, {
          state: "failed",
          error: ATTACHMENT_HOLDER_REMOVED_ERROR,
        });
      }
      changed = true;
    }
    if (!changed) return;
    void this.persist(this.epoch);
    this.publishAll();
  }

  /** Release holders that are not among the project's live worktrees. */
  reconcile(liveWorktreeIds: ReadonlySet<string>): void {
    if (!this.loadedRoot) return;
    const gone = new Set<string>();
    for (const record of this.records.values()) {
      const holder = record.holderWorktreeId;
      if (holder && !liveWorktreeIds.has(holder) && !this.isRunningOn(holder)) gone.add(holder);
    }
    for (const id of gone) this.handleWorktreeRemoved(id);
  }

  dispose(): void {
    this.epoch++;
    this.abort.abort();
    this.running.clear();
    this.pending.clear();
    this.deleting.clear();
    this.loadedRoot = null;
  }

  private async attach(
    worktreeId: string,
    name: string,
    epoch: number,
    expectedHolderWorktreeId: string | null | undefined
  ): Promise<AttachmentActionResult | undefined> {
    const target = this.ctx.getMonitor(worktreeId);
    if (!target) return { success: false, error: "Worktree not found" };
    if (this.deleting.has(worktreeId)) {
      return { success: false, error: "This worktree is being deleted." };
    }
    const declarations = await this.freshDeclarations(epoch);
    if (epoch !== this.epoch) return undefined;
    const config = declarations?.attachments.get(name);
    if (!declarations || !config) return { success: false, error: `No attachment named "${name}"` };
    const record = this.recordFor(name);
    if (record.holderWorktreeId === worktreeId) {
      return { success: false, error: `"${name}" is already attached here` };
    }
    if (
      expectedHolderWorktreeId !== undefined &&
      expectedHolderWorktreeId !== record.holderWorktreeId
    ) {
      return {
        success: false,
        error: `"${name}" moved since you asked. Check where it is now and try again.`,
      };
    }
    const approved = await this.isApproved(declarations);
    if (epoch !== this.epoch) return undefined;
    if (!approved) return this.refuseUnapproved(target, epoch);

    const previousHolderId = record.holderWorktreeId;
    if (previousHolderId) {
      const previous = this.ctx.getMonitor(previousHolderId);
      if (previous) {
        const detached = await this.runTracked(
          name,
          "detach",
          previous,
          config.detach,
          DETACH_TIMEOUT_MS
        );
        if (epoch !== this.epoch) return undefined;
        record.lastResult = this.observeResult("detach", previousHolderId, detached);
        if (!detached.success) {
          // Still on the old worktree: the attach must not run against a
          // resource that may still be pointed somewhere else.
          await this.persist(epoch);
          this.publishAll();
          return { success: false, error: detached.error ?? "Detach failed" };
        }
      } else {
        record.lastResult = this.observe("removed", previousHolderId, {
          state: "failed",
          error: ATTACHMENT_HOLDER_REMOVED_ERROR,
        });
      }
      record.holderWorktreeId = null;
      record.status = undefined;
      await this.persist(epoch);
      this.publishAll();
    }

    // Approval is checked again: the file can change while the detach runs.
    const current = await this.freshDeclarations(epoch);
    if (epoch !== this.epoch) return undefined;
    const currentConfig = current?.attachments.get(name);
    if (!current || !currentConfig) {
      return { success: false, error: `No attachment named "${name}"` };
    }
    const stillApproved = await this.isApproved(current);
    if (epoch !== this.epoch) return undefined;
    if (!stillApproved) return this.refuseUnapproved(target, epoch);
    // The target can be removed, or start being deleted, while the old holder
    // detaches; a worktree recreated at the same path is a different one.
    if (this.ctx.getMonitor(worktreeId) !== target || this.deleting.has(worktreeId)) {
      return { success: false, error: "The worktree went away before it could attach." };
    }

    const attached = await this.runTracked(
      name,
      "attach",
      target,
      currentConfig.attach,
      ATTACH_TIMEOUT_MS
    );
    if (epoch !== this.epoch) return undefined;
    const stillThere = this.ctx.getMonitor(worktreeId) === target;
    record.lastResult = stillThere
      ? this.observeResult("attach", worktreeId, attached)
      : this.observe("removed", worktreeId, {
          state: "failed",
          error: ATTACHMENT_HOLDER_REMOVED_ERROR,
        });
    record.holderWorktreeId = attached.success && stillThere ? worktreeId : null;
    await this.persist(epoch);
    this.publishAll();
    if (!attached.success) return { success: false, error: attached.error ?? "Attach failed" };
    if (!stillThere) return { success: false, error: ATTACHMENT_HOLDER_REMOVED_ERROR };

    // Through the same fresh read and approval as a status check asked for.
    if (currentConfig.status) await this.checkStatus(worktreeId, name, epoch);
    return { success: true };
  }

  private async detach(
    worktreeId: string,
    name: string,
    epoch: number
  ): Promise<AttachmentActionResult | undefined> {
    const holder = this.ctx.getMonitor(worktreeId);
    if (!holder) return { success: false, error: "Worktree not found" };
    const record = this.records.get(name);
    if (record?.holderWorktreeId !== worktreeId) {
      return { success: false, error: `"${name}" isn't attached here` };
    }
    const declarations = await this.freshDeclarations(epoch);
    if (epoch !== this.epoch) return undefined;
    const config = declarations?.attachments.get(name);
    if (!declarations || !config) return { success: false, error: `No attachment named "${name}"` };
    const approved = await this.isApproved(declarations);
    if (epoch !== this.epoch) return undefined;
    if (!approved) return this.refuseUnapproved(holder, epoch);
    if (this.ctx.getMonitor(worktreeId) !== holder || record.holderWorktreeId !== worktreeId) {
      return { success: false, error: `"${name}" isn't attached here` };
    }

    const result = await this.runTracked(name, "detach", holder, config.detach, DETACH_TIMEOUT_MS);
    if (epoch !== this.epoch) return undefined;
    record.lastResult = this.observeResult("detach", worktreeId, result);
    if (result.success) {
      record.holderWorktreeId = null;
      record.status = undefined;
    }
    await this.persist(epoch);
    this.publishAll();
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? "Detach failed" };
  }

  private async checkStatus(
    worktreeId: string,
    name: string,
    epoch: number
  ): Promise<AttachmentActionResult | undefined> {
    const holder = this.ctx.getMonitor(worktreeId);
    if (!holder) return { success: false, error: "Worktree not found" };
    if (this.records.get(name)?.holderWorktreeId !== worktreeId) {
      return { success: false, error: `"${name}" isn't attached here` };
    }
    const declarations = await this.freshDeclarations(epoch);
    if (epoch !== this.epoch) return undefined;
    const status = declarations?.attachments.get(name)?.status;
    if (!declarations || !status) return { success: false, error: "No status command configured" };
    const approved = await this.isApproved(declarations);
    if (epoch !== this.epoch) return undefined;
    if (!approved) return this.refuseUnapproved(holder, epoch);
    if (this.ctx.getMonitor(worktreeId) !== holder) {
      return { success: false, error: "Worktree not found" };
    }
    return this.runStatus(holder, name, status, epoch);
  }

  private async runStatus(
    holder: WorktreeMonitor,
    name: string,
    status: string,
    epoch: number
  ): Promise<AttachmentActionResult | undefined> {
    const result = await this.runTracked(name, "status", holder, [status], STATUS_TIMEOUT_MS);
    if (epoch !== this.epoch) return undefined;
    const record = this.records.get(name);
    // A status check never moves anything; it only reports on the holder it
    // ran against, and only while that is still the holder.
    if (record?.holderWorktreeId === holder.id) {
      record.status = this.observeResult("status", holder.id, result);
      await this.persist(epoch);
    }
    this.publishAll();
    return result.success
      ? { success: true }
      : { success: false, error: result.error ?? "Status check failed" };
  }

  private refuseUnapproved(monitor: WorktreeMonitor, epoch: number): AttachmentActionResult {
    // Nothing ran, so nothing is recorded against the attachment; the card's
    // review banner is how the user gets to approve them.
    if (
      monitor.lifecycleCommandsNeedApproval !== true &&
      this.ctx.getMonitor(monitor.id) === monitor
    ) {
      monitor.setLifecycleCommandsNeedApproval(true);
      if (epoch === this.epoch) this.ctx.emitUpdate(monitor);
    }
    return { success: false, error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR };
  }

  private async runTracked(
    name: string,
    action: WorktreePortAttachmentAction,
    monitor: WorktreeMonitor,
    commands: string[],
    timeoutMs: number
  ): Promise<RunCommandsResult> {
    const root = this.loadedRoot ?? monitor.path;
    const { lifecycleService } = this.ctx;
    const vars = lifecycleService.buildVariables(monitor.path, root, monitor.name, monitor.branch);
    const env = lifecycleService.buildEnv(
      monitor.path,
      root,
      monitor.name,
      monitor.branch,
      undefined,
      this.ctx.getProjectEnvVars()
    );
    env.DAINTREE_ATTACHMENT_NAME = name;
    this.running.set(name, { worktreeId: monitor.id, action });
    this.publishAll();
    try {
      return await lifecycleService.runCommands(
        commands.map((cmd) => lifecycleService.substituteVariables(cmd, vars)),
        { cwd: monitor.path, env, timeoutMs, signal: this.abort.signal, onProgress: () => {} }
      );
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    } finally {
      if (this.running.get(name)?.worktreeId === monitor.id) this.running.delete(name);
    }
  }

  private isRunningOn(worktreeId: string): boolean {
    for (const running of this.running.values()) {
      if (running.worktreeId === worktreeId) return true;
    }
    return false;
  }

  private recordFor(name: string): ProjectAttachmentRecord {
    let record = this.records.get(name);
    if (!record) {
      record = { holderWorktreeId: null };
      this.records.set(name, record);
    }
    return record;
  }

  private observe(
    action: ProjectAttachmentObservation["action"],
    worktreeId: string,
    fields: Pick<ProjectAttachmentObservation, "state" | "error" | "output">
  ): ProjectAttachmentObservation {
    return { action, worktreeId, ...fields, at: Date.now() };
  }

  private observeResult(
    action: ProjectAttachmentObservation["action"],
    worktreeId: string,
    result: RunCommandsResult
  ): ProjectAttachmentObservation {
    return this.observe(action, worktreeId, {
      state: result.success ? "success" : result.timedOut ? "timed-out" : "failed",
      output: result.output || undefined,
      error: result.success ? undefined : result.error,
    });
  }

  private async freshDeclarations(epoch: number): Promise<Declarations | null> {
    const root = this.loadedRoot;
    if (!root) return null;
    const declarations = await this.readDeclarations(root);
    if (epoch === this.epoch) this.declarations = declarations;
    return declarations;
  }

  private async readDeclarations(root: string): Promise<Declarations | null> {
    try {
      const resolved = await this.ctx.lifecycleService.resolveAttachments(root);
      if (!resolved) return null;
      return {
        resolved: resolved.resolved,
        attachments: new Map(Object.entries(resolved.attachments)),
      };
    } catch {
      return null;
    }
  }

  private async isApproved(declarations: Declarations): Promise<boolean> {
    const root = this.loadedRoot;
    if (!root) return false;
    try {
      return await this.ctx.lifecycleService.isConfigApproved(declarations.resolved, root);
    } catch {
      return false;
    }
  }

  private async persist(epoch: number): Promise<void> {
    const root = this.loadedRoot;
    if (!root || epoch !== this.epoch) return;
    try {
      await this.store.save(root, Object.fromEntries(this.records));
    } catch (err) {
      console.warn("[AttachmentService] Failed to save attachment holders:", err);
    }
  }

  private publishAll(): void {
    for (const monitor of this.ctx.getMonitors()) {
      const next = this.projectionFor(monitor.id);
      if (sameProjection(monitor.attachments, next)) continue;
      monitor.setAttachments(next);
      if (monitor.isRunning && monitor.hasInitialStatus) this.ctx.emitUpdate(monitor);
    }
  }
}

function sameProjection(
  a: WorktreeAttachment[] | undefined,
  b: WorktreeAttachment[] | undefined
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
