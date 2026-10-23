import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_ARTIFACT_CACHE_QUOTA_BYTES,
  PLUGIN_ARTIFACT_LEASES_PER_VIEW,
  PLUGIN_ARTIFACT_MAX_BYTES,
  PLUGIN_ARTIFACT_MAX_PER_PLUGIN,
  PLUGIN_ARTIFACT_PLUGIN_QUOTA_BYTES,
} from "../../../shared/config/pluginArtifacts.js";
import type { PluginArtifact } from "../../../shared/types/pluginArtifacts.js";
import { artifactError } from "./pluginArtifactErrors.js";

export interface PluginArtifactStoreLimits {
  maxArtifactBytes: number;
  pluginQuotaBytes: number;
  cacheQuotaBytes: number;
  maxPerPlugin: number;
  leasesPerView: number;
}

const DEFAULT_LIMITS: PluginArtifactStoreLimits = {
  maxArtifactBytes: PLUGIN_ARTIFACT_MAX_BYTES,
  pluginQuotaBytes: PLUGIN_ARTIFACT_PLUGIN_QUOTA_BYTES,
  cacheQuotaBytes: PLUGIN_ARTIFACT_CACHE_QUOTA_BYTES,
  maxPerPlugin: PLUGIN_ARTIFACT_MAX_PER_PLUGIN,
  leasesPerView: PLUGIN_ARTIFACT_LEASES_PER_VIEW,
};

export interface PluginArtifactStoreOptions {
  /** Parent of every run's cache, under the app's data directory. */
  rootDir: string;
  now?: () => number;
  limits?: Partial<PluginArtifactStoreLimits>;
}

interface ArtifactRecord {
  artifact: PluginArtifact;
  pluginId: string;
  dir: string;
  filePath: string;
  lastUsedAt: number;
  /** Open playback or upload streams; deletion waits for them. */
  readers: number;
  gone: boolean;
}

interface Lease {
  artifactId: string;
  pluginId: string;
  webContentsId: number;
}

/** Bytes a transfer in flight holds against the quotas until it commits or fails. */
export interface ArtifactReservation {
  readonly bytes: number;
  /** Hold `total` bytes; rejects `ARTIFACT_TOO_LARGE` / `ARTIFACT_QUOTA_EXCEEDED`. */
  ensure(total: number): void;
  release(): void;
}

/** Where a transfer writes before it commits. */
export interface ArtifactSlot {
  readonly id: string;
  readonly dir: string;
  readonly partPath: string;
  readonly reservation: ArtifactReservation;
  /** Remove the slot and everything in it. Safe after commit (does nothing then). */
  discard(): Promise<void>;
}

const ID_BYTES = 16;
const LEASE_BYTES = 24;

function newToken(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Artifact ids and lease tokens are lower-case hex of a fixed length; anything else is refused unread. */
export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function isArtifactLeaseToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{48}$/.test(value);
}

/**
 * The session's artifact cache (#14100): an in-memory index over files under
 * `<rootDir>/<run>/<artifact-id>/`. Nothing is recovered across restarts —
 * {@link init} removes every earlier run's directory before the first write.
 *
 * Quotas count committed bytes and bytes in-flight transfers have reserved.
 * When a reservation would cross one, the least recently used artifacts that
 * nothing is reading go first: the plugin's own for its quota, anyone's for
 * the cache's. An artifact being read is never evicted, and one removed while
 * read keeps its file until the last reader closes.
 *
 * Playback leases bind an artifact to one view: the protocol request carries
 * no sender, so the lease token in its URL is the only authority it has.
 */
export class PluginArtifactStore {
  private readonly rootDir: string;
  private readonly now: () => number;
  private readonly limits: PluginArtifactStoreLimits;
  private readonly runDir: string;
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly reservedByPlugin = new Map<string, number>();
  private reservedTotal = 0;
  /** Removed artifacts whose files a reader still holds: their bytes stay charged until deleted. */
  private readonly lingering = new Set<ArtifactRecord>();
  /** Slots allocated and not yet committed or discarded, per plugin. */
  private readonly openSlots = new Map<string, number>();
  private readonly leases = new Map<string, Lease>();
  private readonly leasesByView = new Map<number, string[]>();
  private ready: Promise<void> | null = null;
  private disposed = false;

