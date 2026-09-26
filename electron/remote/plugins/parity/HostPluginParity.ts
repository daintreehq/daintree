import { createHash, randomBytes, type Hash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OperationOutcome } from "../../../../shared/types/remoteHosts.js";
import type {
  PluginInstallPhase,
  PluginInstallProgressEvent,
  PluginInstallResult,
} from "../../../../shared/types/plugin.js";
import { OperationRegistry } from "../../../services/operations/OperationRegistry.js";
import type { PluginInventory } from "../../../services/plugin/parity/inventory.js";
import { pluginInstallJobs } from "../../../services/plugin/PluginInstallJobRegistry.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import {
  EmptySchema,
  InstallStatusSchema,
  PluginParityLinkMethod,
  PluginLoadedSchema,
  StageBeginSchema,
  StageChunkSchema,
  StageInstallSchema,
  StageTokenSchema,
} from "./linkMethods.js";

/** What the host needs from its own plugin service. */
export interface HostPluginParityPlugins {
  getPluginInventory(options: { includeSecrets?: boolean }): Promise<PluginInventory>;
  hasPlugin(pluginId: string): boolean;
  installPluginFromAnotherMachine(
    archivePath: string,
    expect: { pluginId?: string; update?: boolean; jobId?: string }
  ): Promise<PluginInstallResult>;
}

/** The install-job registry the local install handlers use; a Cancel reaches it by job id. */
export type HostPluginInstallJobs = Pick<typeof pluginInstallJobs, "begin" | "end">;

export interface HostPluginParityOptions {
  plugins(): Promise<HostPluginParityPlugins>;
  /** Parent of each staging folder; the OS temp dir by default. */
  stagingRoot?: string;
  /** A slot with no chunk for this long is removed. */
  idleMs?: number;
  jobs?: HostPluginInstallJobs;
  /** How long a settled install's outcome is kept for a Shell to ask about. */
  outcomeRetentionMs?: number;
}

interface Staged {
  dir: string;
  file: string;
  size: number;
  sha256: string;
  written: number;
  hash: Hash;
  handle: fs.FileHandle | null;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The window's install job, when it asked for progress and cancellation. */
  jobId: string | null;
  cancelled: boolean;
  /** Where the job's phases go while the install runs. */
  onPhase: ((phase: PluginInstallPhase) => void) | null;
}

interface SessionStaging {
  staged: Map<string, Staged>;
  /** Slots whose folder is still being created. */
  reserving: number;
  closed: boolean;
  /** Tokens of slots removed by a Cancel, so the next call says so rather than "not staged". */
  cancelledTokens: Set<string>;
}

/** Abandoned slots are reclaimed after this long without a chunk. */
const STAGE_IDLE_MS = 10 * 60_000;
const MAX_STAGED_PER_SESSION = 4;
const MAX_REMEMBERED_CANCELS = 16;
/** Install outcomes are kept this long for a Shell whose answer was lost. */
const OUTCOME_RETENTION_MS = 10 * 60_000;
const MAX_RETAINED_OUTCOMES = 64;
const INSTALL_SCOPE = "plugin-parity";

function cancelledError(): AppError {
  return new AppError({
    code: "CANCELLED",
    message: "The plugin install was cancelled",
    userMessage: "The plugin install was cancelled.",
  });
}

function stagingError(message: string): AppError {
  return new AppError({
    code: "VALIDATION",
    message,
    userMessage: "The plugin package didn't arrive intact. Try again.",
  });
}

/**
 * Host side of plugin parity: report this machine's plugins, and install a
 * package a Shell sends when its person asks. The package lands in a private
 * folder (0700, the file 0600, created exclusively) and is checked against the
 * size and digest announced up front before anything else reads it; the
 * normal install path then refuses it for this OS or the blocklist before it
 * is copied into the plugins folder. Nothing arrives unrequested: every slot
 * is reserved by a call, holds one package, and is removed once installed,
 * discarded, idle, or its session closes.
 */
export class HostPluginParity {
  private readonly sessions = new WeakMap<LinkSession, SessionStaging>();
  private disposed = false;
  /**
   * Installs by the Shell's operation id: one install per id, and its outcome
   * kept (bounded, for a while) across sessions, since the Shell asks again
   * over the session it reconnects with.
   */
  private readonly operations: OperationRegistry;
  private readonly jobs: HostPluginInstallJobs;

