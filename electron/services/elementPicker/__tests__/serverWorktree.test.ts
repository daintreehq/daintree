import { describe, expect, it } from "vitest";
import type { PortListener } from "../../../remote/ports/listenerScan.js";
import { findServerWorktree, localServerPort, type ServerWorktreeDeps } from "../serverWorktree.js";

// The main checkout holds a linked worktree inside it, as `.worktrees/` layouts do.
const WORKTREES = [
  { id: "main", root: "/repo" },
  { id: "wt-b", root: "/repo/.worktrees/b" },
  { id: "wt-c", root: "/work/c" },
];

function deps(
  listeners: PortListener[] | null,
  links: Record<string, string> = {},
  checkouts: readonly string[] = []
): ServerWorktreeDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    findListeners: async (port) => {
      asked.push(port);
      return listeners;
    },
    canonical: async (target) => links[target] ?? target,
    isCheckoutRoot: async (dir) => checkouts.includes(dir),
  };
}

describe("findServerWorktree", () => {
  it("places the server in the worktree its process runs from, the innermost one", async () => {
    const d = deps([{ pid: 1, cwd: "/repo/.worktrees/b/apps/site" }]);
    expect(await findServerWorktree(5173, WORKTREES, d)).toEqual({
      status: "worktree",
      worktreeId: "wt-b",
    });
    expect(d.asked).toEqual([5173]);
    expect(await findServerWorktree(5173, WORKTREES, deps([{ pid: 1, cwd: "/repo/src" }]))).toEqual(
      { status: "worktree", worktreeId: "main" }
    );
  });

  it("can't say for a checkout of its own nested inside a worktree", async () => {
    // Another project, or a submodule, cloned under the main checkout.
    for (const cwd of [
      "/repo/vendor/other",
      "/repo/vendor/other/app",
      "/repo/vendor/other/packages/web/src",
    ]) {
      const d = deps([{ pid: 1, cwd }], {}, ["/repo/vendor/other"]);
      expect(await findServerWorktree(5173, WORKTREES, d), cwd).toEqual({ status: "unknown" });
    }
    // The worktree's own root holding `.git` is no nesting.
    for (const [cwd, worktreeId] of [
      ["/repo/src/deep/er", "main"],
      ["/repo", "main"],
      ["/repo/.worktrees/b", "wt-b"],
      ["/repo/.worktrees/b/app", "wt-b"],
    ] as const) {
      const own = deps([{ pid: 1, cwd }], {}, ["/repo", "/repo/.worktrees/b"]);
      expect(await findServerWorktree(5173, WORKTREES, own), cwd).toEqual({
        status: "worktree",
        worktreeId,
      });
    }
  });

  it("compares the directory with its links resolved", async () => {
    const d = deps([{ pid: 1, cwd: "/tmp/link-to-c" }], { "/tmp/link-to-c": "/work/c/app" });
    expect(await findServerWorktree(5173, WORKTREES, d)).toEqual({
      status: "worktree",
      worktreeId: "wt-c",
    });
  });

  it("agrees across both address families when one worktree holds them", async () => {
    const d = deps([
      { pid: 1, cwd: "/work/c" },
      { pid: 2, cwd: "/work/c/web" },
    ]);
    expect(await findServerWorktree(5173, WORKTREES, d)).toEqual({
      status: "worktree",
      worktreeId: "wt-c",
    });
  });

  it("can't say when the listeners run from different worktrees", async () => {
    const d = deps([
      { pid: 1, cwd: "/work/c" },
      { pid: 2, cwd: "/repo" },
    ]);
    expect(await findServerWorktree(5173, WORKTREES, d)).toEqual({ status: "unknown" });
  });

  it("can't say for a server outside every worktree of the project", async () => {
    // Another project's checkout, a container proxy at /, a lookalike sibling.
    for (const cwd of ["/other/project", "/", "/repo-old/app", "/work/cc"]) {
      expect(await findServerWorktree(5173, WORKTREES, deps([{ pid: 1, cwd }])), cwd).toEqual({
        status: "unknown",
      });
    }
  });

  it("can't say when any listener is unplaced, or nothing listens", async () => {
    for (const listeners of [
      null,
      [],
      [{ pid: 1, cwd: null }],
      [
        { pid: 1, cwd: "/work/c" },
        { pid: 2, cwd: null },
      ],
      [{ pid: 1, cwd: "relative/dir" }],
    ]) {
      expect(await findServerWorktree(5173, WORKTREES, deps(listeners))).toEqual({
        status: "unknown",
      });
    }
  });

  it("can't say when a directory doesn't resolve or a lookup throws", async () => {
    const gone: ServerWorktreeDeps = {
      findListeners: async () => [{ pid: 1, cwd: "/work/c/deleted" }],
      canonical: async () => null,
      isCheckoutRoot: async () => false,
    };
    expect(await findServerWorktree(5173, WORKTREES, gone)).toEqual({ status: "unknown" });
    const failing: ServerWorktreeDeps = {
      findListeners: () => Promise.reject(new Error("lsof failed")),
      canonical: async (target) => target,
      isCheckoutRoot: async () => false,
    };
    expect(await findServerWorktree(5173, WORKTREES, failing)).toEqual({ status: "unknown" });
    const unreadable: ServerWorktreeDeps = {
      findListeners: async () => [{ pid: 1, cwd: "/work/c/app" }],
      canonical: async (target) => target,
      isCheckoutRoot: () => Promise.reject(new Error("EACCES")),
    };
    expect(await findServerWorktree(5173, WORKTREES, unreadable)).toEqual({ status: "unknown" });
  });
});

describe("localServerPort", () => {
  it("names the port of a page at a loopback name or address", () => {
    expect(localServerPort("http://localhost:5173/a?b")).toBe(5173);
    expect(localServerPort("http://app.localhost:4321/")).toBe(4321);
    expect(localServerPort("http://127.0.0.1:3000/")).toBe(3000);
    expect(localServerPort("http://127.1:3001/")).toBe(3001);
    expect(localServerPort("http://[::1]:8080/")).toBe(8080);
    expect(localServerPort("http://0.0.0.0:9000/")).toBe(9000);
    expect(localServerPort("http://LOCALHOST./")).toBe(80);
    expect(localServerPort("https://localhost/")).toBe(443);
  });

  it("names none for an address that may be another machine, or no page", () => {
    for (const url of [
      "http://my-mac.local:5173/",
      "http://app.test:3000/",
      "http://192.168.1.20:5173/",
      "http://localhost.example.com/",
      "https://example.com/",
      "file:///etc/hosts",
      "about:blank",
      "not a url",
    ]) {
      expect(localServerPort(url), url).toBeNull();
    }
  });
});
