import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorktreeChangesWithStats, invalidateWorktreeCache } from "../git.js";
import {
  formatWorktreeDeletePreviewLines,
  summarizeWorktreeChanges,
} from "../../../shared/utils/worktreeDeletePreview.js";

// Real git through the production helper: the unit suite mocks simple-git, so
// it cannot show what `git status -u` actually reports for a new directory of
// untracked files, which is the shape that crosses the enrichment cap (#15559).

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      LC_ALL: "C",
    },
    stdio: "ignore",
  });
}

beforeEach(() => {
  // The Windows temp directory can use an 8.3 alias that git expands.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-untracked-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(root, "home"));
  fs.mkdirSync(repo);
  // The helper spawns git with the process environment; keep the machine's
  // global and system excludes away from the fixture.
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "home"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init");
});

afterEach(() => {
  invalidateWorktreeCache(repo);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("untracked totals from a real repository (#15559)", () => {
  it("reports all 205 files in a new untracked directory beside a tracked change", async () => {
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\nedited\n");
    fs.mkdirSync(path.join(repo, "gen"));
    for (let i = 0; i < 205; i++) {
      fs.writeFileSync(path.join(repo, "gen", `f${String(i).padStart(3, "0")}.dat`), `${i}\n`);
    }

    const result = await getWorktreeChangesWithStats(repo, { forceRefresh: true });

    const listedUntracked = result.changes.filter((c) => c.status === "untracked").length;
    expect(listedUntracked + (result.omittedUntrackedCount ?? 0)).toBe(205);
    expect(result.changedFileCount).toBe(206);

    const summary = summarizeWorktreeChanges(result.changes, result.omittedUntrackedCount);
    const lines = formatWorktreeDeletePreviewLines({
      ...summary,
      changes: result.changes,
      rootPath: result.rootPath,
      omittedUntrackedCount: result.omittedUntrackedCount,
      submodules: { status: "unverified", risk: null },
    });
    expect(lines[0]).toBe("1 uncommitted tracked file and 205 untracked files:");
  });
});

describe("untracked line counts through a real file handle (#16423)", () => {
  it("sniffs binaries and counts text from the whole file", async () => {
    const sniff = 8192;
    const files: Record<string, { content: Buffer; insertions: number | null }> = {
      // Past the sniff, so the whole-file read must start at byte 0 after it.
      "long.txt": { content: Buffer.from("line\n".repeat(5000)), insertions: 5000 },
      "late-nul.log": {
        content: Buffer.concat([Buffer.from("x\n".repeat(sniff / 2)), Buffer.from([0, 0x0a])]),
        insertions: sniff / 2 + 1,
      },
      "short.md": { content: Buffer.from("a\nb"), insertions: 2 },
      "empty.txt": { content: Buffer.alloc(0), insertions: 0 },
      "bundle.wasm": {
        content: Buffer.concat([
          Buffer.from([0, 0x61, 0x73, 0x6d]),
          Buffer.alloc(2 * 1024 * 1024, 1),
        ]),
        insertions: null,
      },
    };
    for (const [name, { content }] of Object.entries(files)) {
      fs.writeFileSync(path.join(repo, name), content);
    }

    const result = await getWorktreeChangesWithStats(repo, { forceRefresh: true });

    const counted = Object.fromEntries(
      result.changes
        .filter((c) => c.status === "untracked")
        .map((c) => [path.basename(c.path), c.insertions])
    );
    expect(counted).toEqual(
      Object.fromEntries(Object.entries(files).map(([name, f]) => [name, f.insertions]))
    );
  });
});
