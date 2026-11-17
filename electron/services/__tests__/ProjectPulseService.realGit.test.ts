import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectPulseService } from "../ProjectPulseService.js";

// Real git through the production helper: the unit suite stubs rev-list, so it
// cannot show what git prints for a repository with two reachable roots (#17509).

const NOW = new Date("2025-01-15T12:00:00.000Z");
const OLD_ROOT = "2025-01-01T12:00:00Z";
const NEW_ROOT = "2025-01-10T12:00:00Z";
const MERGE = "2025-01-12T12:00:00Z";

let root: string;
let home: string;

function git(cwd: string, date: string | null, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function commitRoot(repo: string, branch: string, file: string, date: string): void {
  git(repo, null, "checkout", "-q", "--orphan", branch);
  // An orphan checkout keeps the previous branch's index, which would put its files in this root.
  git(repo, null, "rm", "-rfq", "--ignore-unmatch", ".");
  fs.writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, null, "add", file);
  git(repo, date, "commit", "-q", "-m", `root ${file}`);
}

// Two unrelated roots joined by a merge: the first parent is the root dated firstParentDate.
function buildMergedRepo(firstParentDate: string, mergedDate: string): string {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, null, "init", "-q", "-b", "main");
  commitRoot(repo, "side", "side.txt", mergedDate);
  commitRoot(repo, "main", "main.txt", firstParentDate);
  git(repo, MERGE, "merge", "-q", "--allow-unrelated-histories", "--no-ff", "-m", "merge", "side");
  return repo;
}

function localDay(date: string): string {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pulseOf(worktreePath: string) {
  return new ProjectPulseService().getPulse({
    worktreePath,
    worktreeId: "wt-real",
    mainBranch: "main",
    rangeDays: 60 as const,
    includeDelta: false,
    includeRecentCommits: false,
  });
}

beforeEach(() => {
  // Only Date is faked: simple-git and child_process need real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-pulse-roots-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Project Pulse age across unrelated histories (#17509)", () => {
  it.each([
    { name: "older root first parent", firstParentDate: OLD_ROOT, mergedDate: NEW_ROOT },
    { name: "newer root first parent", firstParentDate: NEW_ROOT, mergedDate: OLD_ROOT },
  ])("uses the earliest root when the $name", async ({ firstParentDate, mergedDate }) => {
    const repo = buildMergedRepo(firstParentDate, mergedDate);

    const roots = git(repo, null, "rev-list", "--max-parents=0", "HEAD").trim().split("\n");
    expect(roots).toHaveLength(2);

    const pulse = await pulseOf(repo);

    // 14 days back from 2025-01-15, plus the inclusive first day.
    expect(pulse.projectAgeDays).toBe(15);
    const oldRootCell = pulse.heatmap.find((cell) => cell.date === localDay(OLD_ROOT));
    expect(oldRootCell?.isBeforeProject).toBeFalsy();
    expect(oldRootCell?.count).toBe(1);
    const dayBefore = new Date(OLD_ROOT);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const beforeCell = pulse.heatmap.find(
      (cell) => cell.date === localDay(dayBefore.toISOString())
    );
    expect(beforeCell?.isBeforeProject).toBe(true);
  });

  it("still skips age culling for a shallow clone of the merged repository", async () => {
    const repo = buildMergedRepo(OLD_ROOT, NEW_ROOT);

    // --no-local forces the transport that honours --depth, and a plain path avoids
    // percent-decoding or drive-letter surprises a file:// URL brings on Windows.
    const clone = path.join(root, "clone");
    git(root, null, "clone", "-q", "--no-local", "--depth", "1", repo, clone);
    expect(git(clone, null, "rev-parse", "--is-shallow-repository").trim()).toBe("true");

    const pulse = await pulseOf(clone);

    expect(pulse.projectAgeDays).toBe(60);
    expect(pulse.heatmap.every((cell) => !cell.isBeforeProject)).toBe(true);
  });
});
