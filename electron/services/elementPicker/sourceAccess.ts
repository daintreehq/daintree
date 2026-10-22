import path from "node:path";
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";
import {
  SourceFileRefSchema,
  type FileRevision,
  type SourceFileRef,
  type UnavailableReason,
} from "../../../shared/elementPicker/resolution.js";
import type {
  ResolveBudget,
  RevisionedSource,
  RevisionedSourceMap,
  SourceAccessResult,
} from "../../../shared/elementPicker/resolver.js";
import { hasControlCharacter, isStrictlyInside } from "./containment.js";
import { locateMapSource } from "./sourceLocator.js";

/**
 * Main's half of `ResolverSourceAccess`: everything the host process may read
 * goes through here, contained and counted, and comes back as bytes.
 */

export function revisionOf(bytes: Uint8Array): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mapKey(mapUrl: string | null, revision: FileRevision): string {
  return `${revision} ${mapUrl ?? ""}`;
}

/** Both canonical: realpathed once, when the workspace was registered. */
export interface SourceRoots {
  /** What a `SourceFileRef.path` is relative to. */
  readonly worktreePath: string;
  /** What a read must stay inside. The worktree itself, or an app within it. */
  readonly appRoot: string;
}

type Contained = { ok: true; absolute: string } | { ok: false; reason: UnavailableReason };

/** Where a ref's path lands, if it lands inside the app at all. Lexical: nothing is read. */
export function lexicalSourcePath(roots: SourceRoots, relative: string): string | null {
  if (hasControlCharacter(relative)) return null;
  const lexical = path.resolve(roots.worktreePath, ...relative.split("/"));
  return isStrictlyInside(roots.appRoot, lexical) ? lexical : null;
}

/**
 * The ref a page-reported path names, if it names a file inside the app. A dev
 * server reports a file relative to the root it serves, which is the app root
 * and in a monorepo not the worktree, or absolute when the file is outside
 * that root; refs are relative to the worktree, so the two are reconciled here
 * rather than by a resolver that is never told where either root is.
 */
export function locateReportedFile(
  workspaceId: string,
  roots: SourceRoots,
  reported: unknown
): SourceFileRef | null {
  if (typeof reported !== "string" || reported.length === 0 || hasControlCharacter(reported)) {
    return null;
  }
  const absolute = path.isAbsolute(reported)
    ? path.resolve(reported)
    : path.resolve(roots.appRoot, reported);
  if (!isStrictlyInside(roots.appRoot, absolute)) return null;
  const relative = path.relative(roots.worktreePath, absolute).split(path.sep).join("/");
  const parsed = SourceFileRefSchema.safeParse({ workspaceId, path: relative });
  return parsed.success ? parsed.data : null;
}

/**
 * The file a ref names, if it is one this workspace may read. Lexical first,
 * so a ref that points out of the app never touches the disk; then the real
 * path, so a symlink inside the app that leads out of it is refused too.
 */
export async function containSourcePath(roots: SourceRoots, relative: string): Promise<Contained> {
  const lexical = lexicalSourcePath(roots, relative);
  if (lexical === null) return { ok: false, reason: "outside-workspace" };
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch {
    return { ok: false, reason: "file-missing" };
  }
  if (!isStrictlyInside(roots.appRoot, real)) return { ok: false, reason: "outside-workspace" };
  return { ok: true, absolute: real };
}

export type BoundedRead =
  { status: "ok"; bytes: Uint8Array } | { status: "missing" } | { status: "too-large" };

/**
 * At most `limitBytes` of one regular file, which `absolute` must name by its
 * real path. O_NOFOLLOW refuses a leaf swapped for a symlink after containment
 * resolved it, O_NONBLOCK keeps a FIFO from holding the open, and the
 * descriptor is compared with what stands at the path so Windows, which has no
 * O_NOFOLLOW, is held to the same leaf. The path is resolved again once the
 * file is open, so an ancestor swapped for a symlink and left there is
 * refused too; one swapped and put back between the two is not, as for every
 * pathname read in main.
 */
