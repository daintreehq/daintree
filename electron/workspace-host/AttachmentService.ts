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
// Kept short: a delete runs it ahead of the whole teardown, under the
// delete-worktree port deadline (worktreePortTimeouts.ts).
const DELETE_DETACH_TIMEOUT_MS = 60_000;

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
      await this.refreshDeclarations();
      return;
    }
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    this.queue.clear();
    this.running.clear();
    this.loadedRoot = projectRootPath;
    const stored = await this.store.load(projectRootPath);
    this.records = new Map(Object.entries(stored));
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
      if (running?.worktreeId === worktreeId) entry.running = running.action;
      if (record?.lastResult?.worktreeId === worktreeId) entry.lastResult = record.lastResult;
      if (holder === worktreeId && record?.status) entry.status = record.status;
      return entry;
    });
  }

  run(
    worktreeId: string,
    name: string,
    action: WorktreePortAttachmentAction
  ): Promise<AttachmentActionResult> {
    const epoch = this.epoch;
    return this.queue
      .add(async () => {
        if (epoch !== this.epoch) return { success: false, error: "Aborted" };
        if (action === "attach") return this.attach(worktreeId, name, epoch);
        if (action === "detach") return this.detach(worktreeId, name, epoch);
        return this.checkStatus(worktreeId, name, epoch);
      })
      .then((result) => result ?? { success: false, error: "Aborted" });
  }

  /**
   * Release every attachment `worktreeId` holds, ahead of its delete. Each ends
   * unattached whatever its detach did — the worktree is going — but a failed
   * or skipped detach stays recorded so it isn't mistaken for a clean release.
   */
  async detachForDelete(worktreeId: string): Promise<void> {
    const epoch = this.epoch;
    await this.queue.add(async () => {
      if (epoch !== this.epoch) return;
      const held = [...this.records].filter(([, r]) => r.holderWorktreeId === worktreeId);
      if (held.length === 0) return;
      const monitor = this.ctx.getMonitor(worktreeId);
      const declarations = await this.freshDeclarations();
      if (epoch !== this.epoch) return;
      for (const [name, record] of held) {
        const config = declarations?.attachments.get(name);
        let observation: ProjectAttachmentObservation;
        if (!monitor || !config || !declarations) {
          observation = this.observe("detach", worktreeId, {
            state: "failed",
            error: config ? ATTACHMENT_HOLDER_REMOVED_ERROR : "Its declaration was removed.",
          });
        } else if (!(await this.isApproved(declarations))) {
          observation = this.observe("detach", worktreeId, {
            state: "needs-approval",
            error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
          });
        } else {
          const result = await this.runTracked(
            name,
            "detach",
            monitor,
            config.detach,
            DELETE_DETACH_TIMEOUT_MS
          );
          if (epoch !== this.epoch) return;
          observation = this.observeResult("detach", worktreeId, result);
        }
        record.holderWorktreeId = null;
        record.lastResult = observation;
        record.status = undefined;
      }
      await this.persist(epoch);
      this.publishAll();
    });
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
    let changed = false;
    for (const record of this.records.values()) {
      if (record.holderWorktreeId !== worktreeId) continue;
      record.holderWorktreeId = null;
      record.status = undefined;
      record.lastResult = this.observe("removed", worktreeId, {
        state: "failed",
        error: ATTACHMENT_HOLDER_REMOVED_ERROR,
      });
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
    this.queue.clear();
    this.running.clear();
    this.loadedRoot = null;
  }

  private async attach(
    worktreeId: string,
    name: string,
    epoch: number
  ): Promise<AttachmentActionResult | undefined> {
    const target = this.ctx.getMonitor(worktreeId);
    if (!target) return { success: false, error: "Worktree not found" };
    const declarations = await this.freshDeclarations();
    if (epoch !== this.epoch) return undefined;
    const config = declarations?.attachments.get(name);
    if (!declarations || !config) return { success: false, error: `No attachment named "${name}"` };
    const record = this.recordFor(name);
    if (record.holderWorktreeId === worktreeId) {
      return { success: false, error: `"${name}" is already attached here` };
    }
    if (!(await this.isApproved(declarations))) return this.refuseUnapproved(target, epoch);

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
    const current = await this.freshDeclarations();
    if (epoch !== this.epoch) return undefined;
    const currentConfig = current?.attachments.get(name);
    if (!current || !currentConfig) {
      return { success: false, error: `No attachment named "${name}"` };
    }
    if (!(await this.isApproved(current))) return this.refuseUnapproved(target, epoch);

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

    if (currentConfig.status) await this.runStatus(target, name, currentConfig.status, epoch);
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
    const declarations = await this.freshDeclarations();
    if (epoch !== this.epoch) return undefined;
    const config = declarations?.attachments.get(name);
    if (!declarations || !config) return { success: false, error: `No attachment named "${name}"` };
    if (!(await this.isApproved(declarations))) return this.refuseUnapproved(holder, epoch);

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
    const declarations = await this.freshDeclarations();
    if (epoch !== this.epoch) return undefined;
    const status = declarations?.attachments.get(name)?.status;
    if (!declarations || !status) return { success: false, error: "No status command configured" };
    if (!(await this.isApproved(declarations))) return this.refuseUnapproved(holder, epoch);
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

  private async freshDeclarations(): Promise<Declarations | null> {
    const root = this.loadedRoot;
    if (!root) return null;
    const declarations = await this.readDeclarations(root);
    this.declarations = declarations;
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