  constructor(options: PluginArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.now = options.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.runDir = path.join(this.rootDir, `run-${newToken(8)}`);
  }

  /** Remove earlier runs and create this one's directory. Idempotent. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(
        entries
          // Only what an earlier run planted: never follow a link out of the cache.
          .filter((entry) => entry.isDirectory() && /^run-[0-9a-f]{16}$/.test(entry.name))
          .map((entry) =>
            fs.rm(path.join(this.rootDir, entry.name), { recursive: true, force: true })
          )
      );
      await fs.mkdir(this.runDir, { mode: 0o700 });
    })();
    return this.ready;
  }

  /** A fresh slot to write into, holding no bytes yet. */
  async allocate(pluginId: string): Promise<ArtifactSlot> {
    this.assertLive();
    await this.init();
    this.sweepExpired();
    const owned = [...this.records.values()].filter((r) => r.pluginId === pluginId);
    // Slots in flight count, so concurrent transfers can't commit past the cap.
    if (owned.length + (this.openSlots.get(pluginId) ?? 0) >= this.limits.maxPerPlugin) {
      const oldest = owned
        .filter((r) => r.readers === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!oldest) {
        throw artifactError(
          "ARTIFACT_QUOTA_EXCEEDED",
          `plugin "${pluginId}" already holds ${this.limits.maxPerPlugin} artifacts`
        );
      }
      this.remove(oldest);
    }
    const id = newToken(ID_BYTES);
    const dir = path.join(this.runDir, id);
    this.openSlots.set(pluginId, (this.openSlots.get(pluginId) ?? 0) + 1);
    let slotOpen = true;
    const closeSlot = () => {
      if (!slotOpen) return;
      slotOpen = false;
      const left = (this.openSlots.get(pluginId) ?? 1) - 1;
      if (left > 0) this.openSlots.set(pluginId, left);
      else this.openSlots.delete(pluginId);
    };
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      closeSlot();
      throw error;
    }
    const reservation = this.reserve(pluginId);
    let committed = false;
    const slot: ArtifactSlot & { markCommitted(): void } = {
      id,
      dir,
      partPath: path.join(dir, "payload.part"),
      reservation,
      discard: async () => {
        reservation.release();
        closeSlot();
        if (committed) return;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
      markCommitted: () => {
        committed = true;
        closeSlot();
      },
    };
    return slot;
  }

  /**
   * Publish a slot whose `.part` holds exactly `size` bytes. The rename is the
   * commit: until it lands, nothing can see the artifact. `stillWanted` is
   * asked once the rename has landed — an unload or a cancel that arrived
   * during it must not see an artifact appear afterwards.
   */
  async commit(
    slot: ArtifactSlot,
    meta: {
      pluginId: string;
      projectId: string | null;
      name: string;
      mimeType: string;
      size: number;
      ttlMs: number;
      origin: PluginArtifact["origin"];
    },
    stillWanted: () => boolean = () => true
  ): Promise<PluginArtifact> {
    this.assertLive();
    const filePath = path.join(slot.dir, "payload");
    await fs.rename(slot.partPath, filePath);
    if (this.disposed || !stillWanted()) {
      throw artifactError("ARTIFACT_TRANSFER_FAILED", "the transfer ended before it was published");
    }
    const createdAt = this.now();
    const artifact: PluginArtifact = Object.freeze({
      id: slot.id,
      projectId: meta.projectId,
      name: meta.name,
      mimeType: meta.mimeType,
      size: meta.size,
      createdAt,
      expiresAt: createdAt + meta.ttlMs,
      origin: meta.origin,
    });
    this.records.set(slot.id, {
      artifact,
      pluginId: meta.pluginId,
      dir: slot.dir,
      filePath,
      lastUsedAt: createdAt,
      readers: 0,
      gone: false,
    });
    (slot as ArtifactSlot & { markCommitted(): void }).markCommitted();
    slot.reservation.release();
    return artifact;
  }

