import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { net as ElectronNet } from "electron";
import {
  PLUGIN_ARTIFACT_DEFAULT_TTL_MS,
  PLUGIN_ARTIFACT_MAX_TRANSFERS,
  PLUGIN_ARTIFACT_MAX_TRANSFERS_PER_PLUGIN,
  PLUGIN_ARTIFACT_MAX_TTL_MS,
  PLUGIN_ARTIFACT_MIN_TTL_MS,
  PLUGIN_ARTIFACT_NAME_MAX_LENGTH,
  PLUGIN_ARTIFACT_PROGRESS_INTERVAL_MS,
} from "../../../shared/config/pluginArtifacts.js";
import type {
  PluginArtifact,
  PluginArtifactProgress,
  PluginArtifactSource,
  PluginArtifactUploadResult,
} from "../../../shared/types/pluginArtifacts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getMimeType } from "../../utils/appProtocol.js";
import { artifactError } from "./pluginArtifactErrors.js";
import type { ArtifactUrlMatcher } from "./pluginArtifactNetworkPolicy.js";
import type { ArtifactSlot, PluginArtifactStore } from "./PluginArtifactStore.js";
import {
  copyHandleToPart,
  downloadToPart,
  transferAbortError,
  uploadFromFile,
  type HttpsRequest,
} from "./pluginArtifactTransfers.js";

export interface PluginArtifactServiceDeps {
  store: PluginArtifactStore;
  netFetch: typeof ElectronNet.fetch;
  httpsRequest?: HttpsRequest;
  now?: () => number;
  /** How often expired artifacts are swept; 0 disables the timer (tests). */
  sweepIntervalMs?: number;
  /** Download retry delay; tests shorten it. */
  backoffMs?: (attempt: number) => number;
  idleMs?: number;
}

interface CreateMeta {
  pluginId: string;
  projectId: string | null;
  name?: string;
  mimeType?: string;
  ttlMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PluginArtifactProgress) => void;
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** A display name safe to show and to derive a type from: a base name, no control characters. */
export function sanitizeArtifactName(raw: string | null | undefined): string {
  const base = path.basename((raw ?? "").replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "artifact").slice(0, PLUGIN_ARTIFACT_NAME_MAX_LENGTH);
}

function normalizeMime(raw: string | null | undefined): string | null {
  const type = raw?.split(";")[0]?.trim().toLowerCase();
  return type && MIME.test(type) ? type : null;
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return PLUGIN_ARTIFACT_DEFAULT_TTL_MS;
  return Math.min(PLUGIN_ARTIFACT_MAX_TTL_MS, Math.max(PLUGIN_ARTIFACT_MIN_TTL_MS, ttlMs));
}

/** Coalesce progress to one report per interval, plus the final one. */
function throttled(
  onProgress: ((progress: PluginArtifactProgress) => void) | undefined,
  now: () => number
): { report: (p: PluginArtifactProgress) => void; flush: () => void } {
  let last = 0;
  let pending: PluginArtifactProgress | null = null;
  const send = (p: PluginArtifactProgress) => {
    // A plugin's progress callback failing, sync or async, must not fail its
    // transfer or surface as an unhandled rejection.
    try {
      const result: unknown = onProgress?.(p);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // ignored, as above
    }
  };
  return {
    report: (p) => {
      if (!onProgress) return;
      const t = now();
      if (t - last >= PLUGIN_ARTIFACT_PROGRESS_INTERVAL_MS) {
        last = t;
        pending = null;
        send(p);
      } else {
        pending = p;
      }
    },
    flush: () => {
      if (pending) send(pending);
      pending = null;
    },
  };
}

/**
 * The artifact lifecycle behind `host.artifacts` and the playback protocol
 * (#14100). Callers arrive already admitted — capability, containment and
 * URL scope are the host factory's — so this owns what happens to bytes:
 * concurrency, cancellation, retry, the `.part` file, commit, and teardown
 * when a plugin unloads or a project closes.
 */
export class PluginArtifactService {
  readonly store: PluginArtifactStore;
  private readonly deps: PluginArtifactServiceDeps;
  private readonly now: () => number;
  /** In-flight transfers by plugin, each with the project its artifact will belong to. */
  private readonly transfers = new Map<
    string,
    Map<AbortController, { projectId: string | null }>
  >();
  private activeTotal = 0;
  /** Bumped on every close of a project, so work that spans several awaits can tell it happened. */
  private readonly projectCloses = new Map<string, number>();
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;
  private disposed = false;

