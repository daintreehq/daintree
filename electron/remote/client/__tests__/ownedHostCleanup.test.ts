import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { WorktreeState } from "../../../../shared/types/worktree.js";
import { events } from "../../../services/events.js";
import { watchOwnedHostCleanup } from "../ownedHostCleanup.js";

function host(id: string, ownerWorktreeId?: string): HostDescriptor {
  return {
    id,
    name: id,
    connection: { kind: "ssh", target: id },
    platform: null,
    arch: null,
    lastHandshake: null,
    lastSeenAt: null,
    addedAt: 0,
    notificationsEnabled: false,
    assistantControlEnabled: true,
    ...(ownerWorktreeId ? { ownerWorktreeId } : {}),
  };
}

const enoent = () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));

function removeWorktree(worktreeId: string): void {
  events.emit("sys:worktree:remove", { worktreeId, timestamp: Date.now() });
}

function finishTeardown(
  worktreeId: string,
  state: "success" | "failed" | "running" = "success",
  phase: "resource-teardown" | "resource-pause" = "resource-teardown",
  startedAt = 1
): void {
  events.emit("sys:worktree:update", {
    id: worktreeId,
    lifecycleStatus: { phase, state, startedAt },
  } as unknown as WorktreeState);
}

describe("watchOwnedHostCleanup", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("forgets only the hosts the deleted worktree owns", async () => {
    const forget = vi.fn(async () => {});
    stop = watchOwnedHostCleanup({
      list: () => [host("box-a", "/wt/a"), host("box-b", "/wt/b"), host("studio")],
      forget,
      probe: enoent,
    });

    removeWorktree("/wt/a");

    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    expect(forget).toHaveBeenCalledWith("box-a");
  });

  it("keeps the host while the worktree's folder is still there", async () => {
    const forget = vi.fn(async () => {});
    const probe = vi.fn(async () => ({}));
    stop = watchOwnedHostCleanup({ list: () => [host("box-a", "/wt/a")], forget, probe });

    removeWorktree("/wt/a");

    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith("/wt/a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forget).not.toHaveBeenCalled();
  });

  it("keeps the host when the folder can't be checked", async () => {
    const forget = vi.fn(async () => {});
    const probe = vi.fn(() => Promise.reject(Object.assign(new Error("io"), { code: "EIO" })));
    stop = watchOwnedHostCleanup({ list: () => [host("box-a", "/wt/a")], forget, probe });

    removeWorktree("/wt/a");

    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forget).not.toHaveBeenCalled();
  });

  it("checks nothing for a worktree that owns no host", () => {
    const probe = vi.fn(enoent);
    stop = watchOwnedHostCleanup({ list: () => [host("studio")], forget: vi.fn(), probe });

    removeWorktree("/wt/a");

    expect(probe).not.toHaveBeenCalled();
  });

  it("goes on to the next host when one can't be removed", async () => {
    const forget = vi.fn(async (hostId: string) => {
      if (hostId === "box-1") throw new Error("installing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = watchOwnedHostCleanup({
      list: () => [host("box-1", "/wt/a"), host("box-2", "/wt/a")],
      forget,
      probe: enoent,
    });

    removeWorktree("/wt/a");

    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith("box-2"));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("forgets the worktree's hosts once its resource teardown succeeds", async () => {
    const forget = vi.fn(async () => {});
    stop = watchOwnedHostCleanup({
      list: () => [host("box-a", "/wt/a"), host("studio")],
      forget,
      probe: enoent,
    });

    finishTeardown("/wt/a");

    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith("box-a"));
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a teardown still running", "running", "resource-teardown"],
    ["a failed teardown", "failed", "resource-teardown"],
    ["a pause", "success", "resource-pause"],
  ] as const)("keeps the host through %s", async (_label, state, phase) => {
    const forget = vi.fn(async () => {});
    stop = watchOwnedHostCleanup({ list: () => [host("box-a", "/wt/a")], forget, probe: enoent });

    finishTeardown("/wt/a", state, phase);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forget).not.toHaveBeenCalled();
  });

  it("acts once on a teardown its every later update repeats, and again on the next one", async () => {
    const hosts = [host("box-a", "/wt/a")];
    const list = vi.fn(() => hosts);
    const forget = vi.fn(async () => {});
    stop = watchOwnedHostCleanup({ list, forget, probe: enoent });

    finishTeardown("/wt/a", "success", "resource-teardown", 1);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    list.mockClear();
    finishTeardown("/wt/a", "success", "resource-teardown", 1);
    expect(list).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    finishTeardown("/wt/a", "success", "resource-teardown", 2);
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(2));
  });

  it("stops listening once disposed", () => {
    const probe = vi.fn(enoent);
    const dispose = watchOwnedHostCleanup({
      list: () => [host("box-a", "/wt/a")],
      forget: vi.fn(),
      probe,
    });
    dispose();

    removeWorktree("/wt/a");

    expect(probe).not.toHaveBeenCalled();
  });
});
