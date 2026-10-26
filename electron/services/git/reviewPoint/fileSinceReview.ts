import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ReviewComparisonFile,
  ReviewComparisonSide,
} from "../../../../shared/types/reviewComparison.js";
import type { ReviewPoint, ReviewPointGitEntry } from "../../../../shared/types/reviewPoint.js";
import type {
  ReviewFileSinceSide,
  ReviewFileSinceView,
} from "../../../../shared/types/ipc/reviewMarks.js";
import { absoluteWorktreePath, blobId, lstatOrNull } from "./readWorktreePath.js";
import { GitCommandError, GitOutputLimitError, runGitForBytes } from "./runGit.js";

/**
 * One file's diff since a review point (#14587): the reviewed version against
 * the current one, for the index or the working tree.
 *
 * Only content git still holds can be the reviewed side. A working-tree
 * version the point recorded is a blob id of raw bytes that was never written
 * to the object store, so it resolves only if the same bytes were staged or
 * committed at some point. When it doesn't, the view says the reviewed version
 * is unavailable. The reviewed commit's own version of the file may ride along
 * as a stand-in, but it is never offered as the change since review.
 *
 * Reads the repository and the working tree; writes only to a temporary
 * directory outside both.
 */

const MAX_SIDE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
/** Where git itself starts looking for a NUL when it decides a file is binary. */
const BINARY_SNIFF_BYTES = 8000;

type Mode = ReviewPointGitEntry["mode"];

type End =
  | { kind: "absent" }
  | { kind: "content"; mode: Mode; oid: string; raw: boolean }
  | { kind: "unsupported" }
  | { kind: "uncovered" };

type Fetched =
  | { kind: "bytes"; bytes: Buffer | null }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "unreadable" };

export interface FileSinceReviewOptions {
  signal?: AbortSignal;
}

export function defaultSide(file: ReviewComparisonFile): ReviewFileSinceSide {
  return file.worktree !== "unchanged" ? "worktree" : "index";
}

export async function readFileSinceReview(
  cwd: string,
  point: Pick<ReviewPoint, "objectFormat" | "head">,
  file: ReviewComparisonFile,
  side: ReviewFileSinceSide,
  options: FileSinceReviewOptions = {}
): Promise<ReviewFileSinceView> {
  if (file[side] === "unchanged") return { kind: "unchanged" };

  const before = endOf(file.reviewed, side);
  const now = endOf(file.current, side);
  if (before.kind === "unsupported" || now.kind === "unsupported") return { kind: "unsupported" };
  const changed = file[side] === "changed";
  const unavailable = (
    reason: "reviewed-content-missing" | "reviewed-not-covered" | "current-unreadable",
    standIn: Extract<ReviewFileSinceView, { kind: "unavailable" }>["standIn"] = null
  ): ReviewFileSinceView => ({ kind: "unavailable", reason, changed, standIn });
  if (now.kind === "uncovered") return unavailable("current-unreadable");
  if (before.kind === "uncovered") return unavailable("reviewed-not-covered");

  const env: ReadEnv = { cwd, objectFormat: point.objectFormat, signal: options.signal, file };
  const current = await fetchEnd(env, now, "current");
  if (current.kind === "too-large") return { kind: "too-large" };
  if (current.kind !== "bytes") return unavailable("current-unreadable");

  const reviewed = await fetchEnd(env, before, "reviewed");
  if (reviewed.kind === "too-large") return { kind: "too-large" };
  if (reviewed.kind === "missing") {
    return unavailable(
      "reviewed-content-missing",
      await standInFor(env, point, file, now, current.bytes)
    );
  }
  if (reviewed.kind !== "bytes") return unavailable("reviewed-content-missing");

  return render(env, before, reviewed.bytes, now, current.bytes);
}

