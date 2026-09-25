import { createHash, randomBytes, type Hash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginInstallResult } from "../../../../shared/types/plugin.js";
import type { PluginInventory } from "../../../services/plugin/parity/inventory.js";
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import {
  EmptySchema,
  PluginParityLinkMethod,
  StageBeginSchema,
  StageChunkSchema,
  StageInstallSchema,
  StageTokenSchema,
} from "./linkMethods.js";

/** What the host needs from its own plugin service. */
export interface HostPluginParityPlugins {
  getPluginInventory(options: { includeSecrets?: boolean }): Promise<PluginInventory>;
  installPluginFromAnotherMachine(
    archivePath: string,
    expect: { pluginId?: string; update?: boolean }
  ): Promise<PluginInstallResult>;
}

export interface HostPluginParityOptions {
  plugins(): Promise<HostPluginParityPlugins>;
  /** Parent of each staging folder; the OS temp dir by default. */
  stagingRoot?: string;
  /** A slot with no chunk for this long is removed. */
  idleMs?: number;
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
}

interface SessionStaging {
  staged: Map<string, Staged>;
  /** Slots whose folder is still being created. */
  reserving: number;
  closed: boolean;
}

/** Abandoned slots are reclaimed after this long without a chunk. */
const STAGE_IDLE_MS = 10 * 60_000;
const MAX_STAGED_PER_SESSION = 4;

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

  constructor(private readonly options: HostPluginParityOptions) {}

  attach(session: LinkSession): void {
    if (this.disposed || this.sessions.has(session)) return;
    const state: SessionStaging = { staged: new Map(), reserving: 0, closed: false };
    this.sessions.set(session, state);
    const on = session.registerCallHandler.bind(session);
    const unregister = [
      on(PluginParityLinkMethod.INVENTORY, EmptySchema, async () =>
        (await this.options.plugins()).getPluginInventory({ includeSecrets: true })
      ),
      on(PluginParityLinkMethod.STAGE_BEGIN, StageBeginSchema, (p) => this.begin(state, p)),
      on(PluginParityLinkMethod.STAGE_CHUNK, StageChunkSchema, (p) => this.chunk(state, p)),
      on(PluginParityLinkMethod.STAGE_INSTALL, StageInstallSchema, (p) => this.install(state, p)),
      on(PluginParityLinkMethod.STAGE_DISCARD, StageTokenSchema, async ({ token }) => {
        await this.discard(state, token);
        return null;
      }),
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
    payload: { size: number; sha256: string }
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
      };
      state.staged.set(token, entry);
      dir = null;
      this.armIdleTimer(state, token, entry);
      return { token };
    } finally {
      state.reserving--;
      if (dir !== null) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async chunk(
    state: SessionStaging,
    payload: { token: string; offset: number; bytes: Uint8Array }
  ): Promise<null> {
    const entry = state.staged.get(payload.token);
    if (!entry || !entry.handle || entry.busy) throw stagingError("No package is being staged");
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
      if (failed || state.closed || this.disposed) await this.discard(state, payload.token);
    }
    return null;
  }

  private async install(
    state: SessionStaging,
    payload: { token: string; pluginId?: string; update: boolean }
  ): Promise<PluginInstallResult> {
    const entry = state.staged.get(payload.token);
    if (!entry || !entry.handle || entry.busy) throw stagingError("No package is being staged");
    entry.busy = true;
    try {
      await entry.handle.close();
      entry.handle = null;
      if (entry.written !== entry.size || entry.hash.digest("hex") !== entry.sha256) {
        throw stagingError("The staged package doesn't match what was announced");
      }
      const plugins = await this.options.plugins();
      return await plugins.installPluginFromAnotherMachine(entry.file, {
        ...(payload.pluginId !== undefined ? { pluginId: payload.pluginId } : {}),
        update: payload.update,
      });
    } finally {
      entry.busy = false;
      await this.discard(state, payload.token);
    }
  }

  private async discard(state: SessionStaging, token: string): Promise<void> {
    const entry = state.staged.get(token);
    if (!entry || entry.busy) return;
    state.staged.delete(token);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await entry.handle?.close().catch(() => {});
    entry.handle = null;
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
}
