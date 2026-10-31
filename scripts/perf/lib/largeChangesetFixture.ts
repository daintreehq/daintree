import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { WorktreeChanges } from "../../../shared/types/git";
import type { CapturedGitSpawn } from "./gitPipelineFixture";
import { createPerfTempRoot } from "./tempRoots";

/**
 * Fixture + oracles for the large-changeset diff-stat scenarios (PERF-108/109):
 * worktrees carrying a standing set of thousands of modified tracked files, so
 * repeated forced status passes show whether per-file `--numstat` results are
 * still being reused once the changeset is large.
 *
 * Built lazily and per shape, never as part of the shared git-pipeline
 * fixture: each scenario runs in its own process, and the 50-worktree fixture
 * would otherwise check thousands of extra files out for nothing. Setup uses
 * execFileSync, which does not route through the ChildProcess spawn hook, so
 * none of it reaches the git spawn counters.
 */

export interface LargeChangesetShape {
  trackedFiles: number;
  /** Linked worktrees, each modifying the first `dirtyPerWorktree` files. */
  worktrees: number;
  dirtyPerWorktree: number;
}

export interface LargeChangesetFixture {
  root: string;
  repoPath: string;
  worktreePaths: string[];
  /** Repo-relative, `/`-separated paths dirty in every worktree. */
  dirtyFiles: string[];
}

const FILES_PER_DIR = 50;
const BASE_LINES = 150;
const BASE_VARIANTS = 8;

const fixtures = new Map<string, LargeChangesetFixture>();

function setupGit(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.invalid",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.invalid",
    },
  });
}

function relPathFor(index: number): string {
  const dir = String(Math.floor(index / FILES_PER_DIR)).padStart(3, "0");
  return `src/module-${dir}/file-${String(index).padStart(5, "0")}.ts`;
}

function baseLines(variant: number): string[] {
  const lines: string[] = [];
  for (let line = 0; line < BASE_LINES; line++) {
    lines.push(`export const v${variant}_${line} = ${line * (variant + 1)};`);
  }
  return lines;
}

/**
 * A deterministic edit of the base content whose numstat varies by index:
 * leading deletions, one rewritten line and trailing insertions, so the
 * oracle compares real, differing counts rather than one repeated pair.
 */
function dirtyBody(index: number, base: readonly string[]): string {
  const lines = base.slice(index % 4);
  const rewrite = 10 + (index % 7);
  lines[rewrite] = `export const rewritten_${index} = ${index};`;
  for (let extra = 0; extra <= index % 5; extra++) {
    lines.push(`export const added_${index}_${extra} = ${extra};`);
  }
  return `${lines.join("\n")}\n`;
}

export function getLargeChangesetFixture(shape: LargeChangesetShape): LargeChangesetFixture {
  const key = `${shape.trackedFiles}:${shape.worktrees}:${shape.dirtyPerWorktree}`;
  const existing = fixtures.get(key);
  if (existing) return existing;

  const root = createPerfTempRoot("daintree-perf-large-changeset-");
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  setupGit(repoPath, ["init", "-b", "main"]);
  setupGit(repoPath, ["config", "commit.gpgsign", "false"]);
  setupGit(repoPath, ["config", "core.fsmonitor", "false"]);
  setupGit(repoPath, ["config", "core.autocrlf", "false"]);
  // Local config outranks the developer's global one for both the product's
  // passes and the oracle, so their counts come from the same algorithm.
  setupGit(repoPath, ["config", "diff.algorithm", "myers"]);

  const variants = Array.from({ length: BASE_VARIANTS }, (_, v) => baseLines(v));
  const baseBodies = variants.map((lines) => `${lines.join("\n")}\n`);
  const allFiles: string[] = [];
  for (let i = 0; i < shape.trackedFiles; i++) {
    const rel = relPathFor(i);
    allFiles.push(rel);
    const abs = join(repoPath, ...rel.split("/"));
    if (i % FILES_PER_DIR === 0) mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, baseBodies[i % BASE_VARIANTS]);
  }
  setupGit(repoPath, ["add", "-A"]);
  setupGit(repoPath, ["commit", "-q", "-m", "base tree"]);

  const worktreePaths: string[] = [];
  if (shape.worktrees === 0) {
    worktreePaths.push(repoPath);
  } else {
    for (let w = 0; w < shape.worktrees; w++) {
      const wtPath = join(root, `wt-${w}`);
      setupGit(repoPath, ["worktree", "add", "-q", wtPath, "-b", `large-${w}`, "main"]);
      worktreePaths.push(wtPath);
    }
  }

  const dirtyFiles = allFiles.slice(0, shape.dirtyPerWorktree);
  for (const wtPath of worktreePaths) {
    dirtyFiles.forEach((rel, i) => {
      writeFileSync(join(wtPath, ...rel.split("/")), dirtyBody(i, variants[i % BASE_VARIANTS]));
    });
  }

  const fixture: LargeChangesetFixture = { root, repoPath, worktreePaths, dirtyFiles };
  fixtures.set(key, fixture);
  return fixture;
}