function endOf(side: ReviewComparisonSide, which: ReviewFileSinceSide): End {
  if (side.kind === "uncovered") return { kind: "uncovered" };
  // Outside the point's change set the path held the same entry in HEAD, the
  // index and the working tree, as git compares them.
  if (side.kind === "unlisted") return entryEnd(side.entry);
  if (which === "index") {
    const { index } = side;
    if (index.kind === "absent") return { kind: "absent" };
    if (index.kind === "entry") return entryEnd(index);
    return { kind: "unsupported" };
  }
  const { worktree } = side;
  switch (worktree.kind) {
    case "absent":
    case "directory":
      return { kind: "absent" };
    case "file":
      return { kind: "content", mode: worktree.mode, oid: worktree.oid, raw: true };
    case "symlink":
      return { kind: "content", mode: "120000", oid: worktree.oid, raw: true };
    case "submodule":
      return { kind: "unsupported" };
    case "unverifiable":
      return { kind: "uncovered" };
  }
}

function entryEnd(entry: ReviewPointGitEntry | null): End {
  if (entry === null) return { kind: "absent" };
  if (entry.mode === "160000") return { kind: "unsupported" };
  return { kind: "content", mode: entry.mode, oid: entry.oid, raw: false };
}

interface ReadEnv {
  cwd: string;
  objectFormat: ReviewPoint["objectFormat"];
  signal: AbortSignal | undefined;
  file: ReviewComparisonFile;
}

/**
 * `reviewed` content is looked up in git by its id. `current` content that the
 * comparison read from disk is read from disk again, and has to be the bytes
 * that were compared: anything else changed under the read.
 */
async function fetchEnd(
  env: ReadEnv,
  end: Extract<End, { kind: "content" | "absent" }>,
  role: "reviewed" | "current"
): Promise<Fetched> {
  if (end.kind === "absent") return { kind: "bytes", bytes: null };
  if (role === "current" && end.raw) return readFromDisk(env, end);
  return catBlob(env, end.oid);
}

async function catBlob(env: ReadEnv, oid: string): Promise<Fetched> {
  try {
    const { stdout } = await runGitForBytes(env.cwd, ["cat-file", "blob", oid], {
      signal: env.signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxStdoutBytes: MAX_SIDE_BYTES,
    });
    return { kind: "bytes", bytes: stdout };
  } catch (error) {
    if (error instanceof GitOutputLimitError) return { kind: "too-large" };
    // A blob the repository doesn't have: never stored, or collected since.
    if (error instanceof GitCommandError) return { kind: "missing" };
    if (env.signal?.aborted) throw error;
    return { kind: "unreadable" };
  }
}

async function readFromDisk(
  env: ReadEnv,
  end: Extract<End, { kind: "content" }>
): Promise<Fetched> {
  const relative = env.file.pathBytes
    ? Buffer.from(env.file.pathBytes, "base64")
    : Buffer.from(env.file.path, "utf8");
  const target = absoluteWorktreePath(env.cwd, relative);
  try {
    const stats = await lstatOrNull(target);
    if (!stats) return { kind: "unreadable" };
    let bytes: Buffer;
    if (end.mode === "120000") {
      if (!stats.isSymbolicLink()) return { kind: "unreadable" };
      bytes = await fs.promises.readlink(target, { encoding: "buffer" });
    } else {
      if (!stats.isFile()) return { kind: "unreadable" };
      if (stats.size > BigInt(MAX_SIDE_BYTES)) return { kind: "too-large" };
      const flags =
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
      const handle = await fs.promises.open(target, flags);
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close().catch(() => {});
      }
    }
    if (bytes.length > MAX_SIDE_BYTES) return { kind: "too-large" };
    return blobId(env.objectFormat, bytes) === end.oid
      ? { kind: "bytes", bytes }
      : { kind: "unreadable" };
  } catch (error) {
    if (env.signal?.aborted) throw error;
    return { kind: "unreadable" };
  }
}