  constructor(private readonly options: HostPluginParityOptions) {
    this.operations = new OperationRegistry({
      retentionMs: options.outcomeRetentionMs ?? OUTCOME_RETENTION_MS,
      maxSettled: MAX_RETAINED_OUTCOMES,
    });
    this.jobs = options.jobs ?? pluginInstallJobs;
  }

  attach(session: LinkSession): void {
    if (this.disposed || this.sessions.has(session)) return;
    const state: SessionStaging = {
      staged: new Map(),
      reserving: 0,
      closed: false,
      cancelledTokens: new Set(),
    };
    this.sessions.set(session, state);
    const on = session.registerCallHandler.bind(session);
    const unregister = [
      on(PluginParityLinkMethod.INVENTORY, EmptySchema, async () =>
        (await this.options.plugins()).getPluginInventory({ includeSecrets: true })
      ),
      on(PluginParityLinkMethod.LOADED, PluginLoadedSchema, async ({ pluginId }) =>
        (await this.options.plugins()).hasPlugin(pluginId)
      ),
      on(PluginParityLinkMethod.STAGE_BEGIN, StageBeginSchema, (p) => this.begin(state, p)),
      on(PluginParityLinkMethod.STAGE_CHUNK, StageChunkSchema, (p) => this.chunk(state, p)),
      on(PluginParityLinkMethod.STAGE_INSTALL, StageInstallSchema, (p) => this.install(state, p)),
      on(PluginParityLinkMethod.STAGE_DISCARD, StageTokenSchema, async ({ token }) => {
        await this.discard(state, token);
        return null;
      }),
      on(
        PluginParityLinkMethod.INSTALL_STATUS,
        InstallStatusSchema,
        async ({ opId }): Promise<OperationOutcome> => this.operations.status(opId)
      ),
    ];
    session.onClose(() => {
      state.closed = true;
      for (const dispose of unregister) dispose();
      // A slot mid-write or mid-install is removed when that call finishes.
      for (const token of [...state.staged.keys()]) void this.discard(state, token);
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private armIdleTimer(state: SessionStaging, token: string, entry: Staged): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(
      () => void this.discard(state, token),
      this.options.idleMs ?? STAGE_IDLE_MS
    );
    entry.idleTimer.unref?.();
  }

  private async begin(
    state: SessionStaging,
    payload: { size: number; sha256: string; jobId?: string }
  ): Promise<{ token: string }> {
    if (this.disposed || state.closed) throw stagingError("Host mode is stopping");
    // Reserved before the first await, so concurrent calls can't all pass the cap.
    if (state.staged.size + state.reserving >= MAX_STAGED_PER_SESSION) {
      throw new AppError({
        code: "RATE_LIMITED",
        message: "Too many plugin packages are waiting",
        userMessage: "Other plugin installs are still in progress. Try again in a moment.",
      });
    }
    state.reserving++;
    let dir: string | null = null;
    try {
      const root = this.options.stagingRoot ?? os.tmpdir();
      dir = await fs.mkdtemp(path.join(root, "daintree-plugin-stage-"));
      await fs.chmod(dir, 0o700);
      const file = path.join(dir, "package.dntr");
      const handle = await fs.open(file, "wx", 0o600);
      if (state.closed || this.disposed) {
        await handle.close().catch(() => {});
        throw stagingError("The link closed while staging");
      }
      const token = randomBytes(16).toString("hex");
      const entry: Staged = {
        dir,
        file,
        size: payload.size,
        sha256: payload.sha256,
        written: 0,
        hash: createHash("sha256"),
        handle,
        busy: false,
        idleTimer: null,
        jobId: null,
        cancelled: false,
        onPhase: null,
      };
      state.staged.set(token, entry);
      dir = null;
      this.armIdleTimer(state, token, entry);
      if (payload.jobId !== undefined && !this.registerJob(state, token, entry, payload.jobId)) {
        // A job id already live here is another install's: running this one
        // under it would let one Cancel stop the other.
        await this.discard(state, token);
        throw stagingError("That install job is already running");
      }
      return { token };
    } finally {
      state.reserving--;
      if (dir !== null) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Register the window's job under its own id, which is what its Cancel
   * names. A Cancel removes the slot (straight away, or once a chunk being
   * written lands); during the install the installer honours it up to its
   * commit point. False when the id is already live here, as someone else's job.
   */
  private registerJob(state: SessionStaging, token: string, entry: Staged, jobId: string): boolean {
    const signal = this.jobs.begin(jobId, (event: PluginInstallProgressEvent) =>
      entry.onPhase?.(event.phase)
    );
    if (!signal) return false;
    entry.jobId = jobId;
    signal.addEventListener(
      "abort",
      () => {
        entry.cancelled = true;
        if (!entry.busy) void this.discard(state, token);
      },
      { once: true }
    );
    return true;
  }

  /** A slot the person cancelled, which the Shell hears about on its next call. */
  private rememberCancel(state: SessionStaging, token: string): void {
    state.cancelledTokens.add(token);
    while (state.cancelledTokens.size > MAX_REMEMBERED_CANCELS) {
      const oldest = state.cancelledTokens.values().next().value;
      if (oldest === undefined) break;
      state.cancelledTokens.delete(oldest);
    }
  }

  private missing(state: SessionStaging, token: string): AppError {
    return state.cancelledTokens.delete(token)
      ? cancelledError()
      : stagingError("No package is being staged");
  }

  private async chunk(
    state: SessionStaging,
    payload: { token: string; offset: number; bytes: Uint8Array }
  ): Promise<null> {
    const entry = state.staged.get(payload.token);
    if (!entry || !entry.handle || entry.busy) {
      throw entry ? stagingError("No package is being staged") : this.missing(state, payload.token);
    }
    if (payload.offset !== entry.written || entry.written + payload.bytes.byteLength > entry.size) {
      await this.discard(state, payload.token);
      throw stagingError("A package chunk arrived out of order");
    }
    entry.busy = true;
    let failed = false;
    try {
      let done = 0;
      while (done < payload.bytes.byteLength) {
        const { bytesWritten } = await entry.handle.write(
          payload.bytes,
          done,
          payload.bytes.byteLength - done
        );
        done += bytesWritten;
      }
      entry.hash.update(payload.bytes);
      entry.written += payload.bytes.byteLength;
      this.armIdleTimer(state, payload.token, entry);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      entry.busy = false;
      if (failed || entry.cancelled || state.closed || this.disposed) {
        await this.discard(state, payload.token);
      }
    }
    if (entry.cancelled) throw cancelledError();
    return null;
  }

  private async install(
    state: SessionStaging,
    payload: { token: string; pluginId?: string; update: boolean; opId?: string }
  ): Promise<PluginInstallResult> {
    const entry = state.staged.get(payload.token);
    if (!entry || !entry.handle || entry.busy) {
      throw entry ? stagingError("No package is being staged") : this.missing(state, payload.token);
    }
    const operation = {
      opId: payload.opId ?? null,
      kind: "plugin-install" as const,
      scope: INSTALL_SCOPE,
      // The same id must name the same request: this package, this plugin, this intent.
      fingerprint: `${entry.sha256}:${payload.pluginId ?? ""}:${payload.update}`,
    };
    // Already asked for under this id: answer with that install, never a second one.
    const earlier = this.operations.join<PluginInstallResult>(operation);
    if (earlier) {
      await this.discard(state, payload.token);
      return earlier;
    }
    entry.busy = true;
    try {
      return await this.operations.run(operation, async (handle) => {
        entry.onPhase = (phase) => handle.progress({ fraction: null, stage: phase, message: null });
        await entry.handle!.close();
        entry.handle = null;
        if (entry.written !== entry.size || entry.hash.digest("hex") !== entry.sha256) {
          throw stagingError("The staged package doesn't match what was announced");
        }
        if (entry.cancelled) return { status: "cancelled" } satisfies PluginInstallResult;
        const plugins = await this.options.plugins();
        return plugins.installPluginFromAnotherMachine(entry.file, {
          ...(payload.pluginId !== undefined ? { pluginId: payload.pluginId } : {}),
          update: payload.update,
          ...(entry.jobId !== null ? { jobId: entry.jobId } : {}),
        });
      });
    } finally {
      entry.busy = false;
      entry.onPhase = null;
      await this.discard(state, payload.token);
    }
  }

  private async discard(state: SessionStaging, token: string): Promise<void> {
    const entry = state.staged.get(token);
    if (!entry || entry.busy) return;
    state.staged.delete(token);
    if (entry.cancelled) this.rememberCancel(state, token);
    if (entry.jobId !== null) this.jobs.end(entry.jobId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.handle?.close().catch(() => {});
    entry.handle = null;
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
}
