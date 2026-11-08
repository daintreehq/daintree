import { execFileSync } from "node:child_process";
import { mkdirSync, promises as fsPromises, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSanitizedProcessEnv } from "../../../electron/utils/gitEnv";
import type { WorktreeChanges } from "../../../shared/types/git";
import { createPerfTempRoot } from "./tempRoots";

/**
 * Fixture, read observer and oracle for PERF-113: a worktree carrying
 * untracked binaries (1 byte, 8 KiB, 2 MiB, 9.5 MiB and a 40 MiB batch of
 * 2 MiB screenshots) beside untracked text and one tracked edit, so repeated
 * forced status passes show how many bytes untracked line counting reads on
 * first sighting and when nothing has changed.
 *
 * Built lazily, once per process, outside the shared git-pipeline fixture.
 * Setup uses execFileSync, which does not route through the ChildProcess spawn
 * hook, so none of it reaches the git spawn counters.
 */

const MiB = 1024 * 1024;
const BATCH_FILES = 20;

export interface FixtureFile {
  rel: string;
  content: Buffer;
  /** What the status pass must report: a line count, or null for binary. */
  insertions: number | null;
  binary: boolean;
  batch: boolean;
}

export interface UntrackedBinaryFixture {
  root: string;
  repoPath: string;
  /** Untracked files by canonical absolute path. */
  untracked: Map<string, FixtureFile>;
  trackedPath: string;
  /** A binary that the flip probe rewrites as text, and a text file it rewrites as binary. */
  binaryToTextPath: string;
  textToBinaryPath: string;
}

/**
 * A PNG signature and IHDR length (the NULs that make real screenshots binary
 * within the 8 KiB sniff), then a byte pattern that holds newlines and NULs,
 * so a line counter that skipped the sniff would still produce a number.
 */
function pngLike(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
  for (let i = 0; i < size; i++) {
    buf[i] = i < header.length ? header[i] : (i * 31 + seed * 17) & 0xff;
  }
  return buf;
}

/** 512 text lines filling the sniff window, then a NUL just past it: still text. */
function lateNulText(): Buffer {
  const lines = Buffer.from("0123456789abcde\n".repeat(512));
  return Buffer.concat([lines, Buffer.from([0x00, 0x0a])]);
}

function fixtureFiles(): FixtureFile[] {
  const bin = (rel: string, content: Buffer, batch = false): FixtureFile => ({
    rel,
    content,
    insertions: null,
    binary: true,
    batch,
  });
  const text = (rel: string, content: string | Buffer, insertions: number): FixtureFile => ({
    rel,
    content: Buffer.from(content),
    insertions,
    binary: false,
    batch: false,
  });
  return [
    bin("assets/one-byte.bin", Buffer.from([0x00])),
    bin("assets/sniff-8k.bin", pngLike(8 * 1024, 1)),
    bin("assets/shot-2m.png", pngLike(2 * MiB, 2)),
    bin("assets/shot-9_5m.png", pngLike(9.5 * MiB, 3)),
    ...Array.from({ length: BATCH_FILES }, (_, i) =>
      bin(`screenshots/batch-${String(i).padStart(2, "0")}.png`, pngLike(2 * MiB, 10 + i), true)
    ),
    text("notes/empty.txt", "", 0),
    text("notes/trailing.md", "a\nb\nc\n", 3),
    text("notes/no-eol.md", "a\nb", 2),
    text("notes/late-nul.log", lateNulText(), 513),
  ];
}

// One line changed and one added against the committed body.
const TRACKED_REL = "src/tracked.txt";
const TRACKED_BASE = "a\nb\nc\n";
const TRACKED_DIRTY = "a\nB\nc\nd\n";
export const TRACKED_INSERTIONS = 2;
export const TRACKED_DELETIONS = 1;

function setupGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...getSanitizedProcessEnv(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.invalid",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.invalid",
    },
  });
}

let fixture: UntrackedBinaryFixture | null = null;

