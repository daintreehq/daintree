import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../WorkspaceService.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";

vi.mock("../../utils/parcelWatcherBackend.js", () => ({
  subscribeParcelWatcher: vi.fn(() => Promise.resolve({ unsubscribe: vi.fn() })),
}));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

type AllStates = Extract<WorkspaceHostEvent, { type: "all-states" }>;

/**
 * The host-side half of #14178: what a workspace host enumerates for a folder
 * that gains a repository after it loaded. The pool half — replacing that host
 * once init completes — is covered by `WorkspaceClient.gitInit.test.ts`.
 */
describe("WorkspaceService enumeration across git init (#14178)", () => {
  let root: string;
  const services: WorkspaceService[] = [];

  async function loadedService(): Promise<{
    service: WorkspaceService;
    states: () => AllStates;
  }> {
    const events: WorkspaceHostEvent[] = [];
    const { WorkspaceService } = await import("../WorkspaceService.js");
    const service = new WorkspaceService((event) => {
      events.push(event);
    });
    services.push(service);
    await service.loadProject("load", root, "project-id", {}, {});
    const loaded = events.find((e) => e.type === "load-project-result");
    expect(loaded).toMatchObject({ success: true });
    return {
      service,
      states: () => {
        service.getAllStates("states");
        return events.filter((e): e is AllStates => e.type === "all-states").at(-1)!;
      },
    };
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "git-init-enum-")));
    writeFileSync(path.join(root, "README.md"), "hello\n");
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a pre-init host's empty verdict, and a fresh host enumerates the main worktree", async () => {
    const before = await loadedService();
    expect(before.states()).toMatchObject({ states: [], gitBacked: false });

    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial commit");

    // The host that loaded first never re-probes: this is why it must be replaced.
    expect(before.states()).toMatchObject({ states: [], gitBacked: false });

    const after = await loadedService();
    const { states, gitBacked } = after.states();
    expect(gitBacked).toBe(true);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ path: root, isMainWorktree: true, branch: "main" });
  });
});
