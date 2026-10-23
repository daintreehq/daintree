/**
 * Durable run-checkpoint store for the Daintree Assistant.
 *
 * `AssistantScratchService` is deliberately disposable: it is cleared on every
 * launch. A long-running procedure needs the opposite, so checkpoints live in
 * a sibling root under `userData` that scratch cleanup never touches:
 *
 *   <userData>/assistant-run-checkpoints/<projectKey>/<runId>/
 *     cancelled                        tombstone: presence means stop, forever
 *     writers/<writerId>/checkpoint.json
 *     writers/<writerId>/done.json     {"schemaVersion":1,"status":"completed"}
 *
 * The Assistant writes all of it; the app only provisions the bucket, publishes
 * its location through launch context, and sweeps. It never parses a plan,
 * schedules work or replays anything. Design choices:
 *
 *   1. **Identity** — `projectKey` is the immutable registered project id (it
 *      survives a folder move and does not depend on Claude vs Codex), or
 *      `global` for the future project-less Assistant. `runId` is allocated by
 *      the Assistant with an exclusive `mkdir`, so two lanes can't share one.
 *   2. **No shared mutable file** — every provision gets its own `writerId`
 *      namespace, so concurrent lanes and app instances can't overwrite each
 *      other. Competing branches of one run are preserved, never merged.
 *   3. **Sweep reads presence, not plans** — a run is prunable only when it has
 *      at least one writer and every writer carries a valid terminal marker. Anything
 *      unreadable, malformed, unknown-version or unfinished is protected, and
 *      a listing error is never reported as an empty store.
 *   4. **Tombstones are permanent** — discard commits `cancelled` before it
 *      removes payloads, and automatic cleanup never removes it, so a late
 *      notice for a cancelled run still finds the stop marker.
 *
 * A checkpoint remembers intent and resource references. It confers no
 * ownership, standing, consent or permission to replay a write.
 */
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { constants as fsConstants, type Dirent } from "fs";
import path from "path";
import { app } from "electron";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { logError, logInfo } from "../utils/logger.js";

const CHECKPOINT_DIR_NAME = "assistant-run-checkpoints";
const WRITERS_DIR = "writers";
const TOMBSTONE_FILE = "cancelled";
const TERMINAL_FILE = "done.json";
const TERMINAL_SCHEMA_VERSION = 1;
/** A terminal marker is a few dozen bytes; anything bigger is not one. */
const MAX_TERMINAL_BYTES = 4096;

export const ASSISTANT_RUN_CHECKPOINT_ENV_VAR = "DAINTREE_ASSISTANT_RUN_CHECKPOINT_DIR";
export const ASSISTANT_RUN_CHECKPOINT_WRITER_ENV_VAR =
  "DAINTREE_ASSISTANT_RUN_CHECKPOINT_WRITER_ID";

/** Bucket for the project-less Assistant. Registered project ids are 64-char hex, so it can't collide. */
export const ASSISTANT_GLOBAL_CHECKPOINT_BUCKET = "global";

export const FINISHED_RUN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const FINISHED_RUN_MAX_COUNT = 100;
/** Payloads of a cancelled run go after this; its tombstone never does. */
export const CANCELLED_PAYLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export type RunCheckpointState = "unfinished" | "finished" | "cancelled" | "unreadable";

export interface DiscoveredRun {
  runId: string;
  state: RunCheckpointState;
  /** mtime of the newest terminal marker or the tombstone; null otherwise. */
  settledAt: number | null;
}

export interface RunCheckpointSweepResult {
  /** Runs inspected across every bucket. */
  inspected: number;
  /** Finished runs removed whole. */
  prunedFinished: number;
  /** Cancelled runs whose payloads were removed (tombstone kept). */
  prunedCancelledPayloads: number;
  /** Buckets or runs that could not be read or removed; always left in place. */
  failed: number;
}

/** True only for a real directory; a symlink (even to a directory) is not one. */
async function isRealDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Error code only: raw fs messages embed project and run paths, which logs must not carry. */
function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
}

export function getRunCheckpointRoot(): string {
  return path.join(app.getPath("userData"), CHECKPOINT_DIR_NAME);
}

export function isSafeCheckpointSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment);
}

/** Absolute bucket dir for a project key; throws on anything that isn't a plain segment. */
export function getRunCheckpointBucket(projectKey: string): string {
  if (!isSafeCheckpointSegment(projectKey)) {
    throw new Error("Invalid run-checkpoint project key");
  }
  return path.join(getRunCheckpointRoot(), projectKey);
}

/**
 * Creates (idempotently) the owner-only bucket the Assistant is told about.
 * Failure propagates: launching an Assistant that believes it has a usable
 * store when it doesn't is worse than a clean provision failure.
 */