export async function readBoundedSource(
  absolute: string,
  limitBytes: number,
  signal?: AbortSignal
): Promise<BoundedRead> {
  signal?.throwIfAborted();
  let handle: FileHandle;
  try {
    handle = await fs.open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    );
  } catch {
    return { status: "missing" };
  }
  try {
    const [opened, entry, real] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(absolute, { bigint: true }).catch(() => null),
      fs.realpath(absolute).catch(() => null),
    ]);
    if (!entry || entry.isSymbolicLink() || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      return { status: "missing" };
    }
    if (real !== absolute) return { status: "missing" };
    if (!opened.isFile()) return { status: "missing" };
    const bytes = await readBoundedFromHandle(handle, Number(opened.size), limitBytes, signal);
    if (bytes === null) return { status: "too-large" };
    // A copy with its own backing store: structured clone sends a view's whole
    // ArrayBuffer, and a pooled Buffer's holds other reads.
    return { status: "ok", bytes: new Uint8Array(bytes) };
  } catch (error) {
    // A cancelled read is not a missing file.
    if (signal?.aborted) throw error;
    return { status: "missing" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The revision a file holds now under the same cap, or null when it is not readable source. */
export async function readSourceRevision(
  absolute: string,
  limitBytes: number
): Promise<FileRevision | null> {
  const read = await readBoundedSource(absolute, limitBytes).catch(() => null);
  return read?.status === "ok" ? revisionOf(read.bytes) : null;
}

/** One job's network allowance, spent as the work happens so a failed fetch still pays for what it moved. */
export interface NetworkAllowance {
  /** Spends one request, a redirect hop included; false when none is left. */
  request(): boolean;
  /** Spends bytes as they arrive; false once they pass what the job may move. */
  bytes(count: number): boolean;
}

export interface ServedSourceMap extends RevisionedSourceMap {
  /** What the map's relative sources resolve against: its own URL, or the module's, after redirects, for an inline map. */
  base: string;
}

/**
 * Finds the map for a generated module. Main-only: it holds the origin the
 * workspace was registered with and spends the job's allowance, so it alone
 * decides what is fetched from where.
 */
export type SourceMapProvider = (
  request: {
    workspaceId: string;
    previewOrigin: string;
    generatedUrl: string;
    allowance: NetworkAllowance;
  },
  signal: AbortSignal
) => Promise<SourceAccessResult<ServedSourceMap>>;

export interface JobSourceAccessOptions {
  workspaceId: string;
  roots: SourceRoots;
  budget: ResolveBudget;
  /** Aborted when the job is cancelled, runs out of time, or its workspace closes. */
  signal: AbortSignal;
  /** Whether an abort was the deadline, which reads as `budget-exhausted` rather than `cancelled`. */
  expired: () => boolean;
  /** Where the workspace's preview is served from; null refuses every fetch. */
  previewOrigin: string | null;
  sourceMaps: SourceMapProvider;
  /** A file this job read, for the workspace's tracker. */
  onRead: (absolute: string, file: SourceFileRef, revision: FileRevision) => void;
}

/**
 * One job's reads, under its budget. A file is read at most once per job and
 * every later read of it is answered from that first one, so one resolve sees
 * one revision of each file and repeat reads cost nothing against `maxFiles`.
 * A read is charged when it starts, failed or not. A map is the same: fetched
 * once per generated URL, whichever resolver asks, so every resolver in the
 * job sees the same map for a module.
 */
export class JobSourceAccess {
  private readonly reads = new Map<string, Promise<SourceAccessResult<RevisionedSource>>>();
  private readonly served = new Map<string, FileRevision>();
  private readonly maps = new Map<string, Promise<SourceAccessResult<ServedSourceMap>>>();
  private readonly servedMaps = new Set<string>();
  private networkRequests = 0;
  private networkBytes = 0;
  /** One fetch at a time, so each starts with what the ones before it left of the allowance. */
  private fetching: Promise<unknown> = Promise.resolve();
  private readonly allowance: NetworkAllowance = {
    request: () => {
      if (this.networkRequests >= this.options.budget.maxNetworkRequests) return false;
      this.networkRequests += 1;
      return true;
    },
    bytes: (count) => {
      this.networkBytes += count;
      return this.networkBytes <= this.options.budget.maxNetworkBytes;
    },
  };

  constructor(private readonly options: JobSourceAccessOptions) {}

  /** The revision this job served for a path, if it served one: a resolver may claim no other. */
  servedRevision(relative: string): FileRevision | undefined {
    return this.served.get(relative);
  }

  /** Whether this job served the map a result says it was mapped through. */
  servedMap(mapUrl: string | null, revision: FileRevision): boolean {
    return this.servedMaps.has(mapKey(mapUrl, revision));
  }

  /** Lexical, so a refused path never touches the disk; the read that follows still contains the real path. */
  locateFile(reported: unknown): SourceAccessResult<SourceFileRef> {
    const stopped = this.stopped();
    if (stopped) return stopped;
    const file = locateReportedFile(this.options.workspaceId, this.options.roots, reported);
    return file ? { ok: true, value: file } : { ok: false, reason: "outside-workspace" };
  }

  readSource(file: unknown): Promise<SourceAccessResult<RevisionedSource>> {
    const stopped = this.stopped();
    if (stopped) return Promise.resolve(stopped);
    const parsed = SourceFileRefSchema.safeParse(file);
    if (!parsed.success || parsed.data.workspaceId !== this.options.workspaceId) {
      return Promise.resolve({ ok: false, reason: "outside-workspace" });
    }
    const ref = parsed.data;
    const existing = this.reads.get(ref.path);
    if (existing) return existing;
    if (this.reads.size >= this.options.budget.maxFiles) {
      return Promise.resolve({ ok: false, reason: "budget-exhausted" });
    }
    const read = this.read(ref);
    this.reads.set(ref.path, read);
    return read;
  }

  fetchSourceMap(generatedUrl: string): Promise<SourceAccessResult<RevisionedSourceMap>> {
    const stopped = this.stopped();
    if (stopped) return Promise.resolve(stopped);
    let fetched = this.maps.get(generatedUrl);
    if (!fetched) {
      fetched = this.fetching.then(() => this.fetch(generatedUrl));
      this.fetching = fetched.catch(() => undefined);
      this.maps.set(generatedUrl, fetched);
    }
    return fetched.then((result) => {
      if (!result.ok) return result;
      const { url, revision, text } = result.value;
      return { ok: true, value: { url, revision, text } };
    });
  }

  /**
   * The workspace file a source names in the map this job fetched for
   * `generatedUrl`. Only a map this job served gives a source its base, so a
   * resolver cannot pick what a relative source resolves against.
   */
  async locateSource(
    generatedUrl: string,
    source: string,
    sourceRoot: string | null
  ): Promise<SourceAccessResult<SourceFileRef>> {
    const stopped = this.stopped();
    if (stopped) return stopped;
    const fetched = await this.maps.get(generatedUrl);
    const late = this.stopped();
    if (late) return late;
    if (!fetched) return { ok: false, reason: "map-missing" };
    // Whatever kept the map from this job keeps its sources from it too.
    if (!fetched.ok) return fetched;
    const { previewOrigin } = this.options;
    if (previewOrigin === null) return { ok: false, reason: "unsupported" };
    return locateMapSource(source, sourceRoot, {
      workspaceId: this.options.workspaceId,
      roots: this.options.roots,
      previewOrigin,
      base: fetched.value.base,
    });
  }

  private async fetch(generatedUrl: string): Promise<SourceAccessResult<ServedSourceMap>> {
    const stopped = this.stopped();
    if (stopped) return stopped;
    const { budget, previewOrigin } = this.options;
    if (previewOrigin === null) return { ok: false, reason: "unsupported" };
    if (
      this.networkRequests >= budget.maxNetworkRequests ||
      this.networkBytes >= budget.maxNetworkBytes
    ) {
      return { ok: false, reason: "budget-exhausted" };
    }
    let result: SourceAccessResult<ServedSourceMap>;
    try {
      result = await this.options.sourceMaps(
        {
          workspaceId: this.options.workspaceId,
          previewOrigin,
          generatedUrl,
          allowance: this.allowance,
        },
        this.options.signal
      );
    } catch {
      return this.stopped() ?? { ok: false, reason: "map-missing" };
    }
    const late = this.stopped();
    if (late) return late;
    if (result.ok) this.servedMaps.add(mapKey(result.value.url, result.value.revision));
    return result;
  }

  private async read(ref: SourceFileRef): Promise<SourceAccessResult<RevisionedSource>> {
    const { roots, budget, signal } = this.options;
    const contained = await containSourcePath(roots, ref.path);
    const afterContain = this.stopped();
    if (afterContain) return afterContain;
    if (!contained.ok) return contained;
    let read: BoundedRead;
    try {
      read = await readBoundedSource(contained.absolute, budget.maxFileBytes, signal);
    } catch {
      return this.stopped() ?? { ok: false, reason: "file-missing" };
    }
    const late = this.stopped();
    if (late) return late;
    if (read.status === "missing") return { ok: false, reason: "file-missing" };
    if (read.status === "too-large") return { ok: false, reason: "budget-exhausted" };
    const revision = revisionOf(read.bytes);
    this.served.set(ref.path, revision);
    this.options.onRead(contained.absolute, ref, revision);
    return { ok: true, value: { file: ref, revision, bytes: read.bytes } };
  }

  private stopped(): { ok: false; reason: UnavailableReason } | null {
    if (!this.options.signal.aborted) return null;
    return { ok: false, reason: this.options.expired() ? "budget-exhausted" : "cancelled" };
  }
}
