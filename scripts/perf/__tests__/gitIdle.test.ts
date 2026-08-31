import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  allSpawnMark,
  allSpawnsSince,
  gitSpawnMark,
  gitSpawnsSince,
  installGitSpawnCounter,
  nonGitSpawnCount,
} from "../lib/gitPipelineFixture";

/**
 * The executable-bucketed counter behind PERF-105/106 is ADDITIVE: roughly
 * thirty existing call sites read `gitSpawnsSince(...).count` as "git spawns",
 * several of them feeding referenced metrics, so widening that filter to see
 * `cmd.exe` would silently change what those numbers mean. These tests pin the
 * two halves apart.
 */

function runToExit(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

describe("perf spawn counters", () => {
  it("buckets non-git executables without changing the git-only count", async () => {
    installGitSpawnCounter();

    const gitMark = gitSpawnMark();
    const allMark = allSpawnMark();
    await runToExit("git", ["rev-parse", "--git-dir"]);
    await runToExit(process.execPath, ["-e", ""]);

    const git = gitSpawnsSince(gitMark);
    const all = allSpawnsSince(allMark);

    expect(git.count).toBe(1);
    expect(git.bySubcommand["rev-parse"]).toBe(1);
    // The node process is invisible to the git window and visible to the
    // process window — the whole point of keeping two logs.
    expect(all.count).toBe(git.count + 1);
    expect(all.byExecutable["git"]).toBe(1);
    expect(nonGitSpawnCount(all)).toBe(1);
  });

  it("reports an empty window when nothing spawned", () => {
    installGitSpawnCounter();

    const all = allSpawnsSince(allSpawnMark());

    expect(all.count).toBe(0);
    expect(all.lastAtMs).toBeNull();
    expect(nonGitSpawnCount(all)).toBe(0);
  });
});