export function getUntrackedBinaryFixture(): UntrackedBinaryFixture {
  if (fixture) return fixture;

  // Canonical, so the paths the status pass resolves from `git rev-parse`
  // (realpath'd on macOS) match the observer's keys.
  const root = createPerfTempRoot("daintree-perf-untracked-binary-", { canonical: true });
  const repoPath = join(root, "repo");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  setupGit(repoPath, ["init", "-b", "main"]);
  setupGit(repoPath, ["config", "commit.gpgsign", "false"]);
  setupGit(repoPath, ["config", "core.fsmonitor", "false"]);
  setupGit(repoPath, ["config", "core.autocrlf", "false"]);
  setupGit(repoPath, ["config", "diff.algorithm", "myers"]);
  // The passes run with the developer's global config, and a global ignore
  // such as `*.log` or `*.png` would hide fixture files from `git status`.
  const excludesFile = join(root, "empty-excludes");
  writeFileSync(excludesFile, "");
  setupGit(repoPath, ["config", "core.excludesFile", excludesFile]);
  const trackedPath = join(repoPath, ...TRACKED_REL.split("/"));
  writeFileSync(trackedPath, TRACKED_BASE);
  setupGit(repoPath, ["add", "-A"]);
  setupGit(repoPath, ["commit", "-q", "-m", "base tree"]);
  writeFileSync(trackedPath, TRACKED_DIRTY);

  const untracked = new Map<string, FixtureFile>();
  for (const file of fixtureFiles()) {
    const abs = join(repoPath, ...file.rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, file.content);
    untracked.set(abs, file);
  }

  fixture = {
    root,
    repoPath,
    untracked,
    trackedPath,
    binaryToTextPath: join(repoPath, "assets", "one-byte.bin"),
    textToBinaryPath: join(repoPath, "notes", "trailing.md"),
  };
  return fixture;
}

export interface UntrackedBinaryWorkload {
  binaryFileCount: number;
  binaryFixtureBytes: number;
  batchBinaryBytes: number;
  untrackedFileCount: number;
}

/** Measured from disk, so a fixture that stopped writing its payload cannot meet its floors. */
export function measureWorkload(f: UntrackedBinaryFixture): UntrackedBinaryWorkload {
  let binaryFileCount = 0;
  let binaryFixtureBytes = 0;
  let batchBinaryBytes = 0;
  for (const [abs, file] of f.untracked) {
    if (!file.binary) continue;
    const size = statSync(abs).size;
    binaryFileCount++;
    binaryFixtureBytes += size;
    if (file.batch) batchBinaryBytes += size;
  }
  return {
    binaryFileCount,
    binaryFixtureBytes,
    batchBinaryBytes,
    untrackedFileCount: f.untracked.size,
  };
}

/**
 * Rows the pass must return: every untracked file with its constructed line
 * count (or null), plus the tracked edit. Missing, extra and wrong rows all
 * count, as does a wrong `changedFileCount`.
 */
export function rowOracleMisses(f: UntrackedBinaryFixture, result: WorktreeChanges): number {
  let misses = 0;
  const seen = new Set<string>();
  for (const change of result.changes) {
    if (seen.has(change.path)) misses++;
    seen.add(change.path);
    if (change.path === f.trackedPath) {
      if (
        change.status !== "modified" ||
        change.insertions !== TRACKED_INSERTIONS ||
        change.deletions !== TRACKED_DELETIONS
      ) {
        misses++;
      }
      continue;
    }
    const file = f.untracked.get(change.path);
    if (
      !file ||
      change.status !== "untracked" ||
      change.insertions !== file.insertions ||
      change.deletions !== null
    ) {
      misses++;
    }
  }
  for (const abs of [f.trackedPath, ...f.untracked.keys()]) {
    if (!seen.has(abs)) misses++;
  }
  if (result.changedFileCount !== f.untracked.size + 1) misses++;
  return misses;
}

export interface PathReads {
  /** Handles opened on the path, plus path-based `readFile` calls. */
  acquisitions: number;
  bytes: number;
  /** Whole-file reads: `readFile` on a handle or on the path. */
  wholeReads: number;
}

export interface ReadTally {
  binaryBytes: number;
  untrackedBytes: number;
  /** Acquisitions, so one per file read however many reads it took. */
  binaryReads: number;
  untrackedReads: number;
  byPath: Map<string, PathReads>;
}

export interface ReadObserver {
  /** Counts since the last take, then resets. */
  take(): ReadTally;
  dispose(): void;
}

let activeObserver: ReadObserver | null = null;

/**
 * The line counter's binary sniff window. The fixture's `sniff-8k.bin` and
 * `late-nul.log` sit on its edge.
 */
export const BINARY_SNIFF_BYTES = 8 * 1024;

const emptyTally = (): ReadTally => ({
  binaryBytes: 0,
  untrackedBytes: 0,
  binaryReads: 0,
  untrackedReads: 0,
  byPath: new Map(),
});

type HandleRead = (...args: unknown[]) => Promise<{ bytesRead: number }>;
type HandleReadFile = (...args: unknown[]) => Promise<Buffer | string>;
type FileHandle = Awaited<ReturnType<typeof fsPromises.open>>;

const byteLength = (result: Buffer | string) =>
  typeof result === "string" ? Buffer.byteLength(result) : result.length;

/**
 * Wraps the shared `fs.promises.open` and `fs.promises.readFile`, which the
 * status utility calls through the same objects, and tallies per path what
 * reads of the fixture's untracked files returned: `read` and `readFile` on a
 * handle opened on one, and `readFile` given one's path or such a handle.
 * This is bytes handed back to the line counter, not disk I/O. The originals
 * are restored by `dispose()`.
 */
