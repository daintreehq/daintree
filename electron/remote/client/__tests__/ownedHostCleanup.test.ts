import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
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

function finishTeardown(worktreeId: string): void {
  events.emit("sys:worktree:resource-teardown", { worktreeId, timestamp: Date.now() });
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

  it("tries a refused removal again once the install that blocked it is over", async () => {
    let installing = true;
    const forget = vi.fn(async () => {
      if (installing) throw new Error("It can be removed once the install finishes");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = watchOwnedHostCleanup({
      list: () => [host("box-a", "/wt/a")],
      forget,
      probe: enoent,
      retryDelayMs: 5,
    });

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    installing = false;

    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });

  it("stops retrying once the host is gone some other way", async () => {
    const hosts = [host("box-a", "/wt/a")];
    const forget = vi.fn(async () => {
      throw new Error("installing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = watchOwnedHostCleanup({ list: () => hosts, forget, probe: enoent, retryDelayMs: 5 });

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    hosts.length = 0;

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forget).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
