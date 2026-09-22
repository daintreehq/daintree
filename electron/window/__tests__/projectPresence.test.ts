import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProjectPresence } from "../projectPresence.js";
import { claimProjectActivation } from "../projectActivationClaims.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { WindowContext, WindowRegistry } from "../WindowRegistry.js";

function makePvm(active: string | null, views: Array<string | [string, { destroyed: boolean }]>) {
  const entries = views.map((v) => {
    const [projectId, opts] = typeof v === "string" ? [v, { destroyed: false }] : v;
    return { projectId, view: { webContents: { isDestroyed: () => opts.destroyed } } };
  });
  return {
    getActiveProjectId: vi.fn(() => active),
    getAllViews: vi.fn(() => entries),
  };
}

function makeContext(
  windowId: number,
  pvm: ReturnType<typeof makePvm> | undefined,
  opts: { destroyed?: boolean } = {}
): WindowContext {
  return {
    windowId,
    browserWindow: { isDestroyed: () => opts.destroyed ?? false },
    services: { projectViewManager: pvm },
  } as unknown as WindowContext;
}

function registryOf(contexts: WindowContext[]): WindowRegistry {
  return { all: () => contexts } as unknown as WindowRegistry;
}

const SCRATCH_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

describe("buildProjectPresence", () => {
  it("splits the requester's own projects from other windows'", () => {
    const own = makeContext(1, makePvm("a", ["a", "b"]));
    const other = makeContext(2, makePvm("c", ["c", "d"]));

    const snapshot = buildProjectPresence(registryOf([own, other]), { windowId: 1 });

    expect(snapshot.thisWindow).toEqual([
      { projectId: "a", windowId: 1, state: "foreground" },
      { projectId: "b", windowId: 1, state: "cached" },
    ]);
    expect(snapshot.otherWindows).toEqual([
      { projectId: "c", windowId: 2, state: "foreground" },
      { projectId: "d", windowId: 2, state: "cached" },
    ]);
  });

  it("recognises the requester by its manager as well as its window id", () => {
    // The same identity rule as `findOtherProjectOwner`: a manager the request
    // acts on is never someone else's.
    const pvm = makePvm("a", ["a"]);
    const snapshot = buildProjectPresence(registryOf([makeContext(7, pvm)]), {
      windowId: 1,
      projectViewManager: pvm as unknown as ProjectViewManager,
    });

    expect(snapshot.otherWindows).toEqual([]);
    expect(snapshot.thisWindow.map((e) => e.projectId)).toEqual(["a"]);
  });

  it("reports a claimed activation with no view yet as activating", () => {
    releases.push(claimProjectActivation("x", 2));
    const other = makeContext(2, makePvm("c", ["c"]));

    const snapshot = buildProjectPresence(registryOf([other]), { windowId: 1 });

    expect(snapshot.otherWindows).toContainEqual({
      projectId: "x",
      windowId: 2,
      state: "activating",
    });
  });

  it("lets the manager's own inventory outrank a claim it has outlived", () => {
    releases.push(claimProjectActivation("c", 2));
    releases.push(claimProjectActivation("d", 2));
    const other = makeContext(2, makePvm("c", ["c", "d"]));

    const snapshot = buildProjectPresence(registryOf([other]), { windowId: 1 });

    expect(snapshot.otherWindows).toEqual([
      { projectId: "c", windowId: 2, state: "foreground" },
      { projectId: "d", windowId: 2, state: "cached" },
    ]);
  });

  it("keeps one entry per project, the owner a switch would go to", () => {
    // A fleet built before the one-view rule can hold a project twice. The
    // window closest to showing it wins, then registry order.
    const cachedFirst = makeContext(2, makePvm("q", ["q", "p"]));
    const shown = makeContext(3, makePvm("p", ["p"]));
    const cachedLater = makeContext(4, makePvm("r", ["r", "q"]));

    const snapshot = buildProjectPresence(registryOf([cachedFirst, shown, cachedLater]), {
      windowId: 1,
    });

    const byId = new Map(snapshot.otherWindows.map((e) => [e.projectId, e]));
    expect(snapshot.otherWindows).toHaveLength(3);
    expect(byId.get("p")).toEqual({ projectId: "p", windowId: 3, state: "foreground" });
    expect(byId.get("q")).toEqual({ projectId: "q", windowId: 2, state: "foreground" });
  });

  it("exempts a project only for a live view here, as a switch does", () => {
    // A claim or a bare pointer here doesn't stop the pick going to the window
    // holding the live view (`findOwnerElsewhere`), so the row still says so.
    releases.push(claimProjectActivation("claimed", 1));
    const own = makeContext(1, makePvm("pointer", []));
    const other = makeContext(2, makePvm("claimed", ["claimed", "pointer"]));

    const snapshot = buildProjectPresence(registryOf([own, other]), { windowId: 1 });

    expect(snapshot.thisWindow).toEqual([
      { projectId: "pointer", windowId: 1, state: "foreground" },
      { projectId: "claimed", windowId: 1, state: "activating" },
    ]);
    expect(snapshot.otherWindows).toEqual([
      { projectId: "claimed", windowId: 2, state: "foreground" },
      { projectId: "pointer", windowId: 2, state: "cached" },
    ]);
  });

  it("never reports as elsewhere a project the requester holds a view of", () => {
    // It switches in place, whoever else has it (`findOwnerElsewhere`).
    const own = makeContext(1, makePvm("a", ["a", "p"]));
    const other = makeContext(2, makePvm("p", ["p"]));

    const snapshot = buildProjectPresence(registryOf([own, other]), { windowId: 1 });

    expect(snapshot.otherWindows).toEqual([]);
    expect(snapshot.thisWindow).toContainEqual({ projectId: "p", windowId: 1, state: "cached" });
  });

  it("drops dead views, destroyed windows, missing managers and unreadable ones", () => {
    const deadView = makeContext(2, makePvm(null, [["p", { destroyed: true }]]));
    const destroyed = makeContext(3, makePvm("q", ["q"]), { destroyed: true });
    const bare = makeContext(4, undefined);
    const unreadablePvm = makePvm("r", ["r"]);
    unreadablePvm.getActiveProjectId.mockImplementation(() => {
      throw new Error("disposed");
    });
    const unreadable = makeContext(5, unreadablePvm);
    const healthy = makeContext(6, makePvm("s", ["s"]));

    const snapshot = buildProjectPresence(
      registryOf([deadView, destroyed, bare, unreadable, healthy]),
      { windowId: 1 }
    );

    expect(snapshot.otherWindows).toEqual([{ projectId: "s", windowId: 6, state: "foreground" }]);
  });

  it("lets a view that can't be read cost only itself", () => {
    // The owner lookup reads the active pointer before any view, so a switch
    // still goes to this window's foreground project.
    const throwingInventory = makePvm("r", ["r", "t"]);
    throwingInventory.getAllViews.mockImplementation(() => {
      throw new Error("disposed");
    });
    const brokenView = makePvm("u", ["u", "v"]);
    brokenView.getAllViews.mockReturnValue([
      { projectId: "u", view: { webContents: { isDestroyed: () => false } } },
      {
        projectId: "v",
        view: {
          webContents: {
            isDestroyed: () => {
              throw new Error("gone");
            },
          },
        },
      },
    ]);

    const snapshot = buildProjectPresence(
      registryOf([makeContext(2, throwingInventory), makeContext(3, brokenView)]),
      { windowId: 1 }
    );

    expect(snapshot.otherWindows).toEqual([
      { projectId: "r", windowId: 2, state: "foreground" },
      { projectId: "u", windowId: 3, state: "foreground" },
    ]);
  });

  it("leaves scratches out — a scratch switch never goes looking for an owner", () => {
    const other = makeContext(2, makePvm(SCRATCH_ID, [SCRATCH_ID, "p"]));

    const snapshot = buildProjectPresence(registryOf([other]), { windowId: 1 });

    expect(snapshot.otherWindows).toEqual([{ projectId: "p", windowId: 2, state: "cached" }]);
  });

  it("reads the live state on every call", () => {
    const pvm = makePvm("a", ["a"]);
    const registry = registryOf([makeContext(2, pvm)]);
    expect(buildProjectPresence(registry, { windowId: 1 }).otherWindows).toHaveLength(1);

    pvm.getActiveProjectId.mockReturnValue(null);
    pvm.getAllViews.mockReturnValue([]);

    expect(buildProjectPresence(registry, { windowId: 1 }).otherWindows).toEqual([]);
  });

  it("answers empty without a registry", () => {
    expect(buildProjectPresence(undefined, { windowId: 1 })).toEqual({
      thisWindow: [],
      otherWindows: [],
    });
  });
});
