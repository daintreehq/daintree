import { spawn } from "node:child_process";
import type { OnlineOnlyFilesSide } from "../../shared/types/onlineOnlyFiles.js";

// Absolute so a Homebrew GNU find on PATH, which has no -flags, is never picked up.
const FIND_PATH = "/usr/bin/find";
// Background priority throttles the walk's disk I/O behind everything else on the machine.
const TASKPOLICY_PATH = "/usr/sbin/taskpolicy";

const NUL = 0x00;
const NEWLINE = 0x0a;

export type OnlineOnlyScanSide = "git" | "workingTree";

/**
 * What sits at the top of a project, learned before anything looks inside it.
 * Only `git-directory` means a walk of `.git` can say all there is to say.
 */
export type OnlineOnlyRootShape =
  | "root-online-only"
  | "git-directory"
  | "git-pointer"
  | "no-git"
  | "unknown";

export interface OnlineOnlyPass<T> {
  /** Settles by the budget even if find never exits, so a stuck child can't hold up other projects. */
  result: Promise<T>;
  /** Settles when the child is really gone. Hold the next pass on this so stuck finds can't pile up. */
  exited: Promise<void>;
  cancel(): void;
}

export interface OnlineOnlyScanOptions {
  budgetMs: number;
  /** Tests substitute a flag an owner can set: nothing outside a File Provider can set dataless. */
  flag?: string;
}

interface FindOutcome {
  /** Exited 0 inside the budget. */
  clean: boolean;
}

/**
 * Enumerating a dataless directory downloads its listing, and so does resolving
 * a path through one. Testing the flag and pruning before fts opens a directory
 * means a walk only ever enters directories that are already local, and lstat
 * is all it does to a file, so no contents are read.
 *
 * Directories end with a newline and everything else with NUL, the only way BSD
 * find can tell them apart on one stream. A newline inside a name reads as one
 * extra directory, which beats keeping every path to parse it.
 */
function flaggedEntryClause(flag: string): string[] {
  return ["-flags", `+${flag}`, "(", "-type", "d", "-print", "-prune", "-o", "-print0", ")"];
}

/**
 * Probes `root` itself before `root/.git` is ever named, because looking that
 * path up would download the listing of a dataless root.
 */
export function buildOnlineOnlyProbeArgs(root: string, flag = "dataless"): string[] {
  return ["-H", "-x", root]
    .concat(["-depth", "0", "-flags", `+${flag}`, "-print0", "-prune", "-o"])
    .concat(["-depth", "1", "-name", ".git", "(", "-type", "d", "-print", "-o", "-print0", ")"])
    .concat(["-prune", "-o", "-depth", "1", "-prune"]);
}

export function buildOnlineOnlyFindArgs(
  root: string,
  side: OnlineOnlyScanSide,
  flag = "dataless"
): string[] {
  return side === "git"
    ? ["-H", "-x", `${root}/.git`, ...flaggedEntryClause(flag)]
    : ["-H", "-x", root, "-depth", "1", "-name", ".git", "-prune", "-o"].concat(
        flaggedEntryClause(flag)
      );
}

/**
 * Spawned through `taskpolicy`, which execs in place, so the pid being killed
 * is find's. A child process is what makes this cancellable at all: a libuv
 * threadpool request can't be taken back once a worker has started it.
 */
function runFind<T>(
  args: string[],
  budgetMs: number,
  onChunk: (chunk: Buffer) => void,
  finish: (outcome: FindOutcome) => T
): OnlineOnlyPass<T> {
  let settled = false;
  let resolveResult!: (value: T) => void;
  let resolveExited!: () => void;
  const result = new Promise<T>((resolve) => (resolveResult = resolve));
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (clean: boolean) => {
    if (settled) return;
    settled = true;
    if (budgetTimer !== null) clearTimeout(budgetTimer);
    resolveResult(finish({ clean }));
  };

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(TASKPOLICY_PATH, ["-b", FIND_PATH, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    settle(false);
    resolveExited();
    return { result, exited, cancel: () => {} };
  }

  const stop = () => {
    settle(false);
    child.stdout?.destroy();
    child.kill("SIGKILL");
  };

  budgetTimer = setTimeout(stop, budgetMs);
  budgetTimer.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    if (!settled) onChunk(chunk);
  });
  child.stdout?.on("error", () => {});
  child.once("error", () => {
    settle(false);
    resolveExited();
  });
  // A non-zero exit is an unreadable directory, a missing root, or a find that
  // rejects the flag name. None of those may ever read as "nothing online-only".
  child.once("close", (code) => {
    settle(code === 0);
    resolveExited();
  });

  return { result, exited, cancel: stop };
}

function countByte(chunk: Buffer, byte: number): number {
  let total = 0;
  for (let at = chunk.indexOf(byte); at !== -1; at = chunk.indexOf(byte, at + 1)) total++;
  return total;
}

/** Paths are counted off the pipe and never kept, so a huge tree costs no memory here. */
export function startOnlineOnlyScan(
  root: string,
  side: OnlineOnlyScanSide,
  options: OnlineOnlyScanOptions
): OnlineOnlyPass<OnlineOnlyFilesSide> {
  let files = 0;
  let directories = 0;
  return runFind(
    buildOnlineOnlyFindArgs(root, side, options.flag),
    options.budgetMs,
    (chunk) => {
      files += countByte(chunk, NUL);
      directories += countByte(chunk, NEWLINE);
    },
    ({ clean }) => ({ files, directories, complete: clean })
  );
}

export function startOnlineOnlyProbe(
  root: string,
  options: OnlineOnlyScanOptions
): OnlineOnlyPass<OnlineOnlyRootShape> {
  const chunks: Buffer[] = [];
  return runFind(
    buildOnlineOnlyProbeArgs(root, options.flag),
    options.budgetMs,
    (chunk) => chunks.push(chunk),
    ({ clean }) => {
      if (!clean) return "unknown";
      const printed = Buffer.concat(chunks).toString("utf8");
      if (printed === "") return "no-git";
      if (printed === `${root}\0`) return "root-online-only";
      if (printed === `${root}/.git\n`) return "git-directory";
      if (printed === `${root}/.git\0`) return "git-pointer";
      return "unknown";
    }
  );
}