/** Append one line to a dirty file so its next numstat must change. */
export function editDirtyFile(worktreePath: string, rel: string, marker: number): void {
  appendFileSync(join(worktreePath, ...rel.split("/")), `export const edited_${marker} = 1;\n`);
}

export interface NumstatCounts {
  insertions: number | null;
  deletions: number | null;
}

/**
 * A fresh, uncached `git diff --numstat` for the worktree (or just `paths`),
 * parsed independently of the product's parser. Runs through execFileSync so
 * it never lands in a spawn tally, and with the developer's own environment,
 * as the product's spawns are.
 */
export function oracleNumstat(worktreePath: string, paths?: string[]): Map<string, NumstatCounts> {
  const args = ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", "HEAD"];
  if (paths) args.push("--", ...paths);
  const out = execFileSync("git", args, {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const counts = new Map<string, NumstatCounts>();
  for (const record of out.split("\0")) {
    if (!record) continue;
    const [ins, del, ...rest] = record.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    counts.set(path, {
      insertions: ins === "-" ? null : Number(ins),
      deletions: del === "-" ? null : Number(del),
    });
  }
  return counts;
}

/** Repo-relative, `/`-separated counts from a pass's result. */
export function resultCounts(changes: WorktreeChanges): Map<string, NumstatCounts> {
  const counts = new Map<string, NumstatCounts>();
  for (const change of changes.changes) {
    const rel = relative(changes.rootPath, change.path).split(sep).join("/");
    counts.set(rel, { insertions: change.insertions, deletions: change.deletions });
  }
  return counts;
}

/**
 * Paths missing from either side plus paths whose counts disagree. 0 means
 * the pass returned exactly what a fresh numstat says, however much of it
 * came from cache.
 */
export function oracleMisses(
  expected: Map<string, NumstatCounts>,
  actual: Map<string, NumstatCounts>
): number {
  let misses = 0;
  for (const [path, want] of expected) {
    const got = actual.get(path);
    if (!got || got.insertions !== want.insertions || got.deletions !== want.deletions) {
      misses++;
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) misses++;
  }
  return misses;
}

// Replays each start with its recorded argv, cwd and environment and reports
// RUSAGE_CHILDREN across them: only waited-for children are counted, so the
// interpreter's own startup is excluded.
const REPLAY_SCRIPT = `
import json, resource, subprocess, sys
spawns = json.load(sys.stdin)
before = resource.getrusage(resource.RUSAGE_CHILDREN)
for s in spawns:
    env = None
    if s.get("envPairs") is not None:
        env = dict(p.split("=", 1) for p in s["envPairs"] if "=" in p)
    subprocess.run(s["args"], executable=s["file"], cwd=s.get("cwd"), env=env,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
after = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({"userMs": (after.ru_utime - before.ru_utime) * 1000,
                  "systemMs": (after.ru_stime - before.ru_stime) * 1000}))
`;

let replaySupported: boolean | null = null;

function canReplay(): boolean {
  if (replaySupported !== null) return replaySupported;
  if (process.platform === "win32") return (replaySupported = false);
  try {
    execFileSync("python3", ["-c", "import resource"], { stdio: "ignore" });
    replaySupported = true;
  } catch {
    replaySupported = false;
  }
  return replaySupported;
}

/**
 * CPU of replaying the given git starts, or null where it cannot be measured
 * (Windows, or no python3). Node exposes no RUSAGE_CHILDREN and libuv reaps
 * children without their rusage, so the original children's CPU is not
 * observable in-process; a replay of the identical commands against the
 * unchanged tree is the closest honest reading.
 */
export function replayGitCpu(spawns: CapturedGitSpawn[]): { userMs: number; systemMs: number } | null {
  if (spawns.length === 0) return { userMs: 0, systemMs: 0 };
  if (!canReplay()) return null;
  const out = execFileSync("python3", ["-c", REPLAY_SCRIPT], {
    input: JSON.stringify(spawns),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(out.trim()) as { userMs: number; systemMs: number };
  return parsed;
}