  /** The plugin's artifact, or null when it is missing, expired or someone else's. */
  get(pluginId: string, artifactId: string): PluginArtifact | null {
    const record = this.live(artifactId);
    if (!record || record.pluginId !== pluginId) return null;
    record.lastUsedAt = this.now();
    return record.artifact;
  }

  list(pluginId: string, projectId?: string | null): PluginArtifact[] {
    this.sweepExpired();
    return [...this.records.values()]
      .filter(
        (r) =>
          r.pluginId === pluginId && (projectId === undefined || r.artifact.projectId === projectId)
      )
      .map((r) => r.artifact)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  release(pluginId: string, artifactId: string): boolean {
    const record = this.live(artifactId);
    if (!record || record.pluginId !== pluginId) return false;
    this.remove(record);
    return true;
  }

  /** Remove every artifact the predicate picks: a plugin unloading, a project closing. */
  releaseWhere(predicate: (owner: { pluginId: string; projectId: string | null }) => boolean) {
    for (const record of [...this.records.values()]) {
      if (predicate({ pluginId: record.pluginId, projectId: record.artifact.projectId })) {
        this.remove(record);
      }
    }
  }

  /**
   * Pin the artifact's file for a read. The returned `unpin` must run once
   * the stream closes; a removal in between waits for it.
   */
  openForRead(
    pluginId: string,
    artifactId: string
  ): { artifact: PluginArtifact; filePath: string; unpin: () => void } | null {
    const record = this.live(artifactId);
    if (!record || record.pluginId !== pluginId) return null;
    record.readers++;
    record.lastUsedAt = this.now();
    let pinned = true;
    return {
      artifact: record.artifact,
      filePath: record.filePath,
      unpin: () => {
        if (!pinned) return;
        pinned = false;
        record.readers--;
        if (record.gone && record.readers === 0) void this.deleteFiles(record);
      },
    };
  }

  /** A playback lease for one view. */
  mintLease(pluginId: string, artifactId: string, webContentsId: number): string | null {
    const record = this.live(artifactId);
    if (!record || record.pluginId !== pluginId) return null;
    const token = newToken(LEASE_BYTES);
    this.leases.set(token, { artifactId, pluginId, webContentsId });
    const forView = this.leasesByView.get(webContentsId) ?? [];
    forView.push(token);
    while (forView.length > this.limits.leasesPerView) {
      const oldest = forView.shift();
      if (oldest) this.leases.delete(oldest);
    }
    this.leasesByView.set(webContentsId, forView);
    return token;
  }

  /** The lease's artifact, still live and still the lease's; null otherwise. */
  resolveLease(
    artifactId: string,
    token: string
  ): { pluginId: string; webContentsId: number } | null {
    const lease = this.leases.get(token);
    if (!lease || lease.artifactId !== artifactId) return null;
    const record = this.live(artifactId);
    if (!record || record.pluginId !== lease.pluginId) {
      this.revokeLease(token);
      return null;
    }
    return { pluginId: lease.pluginId, webContentsId: lease.webContentsId };
  }

  revokeLease(token: string, webContentsId?: number): boolean {
    const lease = this.leases.get(token);
    if (!lease || (webContentsId !== undefined && lease.webContentsId !== webContentsId)) {
      return false;
    }
    this.leases.delete(token);
    const forView = this.leasesByView.get(lease.webContentsId);
    if (forView) {
      const next = forView.filter((t) => t !== token);
      if (next.length > 0) this.leasesByView.set(lease.webContentsId, next);
      else this.leasesByView.delete(lease.webContentsId);
    }
    return true;
  }

  /** The view went away: none of its leases can be used again. */
  revokeLeasesForView(webContentsId: number): void {
    for (const token of this.leasesByView.get(webContentsId) ?? []) this.leases.delete(token);
    this.leasesByView.delete(webContentsId);
  }

  /** Drop artifacts past their expiry. Runs on every allocation and list, and on the service's timer. */
  sweepExpired(): void {
    const now = this.now();
    for (const record of [...this.records.values()]) {
      if (record.artifact.expiresAt <= now) this.remove(record);
    }
  }

  /** Committed bytes plus reserved, overall and for one plugin. */
  usage(pluginId?: string): number {
    let total = pluginId === undefined ? this.reservedTotal : this.reservedFor(pluginId);
    for (const record of [...this.records.values(), ...this.lingering]) {
      if (pluginId === undefined || record.pluginId === pluginId) total += record.artifact.size;
    }
    return total;
  }

  /** Stop admitting, forget every handle and remove this run's files. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
    this.lingering.clear();
    this.leases.clear();
    this.leasesByView.clear();
    await fs.rm(this.runDir, { recursive: true, force: true }).catch(() => {});
  }

  private reserve(pluginId: string): ArtifactReservation {
    let held = 0;
    let released = false;
    return {
      get bytes() {
        return held;
      },
      ensure: (total: number) => {
        if (released) throw artifactError("ARTIFACT_TRANSFER_FAILED", "transfer already ended");
        if (total <= held) return;
        if (total > this.limits.maxArtifactBytes) {
          throw artifactError(
            "ARTIFACT_TOO_LARGE",
            `an artifact may hold at most ${this.limits.maxArtifactBytes} bytes`
          );
        }
        const extra = total - held;
        this.makeRoom(pluginId, extra);
        held = total;
        this.reservedTotal += extra;
        this.reservedByPlugin.set(pluginId, this.reservedFor(pluginId) + extra);
      },
      release: () => {
        if (released) return;
        released = true;
        this.reservedTotal -= held;
        const next = this.reservedFor(pluginId) - held;
        if (next > 0) this.reservedByPlugin.set(pluginId, next);
        else this.reservedByPlugin.delete(pluginId);
        held = 0;
      },
    };
  }

  private makeRoom(pluginId: string, extra: number): void {
    const evict = (
      over: () => boolean,
      candidates: () => ArtifactRecord[],
      quota: string
    ): void => {
      while (over()) {
        const victim = candidates()
          .filter((r) => r.readers === 0)
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (!victim) throw artifactError("ARTIFACT_QUOTA_EXCEEDED", `the ${quota} is full`);
        this.remove(victim);
      }
    };
    evict(
      () => this.usage(pluginId) + extra > this.limits.pluginQuotaBytes,
      () => [...this.records.values()].filter((r) => r.pluginId === pluginId),
      `artifact quota for plugin "${pluginId}"`
    );
    evict(
      () => this.usage() + extra > this.limits.cacheQuotaBytes,
      () => [...this.records.values()],
      "artifact cache"
    );
  }

  private reservedFor(pluginId: string): number {
    return this.reservedByPlugin.get(pluginId) ?? 0;
  }

  private live(artifactId: string): ArtifactRecord | null {
    const record = this.records.get(artifactId);
    if (!record) return null;
    if (record.artifact.expiresAt <= this.now()) {
      this.remove(record);
      return null;
    }
    return record;
  }

  private remove(record: ArtifactRecord): void {
    if (record.gone) return;
    record.gone = true;
    this.records.delete(record.artifact.id);
    for (const [token, lease] of [...this.leases]) {
      if (lease.artifactId === record.artifact.id) this.revokeLease(token);
    }
    // A file a reader still holds stays charged until it is actually gone;
    // one nobody reads frees its room now, so eviction can make space.
    if (record.readers > 0) this.lingering.add(record);
    else void this.deleteFiles(record);
  }

  private async deleteFiles(record: ArtifactRecord): Promise<void> {
    try {
      await fs.rm(record.dir, { recursive: true, force: true });
      this.lingering.delete(record);
    } catch {
      // Still on disk (a permission change, a Windows handle): a lingering
      // one stays charged, and the next run's startup sweep removes it.
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw artifactError("ARTIFACT_TRANSFER_FAILED", "the artifact cache has shut down");
    }
  }
}
