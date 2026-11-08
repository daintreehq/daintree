import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types/project.js";
import type { ScheduledRunWorktreeClaim } from "../ScheduledRunStore.js";
import {
  prepareRunWorktree,
  type RunWorktreeListing,
  type ScheduledRunWorktreeHost,
} from "../scheduledRunWorktree.js";

const project = { id: "project-1", path: "/repo", name: "Repo", status: "active" } as Project;
const base = { baseBranch: "main", fromRemote: false };

function harness(listing: () => readonly RunWorktreeListing[] | null) {
  let claim: ScheduledRunWorktreeClaim | null = null;
  let time = 0;
  const host: ScheduledRunWorktreeHost = {
    list: vi.fn(async () => listing()),
    create: vi.fn(async () => "/worktrees/new"),
  };
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  const prepare = (shouldStop: () => boolean = () => false) =>
    prepareRunWorktree({
      project,
      scheduleId: "schedule-1",
      scheduleName: "Nightly",
      base,
      recorder: {
        worktreeClaim: () => claim,
        saveWorktreeClaim: (next) => {
          claim = next;
        },
      },
      host,
      newId: () => "abcd1234",
      shouldStop,
      sleep,
      now: () => time,
    });
  return {
    host,
    sleep,
    prepare,
    elapsed: () => time,
    holdClaim: (next: ScheduledRunWorktreeClaim) => {
      claim = next;
    },
  };
}

const running: RunWorktreeListing = {
  id: "/worktrees/new",
  path: "/real/worktrees/new",
  branch: "whatever",
  setupStatus: { state: "running", startedAt: 1 },
};

describe("prepareRunWorktree", () => {
  it("waits out pending and running, and answers the path the host lists", async () => {
    let looks = 0;
    const { prepare, sleep } = harness(() => {
      looks += 1;
      if (looks === 1) {
        return [{ ...running, setupStatus: { state: "pending" as const, startedAt: 1 } }];
      }
      if (looks === 2) return [running];
      return [{ ...running, setupStatus: { state: "ready" as const, startedAt: 1 } }];
    });

    await expect(prepare()).resolves.toMatchObject({
      status: "ready",
      worktreeId: "/worktrees/new",
      path: "/real/worktrees/new",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up on a setup still running at the deadline, saying so", async () => {
    const { prepare, elapsed } = harness(() => [running]);

    await expect(prepare()).resolves.toMatchObject({
      status: "refused",
      message: expect.stringContaining("still running after 10 minutes"),
      worktree: { worktreeId: "/worktrees/new" },
    });
    // Waited the whole budget, and not a poll past it.
    expect(elapsed()).toBe(10 * 60_000);
  });

  it("stops looking once told to, launching nothing later", async () => {
    let stop = false;
    const { prepare, host } = harness(() => {
      stop = true;
      return [running];
    });

    await expect(prepare(() => stop)).resolves.toMatchObject({ status: "stopped" });
    expect(host.list).toHaveBeenCalledTimes(1);
  });

  it("refuses when the host can't be asked, rather than assuming the worktree is there", async () => {
    const { prepare } = harness(() => null);

    await expect(prepare()).resolves.toMatchObject({
      status: "refused",
      message: expect.stringContaining("workspace service isn't available"),
    });
  });

  it("refuses when the worktree goes away while it sets up", async () => {
    const { prepare } = harness(() => []);

    await expect(prepare()).resolves.toMatchObject({
      status: "refused",
      message: "The new worktree went away before its setup finished.",
    });
  });

  it("finds an earlier attempt's worktree by its branch instead of creating one", async () => {
    let branch = "";
    const create = vi.fn(async (_project: Project, request: { branch: string }) => {
      branch = request.branch;
      return "/worktrees/new";
    });
    const { prepare, host } = harness(() => [
      {
        id: "/worktrees/unrelated",
        path: "/worktrees/unrelated",
        branch: "unrelated",
        setupStatus: { state: "ready", startedAt: 1 },
      },
      {
        id: "/worktrees/new",
        path: "/worktrees/new",
        branch,
        setupStatus: { state: "ready", startedAt: 1 },
      },
    ]);
    host.create = create;

    await expect(prepare()).resolves.toMatchObject({ status: "ready" });
    await expect(prepare()).resolves.toMatchObject({
      status: "ready",
      worktreeId: "/worktrees/new",
      worktree: { branch },
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("starts afresh for a claim on the same name from a different kind of base", async () => {
    const { prepare, host, holdClaim } = harness(() => [
      { ...running, setupStatus: { state: "ready", startedAt: 1 } },
    ]);
    holdClaim({
      scheduleId: "schedule-1",
      projectId: "project-1",
      branch: "schedule-old",
      baseBranch: "main",
      fromRemote: true,
    });

    await prepare();

    expect(vi.mocked(host.create).mock.calls[0]![1].branch).not.toBe("schedule-old");
  });

  it("caps a create failure's reason, which is git's own text", async () => {
    const { prepare, host } = harness(() => []);
    host.create = vi.fn(async () => {
      throw new Error("x".repeat(2_000));
    });

    const prepared = await prepare();

    expect(prepared.status).toBe("refused");
    expect(prepared.status === "refused" && prepared.message.length).toBeLessThan(600);
  });
});
