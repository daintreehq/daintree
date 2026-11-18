import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { events } from "../../../services/events.js";
import { watchOwnedHostCleanup, worktreeRootGone } from "../ownedHostCleanup.js";

function waiting(id: string, worktreeId: string, ownerWorktreeId?: string): HostDescriptor {
  return {
    ...host(id, ownerWorktreeId),
    pendingPlacement: {
      projectId: "proj-1",
      worktreeId,
      worktreePath: worktreeId,
      label: "feature",
      requestedAt: 1,
    },
  };
}

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

  it("drops a deleted worktree's placement from the user's own host, leaving the host", async () => {
    const forget = vi.fn(async () => {});
    const clearPlacement = vi.fn(async () => {});
    stop = watchOwnedHostCleanup({
      list: () => [
        waiting("studio", "/wt/a"),
        waiting("mini", "/wt/b"),
        waiting("box", "/wt/a", "/wt/a"),
      ],
      forget,
      clearPlacement,
      probe: enoent,
    });

    removeWorktree("/wt/a");

    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith("box"));
    // The owned host goes whole; only the user's own host needs its placement dropped.
    expect(clearPlacement).toHaveBeenCalledTimes(1);
    expect(clearPlacement).toHaveBeenCalledWith("studio");
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("keeps a placement while the worktree's folder is still there, and drops it on teardown", async () => {
    const clearPlacement = vi.fn(async () => {});
    const probe = vi.fn(async () => ({}));
    stop = watchOwnedHostCleanup({
      list: () => [waiting("studio", "/wt/a")],
      forget: vi.fn(async () => {}),
      clearPlacement,
      probe,
    });

    removeWorktree("/wt/a");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith("/wt/a"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clearPlacement).not.toHaveBeenCalled();

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(clearPlacement).toHaveBeenCalledWith("studio"));
  });

  it("keeps a worktree waiting on its own machine through a resource teardown, until the worktree goes", async () => {
    const clearPlacement = vi.fn(async () => {});
    const onMachine = waiting("feature-login", "/wt/a");
    onMachine.connection = { kind: "cloud", bindingId: "cb_0123456789ab" };
    onMachine.pendingPlacement!.createdMachine = true;
    stop = watchOwnedHostCleanup({
      list: () => [onMachine, waiting("studio", "/wt/a")],
      forget: vi.fn(async () => {}),
      clearPlacement,
      probe: enoent,
    });

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(clearPlacement).toHaveBeenCalledWith("studio"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clearPlacement).not.toHaveBeenCalledWith("feature-login");

    removeWorktree("/wt/a");
    await vi.waitFor(() => expect(clearPlacement).toHaveBeenCalledWith("feature-login"));
  });

  it("checks a removal heard while the worktree's teardown is still removing its box", async () => {
    const onMachine = waiting("feature-login", "/wt/a");
    onMachine.connection = { kind: "cloud", bindingId: "cb_0123456789ab" };
    onMachine.pendingPlacement!.createdMachine = true;
    let hosts: HostDescriptor[] = [host("box", "/wt/a"), onMachine];
    const clearPlacement = vi.fn(async (id: string) => {
      hosts = hosts.map((entry) => {
        if (entry.id !== id) return entry;
        const { pendingPlacement: _cleared, ...rest } = entry;
        return rest;
      });
    });
    let finishForget!: () => void;
    const forget = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          finishForget = () => {
            hosts = hosts.filter((entry) => entry.id !== id);
            resolve();
          };
        })
    );
    stop = watchOwnedHostCleanup({ list: () => hosts, forget, clearPlacement, probe: enoent });

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith("box"));
    removeWorktree("/wt/a");
    expect(clearPlacement).not.toHaveBeenCalled();
    finishForget();
    await vi.waitFor(() => expect(clearPlacement).toHaveBeenCalledWith("feature-login"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forget).toHaveBeenCalledTimes(1);
    expect(clearPlacement).toHaveBeenCalledTimes(1);
  });

  it("checks a queued removal even when the pass before it found the folder still there", async () => {
    const onMachine = waiting("feature-login", "/wt/a");
    onMachine.pendingPlacement!.createdMachine = true;
    const clearPlacement = vi.fn(async () => {});
    let answerFirst!: (gone: boolean) => void;
    const probe = vi
      .fn<(path: string) => Promise<unknown>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            answerFirst = (gone) =>
              gone ? reject(Object.assign(new Error("gone"), { code: "ENOENT" })) : resolve({});
          })
      )
      .mockImplementation(enoent);
    stop = watchOwnedHostCleanup({
      list: () => [onMachine],
      forget: vi.fn(async () => {}),
      clearPlacement,
      probe,
    });

    removeWorktree("/wt/a");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    removeWorktree("/wt/a");
    answerFirst(false);
    await vi.waitFor(() => expect(clearPlacement).toHaveBeenCalledWith("feature-login"));
    expect(probe).toHaveBeenCalledTimes(2);
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

  it("retries only the host it was removing, never one added later for a new box", async () => {
    const hosts = [host("box-a", "/wt/a")];
    let installing = true;
    const forget = vi.fn(async (hostId: string) => {
      if (installing) throw new Error("installing");
      const at = hosts.findIndex((entry) => entry.id === hostId);
      if (at >= 0) hosts.splice(at, 1);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stop = watchOwnedHostCleanup({ list: () => hosts, forget, probe: enoent, retryDelayMs: 5 });

    finishTeardown("/wt/a");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    hosts.push(host("box-b", "/wt/a"));
    installing = false;

    await vi.waitFor(() => expect(forget).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forget.mock.calls.map(([hostId]) => hostId)).toEqual(["box-a", "box-a"]);
    expect(hosts.map((entry) => entry.id)).toEqual(["box-b"]);
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

describe("worktreeRootGone (#17360)", () => {
  const ROOT = "/Volumes/Work/app-worktrees/feature-login";
  const PARENT = "/Volumes/Work/app-worktrees";
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  const root = (answer: "exists" | "missing" | "denied") =>
    vi.fn(async (_target: string) =>
      answer === "exists" ? {} : fail(answer === "denied" ? "EACCES" : "ENOENT")
    );
  const parent = (answer: "directory" | "file" | "missing") =>
    vi.fn(async (_target: string) =>
      answer === "missing" ? fail("ENOENT") : { isDirectory: () => answer === "directory" }
    );

  it("is gone only when the root is missing and the folder it sat in is a directory", async () => {
    const parentProbe = parent("directory");
    expect(await worktreeRootGone(ROOT, { root: root("missing"), parent: parentProbe })).toBe(true);
    expect(parentProbe).toHaveBeenCalledWith(PARENT);
    expect(
      await worktreeRootGone(ROOT, { root: root("exists"), parent: parent("directory") })
    ).toBe(false);
  });

  it("proves nothing when the parent doesn't read, as through a link into an unmounted drive", async () => {
    expect(
      await worktreeRootGone(ROOT, { root: root("missing"), parent: parent("missing") })
    ).toBeNull();
    expect(
      await worktreeRootGone(ROOT, { root: root("missing"), parent: parent("file") })
    ).toBeNull();
  });

  it("isn't gone when the root comes back while its parent is read, as a volume remounting", async () => {
    const rootProbe = vi
      .fn(async (_target: string): Promise<unknown> => ({}))
      .mockImplementationOnce(() => fail("ENOENT"));
    expect(await worktreeRootGone(ROOT, { root: rootProbe, parent: parent("directory") })).toBe(
      false
    );
    expect(rootProbe).toHaveBeenCalledTimes(2);
  });

  it("proves nothing when the root can't be read", async () => {
    const parentProbe = parent("directory");
    expect(await worktreeRootGone(ROOT, { root: root("denied"), parent: parentProbe })).toBeNull();
    expect(parentProbe).not.toHaveBeenCalled();
  });
});

describe("worktreeRootGone on a real filesystem (#17360)", () => {
  let base = "";
  afterEach(async () => {
    if (base) await fs.rm(base, { recursive: true, force: true });
    base = "";
  });

  it("follows a parent link: gone only when its target is a folder that reads", async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-gone-"));
    const real = path.join(base, "app-worktrees");
    await fs.mkdir(real);
    expect(await worktreeRootGone(path.join(real, "feature-login"))).toBe(true);
    await fs.mkdir(path.join(real, "feature-login"));
    expect(await worktreeRootGone(path.join(real, "feature-login"))).toBe(false);

    // A link into a drive that isn't mounted: nothing proven.
    const dangling = path.join(base, "on-drive");
    await fs.symlink(path.join(base, "unmounted", "app-worktrees"), dangling);
    expect(await worktreeRootGone(path.join(dangling, "feature-login"))).toBeNull();

    const linked = path.join(base, "linked");
    await fs.symlink(real, linked);
    expect(await worktreeRootGone(path.join(linked, "other"))).toBe(true);
  });
});