  constructor(deps: PluginArtifactServiceDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    const interval = deps.sweepIntervalMs ?? 60_000;
    this.sweepTimer = interval > 0 ? setInterval(() => this.store.sweepExpired(), interval) : null;
    this.sweepTimer?.unref?.();
  }

  /** Copy an opened, verified, regular source file into a new artifact. */
  async importFromHandle(
    meta: CreateMeta & { handle: FileHandle; size: number; sourceName: string }
  ): Promise<PluginArtifact> {
    const name = sanitizeArtifactName(meta.name ?? meta.sourceName);
    return this.run(meta, async (slot, signal, progress) => {
      const size = await copyHandleToPart({
        handle: meta.handle,
        size: meta.size,
        partPath: slot.partPath,
        reservation: slot.reservation,
        signal,
        onProgress: progress.report,
        idleMs: this.deps.idleMs,
      });
      if (size !== meta.size) {
        throw artifactError(
          "ARTIFACT_TRANSFER_FAILED",
          "the source file changed while it was copied"
        );
      }
      return {
        name,
        size,
        mimeType: normalizeMime(meta.mimeType) ?? getMimeType(name),
        origin: "import" as const,
      };
    });
  }

  async download(
    meta: CreateMeta & {
      url: URL;
      headers: Record<string, string>;
      isAllowed: ArtifactUrlMatcher;
      attempts: number;
    }
  ): Promise<PluginArtifact> {
    return this.run(meta, async (slot, signal, progress) => {
      const result = await downloadToPart({
        netFetch: this.deps.netFetch,
        url: meta.url,
        headers: meta.headers,
        isAllowed: meta.isAllowed,
        partPath: slot.partPath,
        reservation: slot.reservation,
        signal,
        attempts: meta.attempts,
        onProgress: progress.report,
        idleMs: this.deps.idleMs,
        backoffMs: this.deps.backoffMs,
      });
      const name = sanitizeArtifactName(meta.name ?? result.fileName);
      return {
        name,
        size: result.size,
        mimeType:
          normalizeMime(meta.mimeType) ??
          (normalizeMime(result.contentType) !== "application/octet-stream"
            ? normalizeMime(result.contentType)
            : null) ??
          getMimeType(name),
        origin: "download" as const,
      };
    });
  }

  async upload(options: {
    pluginId: string;
    artifactId: string;
    url: URL;
    method: "PUT" | "POST";
    headers: Record<string, string>;
    signal?: AbortSignal;
    onProgress?: (progress: PluginArtifactProgress) => void;
  }): Promise<PluginArtifactUploadResult> {
    const opened = this.store.openForRead(options.pluginId, options.artifactId);
    if (!opened) {
      throw artifactError(
        "ARTIFACT_NOT_FOUND",
        `plugin "${options.pluginId}" has no artifact "${options.artifactId}"`
      );
    }
    const progress = throttled(options.onProgress, this.now);
    try {
      return await this.withSlot(
        options.pluginId,
        opened.artifact.projectId,
        options.signal,
        (signal) =>
          uploadFromFile({
            request: this.deps.httpsRequest,
            url: options.url,
            method: options.method,
            headers: options.headers,
            filePath: opened.filePath,
            size: opened.artifact.size,
            signal,
            onProgress: progress.report,
            idleMs: this.deps.idleMs,
          })
      );
    } finally {
      progress.flush();
      opened.unpin();
    }
  }

  /**
   * A lease-bearing source URL for one view: `daintree-media:` for audio and
   * video, `daintree-file:` for raster images — the two schemes the renderer
   * CSP already admits for media and images, so no policy widens.
   */
  mintSource(pluginId: string, artifactId: string, webContentsId: number): PluginArtifactSource {
    const artifact = this.store.get(pluginId, artifactId);
    if (!artifact) {
      throw artifactError(
        "ARTIFACT_NOT_FOUND",
        `plugin "${pluginId}" has no artifact "${artifactId}"`
      );
    }
    const scheme = /^(audio|video)\//.test(artifact.mimeType)
      ? "daintree-media"
      : artifact.mimeType.startsWith("image/") && artifact.mimeType !== "image/svg+xml"
        ? "daintree-file"
        : null;
    if (!scheme) {
      throw artifactError(
        "ARTIFACT_SOURCE_UNSUPPORTED",
        `artifact "${artifactId}" is ${artifact.mimeType}, which has no playable source`
      );
    }
    const token = this.store.mintLease(pluginId, artifactId, webContentsId);
    if (!token) {
      throw artifactError(
        "ARTIFACT_NOT_FOUND",
        `plugin "${pluginId}" has no artifact "${artifactId}"`
      );
    }
    return {
      url: `${scheme}://artifact/${artifactId}?lease=${token}`,
      mimeType: artifact.mimeType,
      size: artifact.size,
    };
  }

