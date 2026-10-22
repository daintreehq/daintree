import path from "node:path";
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";
import { utf8ByteLength } from "../../../shared/utils/boundedOutput.js";
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

/**
 * Main's half of `ResolverSourceAccess`: everything the host process may read
 * goes through here, contained and counted, and comes back as bytes.
 */

export function revisionOf(bytes: Uint8Array): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Both canonical: realpathed once, when the workspace was registered. */
export interface SourceRoots {
  /** What a `SourceFileRef.path` is relative to. */
  readonly worktreePath: string;
  /** What a read must stay inside. The worktree itself, or an app within it. */
  readonly appRoot: string;
}

export function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

type Contained = { ok: true; absolute: string } | { ok: false; reason: UnavailableReason };

/**
 * The file a ref names, if it is one this workspace may read. Lexical first,
 * so a ref that points out of the app never touches the disk; then the real
 * path, so a symlink inside the app that leads out of it is refused too.
 */
export async function containSourcePath(roots: SourceRoots, relative: string): Promise<Contained> {
  if (hasControlCharacter(relative)) return { ok: false, reason: "outside-workspace" };
  const lexical = path.resolve(roots.worktreePath, ...relative.split("/"));
  if (!isStrictlyInside(roots.appRoot, lexical)) return { ok: false, reason: "outside-workspace" };
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
 * At most `limitBytes` of one regular file. O_NOFOLLOW refuses a leaf swapped
 * for a symlink after containment resolved it, O_NONBLOCK keeps a FIFO from
 * holding the open, and the descriptor is compared with what stands at the
 * path so Windows, which has no O_NOFOLLOW, is held to the same leaf. An
 * ancestor swapped between containment and the open is not covered, as for
 * every pathname read in main.
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
    const [opened, entry] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(absolute, { bigint: true }).catch(() => null),
    ]);
    if (!entry || entry.isSymbolicLink() || entry.dev !== opened.dev || entry.ino !== opened.ino) {
      return { status: "missing" };
    }
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

/**
 * Finds the map for a generated module. Main-only, and given the request's
 * remaining network allowance; the host still counts what it returns.
 */
export type SourceMapProvider = (
  request: { workspaceId: string; generatedUrl: string; maxBytes: number },
  signal: AbortSignal
) => Promise<SourceAccessResult<RevisionedSourceMap>>;

/** No fetching yet: symbolication brings its own provider. */
export const unsupportedSourceMaps: SourceMapProvider = async () => ({
  ok: false,
  reason: "unsupported",
});

export interface JobSourceAccessOptions {
  workspaceId: string;
  roots: SourceRoots;
  budget: ResolveBudget;
  /** Aborted when the job is cancelled, runs out of time, or its workspace closes. */
  signal: AbortSignal;
  /** Whether an abort was the deadline, which reads as `budget-exhausted` rather than `cancelled`. */
  expired: () => boolean;
  sourceMaps: SourceMapProvider;
  /** A file this job read, for the workspace's tracker. */
  onRead: (absolute: string, file: SourceFileRef, revision: FileRevision) => void;
}

/**
 * One job's reads, under its budget. A file is read at most once per job and
 * every later read of it is answered from that first one, so one resolve sees
 * one revision of each file and repeat reads cost nothing against `maxFiles`.
 * A read is charged when it starts, failed or not.
 */
export class JobSourceAccess {
  private readonly reads = new Map<string, Promise<SourceAccessResult<RevisionedSource>>>();
  private networkRequests = 0;
  private networkBytes = 0;

  constructor(private readonly options: JobSourceAccessOptions) {}

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

  async fetchSourceMap(generatedUrl: string): Promise<SourceAccessResult<RevisionedSourceMap>> {
    const stopped = this.stopped();
    if (stopped) return stopped;
    const { budget } = this.options;
    if (this.networkRequests >= budget.maxNetworkRequests) {
      return { ok: false, reason: "budget-exhausted" };
    }
    this.networkRequests += 1;
    const maxBytes = budget.maxNetworkBytes - this.networkBytes;
    let result: SourceAccessResult<RevisionedSourceMap>;
    try {
      result = await this.options.sourceMaps(
        { workspaceId: this.options.workspaceId, generatedUrl, maxBytes },
        this.options.signal
      );
    } catch {
      return this.stopped() ?? { ok: false, reason: "map-missing" };
    }
    const late = this.stopped();
    if (late) return late;
    if (!result.ok) return result;
    this.networkBytes += utf8ByteLength(result.value.text);
    if (this.networkBytes > budget.maxNetworkBytes)
      return { ok: false, reason: "budget-exhausted" };
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
    this.options.onRead(contained.absolute, ref, revision);
    return { ok: true, value: { file: ref, revision, bytes: read.bytes } };
  }

  private stopped(): { ok: false; reason: UnavailableReason } | null {
    if (!this.options.signal.aborted) return null;
    return { ok: false, reason: this.options.expired() ? "budget-exhausted" : "cancelled" };
  }
}