export function observeUntrackedReads(f: UntrackedBinaryFixture): ReadObserver {
  if (activeObserver) throw new Error("untracked read observer already installed");
  const originalOpen = fsPromises.open;
  const originalReadFile = fsPromises.readFile;
  const handlePaths = new WeakMap<FileHandle, string>();
  let tally = emptyTally();

  const pathReads = (abs: string): PathReads => {
    let reads = tally.byPath.get(abs);
    if (!reads) {
      reads = { acquisitions: 0, bytes: 0, wholeReads: 0 };
      tally.byPath.set(abs, reads);
    }
    return reads;
  };
  const acquired = (abs: string) => {
    pathReads(abs).acquisitions++;
    tally.untrackedReads++;
    if (f.untracked.get(abs)!.binary) tally.binaryReads++;
  };
  const returned = (abs: string, bytes: number, whole: boolean) => {
    const reads = pathReads(abs);
    reads.bytes += bytes;
    if (whole) reads.wholeReads++;
    tally.untrackedBytes += bytes;
    if (f.untracked.get(abs)!.binary) tally.binaryBytes += bytes;
  };

  const open = async function (this: unknown, ...args: Parameters<typeof originalOpen>) {
    const handle = await originalOpen.apply(this, args);
    const abs = typeof args[0] === "string" && f.untracked.has(args[0]) ? args[0] : undefined;
    if (!abs) return handle;
    acquired(abs);
    handlePaths.set(handle, abs);
    const read = handle.read.bind(handle) as HandleRead;
    const readFile = handle.readFile.bind(handle) as HandleReadFile;
    Object.assign(handle, {
      read: async (...readArgs: unknown[]) => {
        const result = await read(...readArgs);
        returned(abs, result.bytesRead, false);
        return result;
      },
      readFile: async (...readArgs: unknown[]) => {
        const result = await readFile(...readArgs);
        returned(abs, byteLength(result), true);
        return result;
      },
    });
    return handle;
  };
  const readFile = async function (this: unknown, ...args: Parameters<typeof originalReadFile>) {
    const result = (await (originalReadFile as (...a: unknown[]) => Promise<Buffer | string>).apply(
      this,
      args
    )) as Buffer | string;
    const target = args[0];
    const abs =
      typeof target === "string"
        ? f.untracked.has(target)
          ? target
          : undefined
        : handlePaths.get(target as FileHandle);
    if (abs) {
      if (typeof target === "string") acquired(abs);
      returned(abs, byteLength(result), true);
    }
    return result;
  };
  fsPromises.open = open as typeof originalOpen;
  fsPromises.readFile = readFile as typeof originalReadFile;
  const observer: ReadObserver = {
    take() {
      const out = tally;
      tally = emptyTally();
      return out;
    },
    dispose() {
      if (fsPromises.open === open) fsPromises.open = originalOpen;
      if (fsPromises.readFile === readFile) fsPromises.readFile = originalReadFile;
      activeObserver = null;
    },
  };
  activeObserver = observer;
  return observer;
}

/**
 * Binaries a first-sighting pass did not read once, and only as far as their
 * sniff: each must be acquired exactly once, never read whole, and hand back
 * exactly `min(size, BINARY_SNIFF_BYTES)` bytes. Checked per path, so one
 * binary skipped and another read twice cannot balance out, and an observer
 * that saw nothing misses every binary.
 */
export function firstSightingReadMisses(f: UntrackedBinaryFixture, tally: ReadTally): number {
  let misses = 0;
  for (const [abs, file] of f.untracked) {
    if (!file.binary) continue;
    const reads = tally.byPath.get(abs);
    const sniff = Math.min(file.content.length, BINARY_SNIFF_BYTES);
    if (!reads || reads.acquisitions !== 1 || reads.wholeReads !== 0 || reads.bytes !== sniff) {
      misses++;
    }
  }
  return misses;
}

/**
 * Rewrite the flip pair: the binary as text and the text as binary at its
 * same size, with an mtime moved explicitly so a coarse-mtime filesystem
 * still sees a new identity. Returns what the next pass must report.
 */
export function flipClassifications(f: UntrackedBinaryFixture): Map<string, number | null> {
  writeFileSync(f.binaryToTextPath, "x\n");
  const textFile = f.untracked.get(f.textToBinaryPath)!;
  writeFileSync(f.textToBinaryPath, Buffer.alloc(textFile.content.length));
  const moved = statSync(f.textToBinaryPath).mtimeMs / 1000 + 10;
  utimesSync(f.textToBinaryPath, moved, moved);
  return new Map<string, number | null>([
    [f.binaryToTextPath, 1],
    [f.textToBinaryPath, null],
  ]);
}

export function restoreClassifications(f: UntrackedBinaryFixture): void {
  for (const abs of [f.binaryToTextPath, f.textToBinaryPath]) {
    writeFileSync(abs, f.untracked.get(abs)!.content);
  }
}