  /**
   * Resolve a playback request: a live artifact and a lease minted for it.
   * The returned file is pinned until `unpin`.
   */
  openLeased(
    artifactId: string,
    token: string
  ): { filePath: string; mimeType: string; unpin: () => void } | null {
    const lease = this.store.resolveLease(artifactId, token);
    if (!lease) return null;
    const opened = this.store.openForRead(lease.pluginId, artifactId);
    if (!opened) return null;
    return { filePath: opened.filePath, mimeType: opened.artifact.mimeType, unpin: opened.unpin };
  }

  /** The plugin unloaded: cancel what it has in flight and drop everything it holds. */
  forgetPlugin(pluginId: string): void {
    for (const controller of this.transfers.get(pluginId)?.keys() ?? []) {
      controller.abort(transferAbortError());
    }
    this.store.releaseWhere((owner) => owner.pluginId === pluginId);
  }

  /**
   * A project closed: its artifacts, every plugin's, go with it, and so do
   * transfers that would have created one for it.
   */
  forgetProject(projectId: string): void {
    this.projectCloses.set(projectId, this.projectCloseCount(projectId) + 1);
    for (const byController of this.transfers.values()) {
      for (const [controller, owner] of byController) {
        if (owner.projectId === projectId) controller.abort(transferAbortError());
      }
    }
    this.store.releaseWhere((owner) => owner.projectId === projectId);
  }

  /** How often `projectId` has closed in this session; compare two readings to see a close between them. */
  projectCloseCount(projectId: string): number {
    return this.projectCloses.get(projectId) ?? 0;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const byController of this.transfers.values()) {
      for (const controller of byController.keys()) controller.abort(transferAbortError());
    }
    await this.store.dispose();
  }

  private async run(
    meta: CreateMeta,
    write: (
      slot: ArtifactSlot,
      signal: AbortSignal,
      progress: ReturnType<typeof throttled>
    ) => Promise<{ name: string; size: number; mimeType: string; origin: PluginArtifact["origin"] }>
  ): Promise<PluginArtifact> {
    const progress = throttled(meta.onProgress, this.now);
    return this.withSlot(meta.pluginId, meta.projectId, meta.signal, async (signal) => {
      const slot = await this.store.allocate(meta.pluginId);
      try {
        const written = await write(slot, signal, progress);
        if (signal.aborted) throw transferAbortError(signal);
        progress.flush();
        return await this.store.commit(
          slot,
          {
            pluginId: meta.pluginId,
            projectId: meta.projectId,
            name: written.name,
            mimeType: written.mimeType,
            size: written.size,
            ttlMs: clampTtl(meta.ttlMs),
            origin: written.origin,
          },
          // An unload or project close landing during the rename aborts this
          // signal; the artifact must not appear after it.
          () => !signal.aborted
        );
      } catch (error) {
        if (signal.aborted) throw transferAbortError(signal);
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && /^[A-Z_]+$/.test(code)) throw error;
        throw artifactError(
          "ARTIFACT_TRANSFER_FAILED",
          formatErrorMessage(error, "the transfer failed")
        );
      } finally {
        await slot.discard();
      }
    });
  }

  /**
   * Hold one of the plugin's transfer slots for the length of `work`. The
   * slot registers before the first await, so a caller that checked the
   * plugin is loaded immediately before calling cannot race its unload.
   */
  private async withSlot<T>(
    pluginId: string,
    projectId: string | null,
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.disposed)
      throw artifactError("ARTIFACT_TRANSFER_FAILED", "the artifact cache has shut down");
    if (callerSignal?.aborted) throw transferAbortError(callerSignal);
    const mine =
      this.transfers.get(pluginId) ?? new Map<AbortController, { projectId: string | null }>();
    if (
      mine.size >= PLUGIN_ARTIFACT_MAX_TRANSFERS_PER_PLUGIN ||
      this.activeTotal >= PLUGIN_ARTIFACT_MAX_TRANSFERS
    ) {
      throw artifactError(
        "ARTIFACT_BUSY",
        `plugin "${pluginId}" already has ${mine.size} transfer${mine.size === 1 ? "" : "s"} running`
      );
    }
    const controller = new AbortController();
    mine.set(controller, { projectId });
    this.transfers.set(pluginId, mine);
    this.activeTotal++;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    try {
      return await work(signal);
    } finally {
      this.activeTotal--;
      mine.delete(controller);
      if (mine.size === 0) this.transfers.delete(pluginId);
    }
  }
}