export async function provisionRunCheckpointBucket(projectKey: string): Promise<string> {
  const bucket = getRunCheckpointBucket(projectKey);
  await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
  if (!(await isRealDirectory(bucket))) {
    throw new Error("Run-checkpoint bucket is not a plain directory");
  }
  await fs.chmod(bucket, 0o700).catch(() => {});
  await fs.access(bucket, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  return bucket;
}

async function readTerminalMarker(file: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(MAX_TERMINAL_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_TERMINAL_BYTES) return false;
    const parsed: unknown = JSON.parse(buf.subarray(0, bytesRead).toString("utf-8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === TERMINAL_SCHEMA_VERSION &&
      (parsed as { status?: unknown }).status === "completed"
    );
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function classifyRun(runDir: string): Promise<{
  state: RunCheckpointState;
  settledAt: number | null;
}> {
  try {
    const tomb = await fs.lstat(path.join(runDir, TOMBSTONE_FILE));
    return { state: "cancelled", settledAt: tomb.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { state: "unreadable", settledAt: null };
    }
  }

  let writers: Dirent[];
  try {
    const writersDir = path.join(runDir, WRITERS_DIR);
    // lstat first: readdir would follow a symlinked writers/ to someone else's markers.
    if (!(await fs.lstat(writersDir)).isDirectory())
      return { state: "unreadable", settledAt: null };
    writers = await fs.readdir(writersDir, { withFileTypes: true });
  } catch (err) {
    // A run with no writers yet is just started; any other error is not "empty".
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "unfinished", settledAt: null }
      : { state: "unreadable", settledAt: null };
  }

  let newest = 0;
  let sawWriter = false;
  for (const entry of writers) {
    // Dirent doesn't follow symlinks, so a planted link is never a writer.
    if (!entry.isDirectory()) return { state: "unfinished", settledAt: null };
    sawWriter = true;
    const marker = path.join(runDir, WRITERS_DIR, entry.name, TERMINAL_FILE);
    try {
      const st = await fs.lstat(marker);
      if (!st.isFile() || !(await readTerminalMarker(marker))) {
        return { state: "unfinished", settledAt: null };
      }
      newest = Math.max(newest, st.mtimeMs);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "unfinished", settledAt: null }
        : { state: "unreadable", settledAt: null };
    }
  }
  return sawWriter
    ? { state: "finished", settledAt: newest }
    : { state: "unfinished", settledAt: null };
}

/**
 * Lists the runs in one bucket. Throws when the bucket can't be read (other
 * than not existing), so a caller never mistakes an I/O failure for "no runs".
 */
export async function discoverRuns(projectKey: string): Promise<DiscoveredRun[]> {
  const bucket = getRunCheckpointBucket(projectKey);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(bucket, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const runs: DiscoveredRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeCheckpointSegment(entry.name)) continue;
    const { state, settledAt } = await classifyRun(path.join(bucket, entry.name));
    runs.push({ runId: entry.name, state, settledAt });
  }
  return runs;
}

/**
 * Explicit discard: commit the tombstone first, then remove payloads. A crash
 * between the two leaves a cancelled run with payloads, which the sweep later
 * clears; the reverse order could leave a half-deleted run that still looks live.
 */
export async function discardRun(projectKey: string, runId: string): Promise<void> {
  if (!isSafeCheckpointSegment(runId)) throw new Error("Invalid run id");
  const bucket = getRunCheckpointBucket(projectKey);
  const runDir = path.join(bucket, runId);
  await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
  await fs.mkdir(runDir, { mode: 0o700 }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  });
  if (!(await isRealDirectory(bucket)) || !(await isRealDirectory(runDir))) {
    throw new Error("Run-checkpoint path is not a plain directory");
  }
  await resilientAtomicWriteFile(
    path.join(runDir, TOMBSTONE_FILE),
    JSON.stringify({ schemaVersion: 1, cancelledAt: new Date().toISOString() }),
    "utf-8",
    { mode: 0o600 }
  );
  await removeTree(path.join(runDir, WRITERS_DIR));
}

