import { describe, expect, it } from "vitest";
import type { HostPidOwner } from "../../../../shared/types/processes.js";
import { findListenerOwner, type ListenerOwnerDeps } from "../listenerOwner.js";

function owner(
  pid: number,
  worktreeId: string | null,
  projectId: string | null = "p1"
): HostPidOwner {
  return { pid, terminalId: `t-${pid}`, projectId, worktreeId };
}

function deps(
  pids: number[] | null,
  owners: HostPidOwner[]
): ListenerOwnerDeps & {
  asked: number[][];
} {
  const asked: number[][] = [];
  return {
    asked,
    findListenerPids: async () => pids,
    findPidOwners: async (list) => {
      asked.push(list);
      return owners;
    },
  };
}

describe("findListenerOwner", () => {
  it("names the worktree of the terminal whose tree holds the listener", async () => {
    const d = deps([4242], [owner(4242, "/repo/wt-b")]);
    expect(await findListenerOwner(5173, d)).toEqual({
      status: "terminal",
      projectId: "p1",
      worktreeId: "/repo/wt-b",
    });
    expect(d.asked).toEqual([[4242]]);
  });

  it("agrees across both address families when one worktree holds them", async () => {
    expect(
      await findListenerOwner(5173, deps([10, 11], [owner(10, "/wt"), owner(11, "/wt")]))
    ).toEqual({ status: "terminal", projectId: "p1", worktreeId: "/wt" });
  });

  it("can't say when the machine can't say, or nothing is listening", async () => {
    const none = deps([], []);
    expect(await findListenerOwner(5173, deps(null, []))).toEqual({ status: "unknown" });
    expect(await findListenerOwner(5173, none)).toEqual({ status: "unknown" });
    // Nothing to ask the census about.
    expect(none.asked).toEqual([]);
  });

  it("can't say when a listener sits in no terminal's tree", async () => {
    // localhost reaches either socket, so the unplaced one may be the server.
    expect(await findListenerOwner(5173, deps([10, 11], [owner(10, "/wt")]))).toEqual({
      status: "unknown",
    });
    expect(await findListenerOwner(5173, deps([10], []))).toEqual({ status: "unknown" });
  });

  it("can't say when the listeners belong to different worktrees or projects", async () => {
    expect(
      await findListenerOwner(5173, deps([10, 11], [owner(10, "/a"), owner(11, "/b")]))
    ).toEqual({ status: "unknown" });
    expect(
      await findListenerOwner(5173, deps([10, 11], [owner(10, "/a", "p1"), owner(11, "/a", "p2")]))
    ).toEqual({ status: "unknown" });
  });

  it("makes no claim for a terminal with no project or worktree of its own", async () => {
    expect(await findListenerOwner(5173, deps([10], [owner(10, null)]))).toEqual({
      status: "unknown",
    });
    expect(await findListenerOwner(5173, deps([10], [owner(10, "/a", null)]))).toEqual({
      status: "unknown",
    });
  });

  it("ignores an answer about a process it didn't ask about", async () => {
    expect(await findListenerOwner(5173, deps([10], [owner(99, "/a")]))).toEqual({
      status: "unknown",
    });
  });

  it("can't say when a lookup throws", async () => {
    expect(
      await findListenerOwner(5173, {
        findListenerPids: () => Promise.reject(new Error("lsof failed")),
        findPidOwners: async () => [],
      })
    ).toEqual({ status: "unknown" });
    expect(
      await findListenerOwner(5173, {
        findListenerPids: async () => [10],
        findPidOwners: () => Promise.reject(new Error("pty host gone")),
      })
    ).toEqual({ status: "unknown" });
  });
});