async function standInFor(
  env: ReadEnv,
  point: Pick<ReviewPoint, "head">,
  file: ReviewComparisonFile,
  now: Extract<End, { kind: "content" | "absent" }>,
  current: Buffer | null
): Promise<Extract<ReviewFileSinceView, { kind: "unavailable" }>["standIn"]> {
  if (point.head.kind === "unborn" || file.reviewed.kind !== "listed") return null;
  const head = entryEnd(file.reviewed.head);
  if (head.kind !== "content") return null;
  const old = await catBlob(env, head.oid);
  if (old.kind !== "bytes") return null;
  const view = await render(env, head, old.bytes, now, current);
  // Nothing to show, as when the file went back to what the commit holds.
  if (view.kind !== "exact") return null;
  return { commit: point.head.commit, patch: view.patch };
}

async function render(
  env: ReadEnv,
  before: Extract<End, { kind: "content" | "absent" }>,
  old: Buffer | null,
  now: Extract<End, { kind: "content" | "absent" }>,
  current: Buffer | null
): Promise<ReviewFileSinceView> {
  const sameBytes =
    old !== null && current !== null ? old.equals(current) : old === null && current === null;
  const fromMode = before.kind === "content" ? before.mode : null;
  const toMode = now.kind === "content" ? now.mode : null;
  if (sameBytes && fromMode === toMode) return { kind: "unchanged" };
  if (sameBytes && fromMode !== null && toMode !== null) {
    return { kind: "mode-only", from: fromMode, to: toMode };
  }
  if (isBinary(old) || isBinary(current) || !isUtf8(old) || !isUtf8(current)) {
    return { kind: "binary" };
  }
  const patch = await gitPatch(env, fromMode, old, toMode, current);
  if (patch === "too-large") return { kind: "too-large" };
  return patch === null ? { kind: "unchanged" } : { kind: "exact", patch };
}

function isBinary(bytes: Buffer | null): boolean {
  return bytes !== null && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function isUtf8(bytes: Buffer | null): boolean {
  if (bytes === null) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unified diff of two byte strings, through git so hunks and "no newline"
 * markers are git's own. The inputs go to a directory of their own under the
 * system temp dir, never into the repository; the file headers are written
 * over the temporary names.
 */
async function gitPatch(
  env: ReadEnv,
  fromMode: Mode | null,
  old: Buffer | null,
  toMode: Mode | null,
  current: Buffer | null
): Promise<string | "too-large" | null> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daintree-since-review-"));
  try {
    const oldPath = old === null ? "/dev/null" : "old";
    const newPath = current === null ? "/dev/null" : "new";
    if (old !== null) await fs.promises.writeFile(path.join(dir, "old"), old);
    if (current !== null) await fs.promises.writeFile(path.join(dir, "new"), current);
    let stdout: Buffer;
    try {
      ({ stdout } = await runGitForBytes(
        dir,
        [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "-U3",
          "--",
          oldPath,
          newPath,
        ],
        {
          signal: env.signal,
          timeoutMs: GIT_TIMEOUT_MS,
          maxStdoutBytes: MAX_PATCH_BYTES,
          okExitCodes: [1],
        }
      ));
    } catch (error) {
      if (error instanceof GitOutputLimitError) return "too-large";
      throw error;
    }
    const text = stdout.toString("utf8");
    const hunks = text.startsWith("@@") ? 0 : text.indexOf("\n@@");
    if (hunks === -1) return null;
    const body = text.slice(hunks === 0 ? 0 : hunks + 1);
    const name = env.file.path;
    const header = [`diff --git a/${name} b/${name}`];
    if (fromMode === null && toMode !== null) header.push(`new file mode ${toMode}`);
    else if (toMode === null && fromMode !== null) header.push(`deleted file mode ${fromMode}`);
    else if (fromMode !== toMode) header.push(`old mode ${fromMode}`, `new mode ${toMode}`);
    header.push(
      fromMode === null ? "--- /dev/null" : `--- a/${name}`,
      toMode === null ? "+++ /dev/null" : `+++ b/${name}`
    );
    return `${header.join("\n")}\n${body}`;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