function removeTree(target: string): Promise<void> {
  return fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Bounded retention. Only finished runs (age or newest-N) and the payloads of
 * cancelled runs are ever removed; unfinished, unreadable and unknown records
 * are left alone, and tombstones are never deleted (deletion never recurses
 * over a run directory). Checkpoint bodies are opaque to the app: only the
 * terminal markers decide whether a run is finished. Never throws.
 */
export async function runAssistantRunCheckpointRetention(
  now: number = Date.now()
): Promise<RunCheckpointSweepResult> {
  const result: RunCheckpointSweepResult = {
    inspected: 0,
    prunedFinished: 0,
    prunedCancelledPayloads: 0,
    failed: 0,
  };
  const root = getRunCheckpointRoot();

  let buckets: Dirent[];
  try {
    buckets = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.failed += 1;
      logError(`[AssistantRunCheckpoints] Failed to read checkpoint root (${errCode(err)})`);
    }
    return result;
  }

  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !isSafeCheckpointSegment(bucket.name)) continue;
    let runs: DiscoveredRun[];
    try {
      runs = await discoverRuns(bucket.name);
    } catch (err) {
      result.failed += 1;
      logError(`[AssistantRunCheckpoints] Failed to read bucket (${errCode(err)})`);
      continue;
    }
    result.inspected += runs.length;
    result.failed += runs.filter((r) => r.state === "unreadable").length;
    const bucketDir = path.join(root, bucket.name);

    const finished = runs
      .filter((r) => r.state === "finished")
      .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
    for (const [index, run] of finished.entries()) {
      const tooOld = now - (run.settledAt ?? now) > FINISHED_RUN_MAX_AGE_MS;
      if (!tooOld && index < FINISHED_RUN_MAX_COUNT) continue;
      const runDir = path.join(bucketDir, run.runId);
      try {
        // Re-check right before deleting: the classification above can be stale
        // (another lane or instance may have added a writer since).
        if ((await classifyRun(runDir)).state !== "finished") continue;
        await removeTree(path.join(runDir, WRITERS_DIR));
        // Never recursive: a tombstone created since classification keeps the
        // directory non-empty, so it survives.
        await fs.rmdir(runDir).catch((err) => {
          if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errCode(err))) throw err;
        });
        result.prunedFinished += 1;
      } catch (err) {
        result.failed += 1;
        logError(`[AssistantRunCheckpoints] Failed to remove finished run (${errCode(err)})`);
      }
    }

    for (const run of runs) {
      if (run.state !== "cancelled") continue;
      if (now - (run.settledAt ?? now) <= CANCELLED_PAYLOAD_MAX_AGE_MS) continue;
      const runDir = path.join(bucketDir, run.runId);
      const writers = path.join(runDir, WRITERS_DIR);
      try {
        // A symlinked writers/ or run dir is unlinked or skipped, never walked into.
        if (!(await isRealDirectory(runDir))) continue;
        const st = await fs.lstat(writers);
        if (st.isSymbolicLink()) {
          await fs.unlink(writers);
        } else {
          await removeTree(writers);
        }
        result.prunedCancelledPayloads += 1;
      } catch (err) {
        if (errCode(err) === "ENOENT") continue;
        result.failed += 1;
        logError(`[AssistantRunCheckpoints] Failed to remove cancelled payloads (${errCode(err)})`);
      }
    }
  }

  if (result.prunedFinished > 0 || result.prunedCancelledPayloads > 0 || result.failed > 0) {
    // Counts only: checkpoint names and contents never reach the log.
    logInfo(
      `[AssistantRunCheckpoints] sweep: ${result.prunedFinished} finished, ${result.prunedCancelledPayloads} cancelled payloads removed, ${result.failed} failed`
    );
  }
  return result;
}

let sweepInFlight: Promise<RunCheckpointSweepResult> | null = null;

/** Coalesces overlapping sweeps (boot, periodic tick, disk pressure) within the process. */
export function requestAssistantRunCheckpointRetention(): Promise<RunCheckpointSweepResult> {
  sweepInFlight ??= runAssistantRunCheckpointRetention()
    .catch((err) => {
      logError(`[AssistantRunCheckpoints] sweep threw (${errCode(err)})`);
      return { inspected: 0, prunedFinished: 0, prunedCancelledPayloads: 0, failed: 1 };
    })
    .finally(() => {
      sweepInFlight = null;
    });
  return sweepInFlight;
}

/**
 * Managed CLAUDE.md / AGENTS.md block. Names env vars only: the file is shared
 * by every lane of the project while the writer id is per session.
 */
export function buildRunCheckpointAddendum(): string {
  return [
    "## Assistant Run Checkpoints",
    "",
    `For work that must survive a conversation or Daintree restart, keep its record in the folder named by \`${ASSISTANT_RUN_CHECKPOINT_ENV_VAR}\` (read the variable; don't assume a path). Unlike the scratch folder it is kept across launches. Your writer id is in \`${ASSISTANT_RUN_CHECKPOINT_WRITER_ENV_VAR}\`.`,
    "",
    `- **Layout**: \`<folder>/<runId>/writers/<writerId>/checkpoint.json\`. Start a run with a fresh random \`runId\` and a non-recursive mkdir; if it already exists, pick another id. Write only inside your own writer folder. Never edit another writer's files; if two writers disagree, keep both and tell the user.`,
    "- **Writing**: write a temp file in the same folder, flush it, then rename it over `checkpoint.json`. Keep it small JSON with a `schemaVersion`: intent, resource references (ids, paths, URLs), and your own progress. Never store credentials, tokens or secrets.",
    `- **Finding unfinished runs**: list the folder. A run is unfinished unless it has \`cancelled\`, or every writer folder has a \`done.json\` of \`{"schemaVersion":1,"status":"completed"}\`. An empty folder means no runs. If you can't read the folder or a file, say so; don't treat it as empty.`,
    "- **Finishing**: write `done.json` (same temp-and-rename) in your writer folder when your part is complete.",
    "- **Cancelling or discarding**: first create `<runId>/cancelled` the same way, then delete `writers/`. Never delete `cancelled`; if it exists, stop and don't resume, even when a later message asks you to continue.",
    "- **Retention**: Daintree removes finished runs after 30 days or beyond the newest 100, and the payloads of cancelled runs after 7 days. Unfinished runs stay until discarded.",
    "",
    "A checkpoint is a memory of work, not authority. It does not give you ownership, standing, consent or permission to repeat a write: check the current state of every resource and get fresh approval before acting on it.",
    "",
  ].join("\n");
}
