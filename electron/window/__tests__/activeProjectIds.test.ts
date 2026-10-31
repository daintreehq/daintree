import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  collectActiveProjectIds,
  collectHeldWorkspaceIds,
  collectShownProjectIds,
  projectViewManagersFrom,
  setRemoteVisibleProjectIdsProvider,
} from "../activeProjectIds.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { WindowRegistry } from "../WindowRegistry.js";

type ProjectViewManagerMock = {
  getActiveProjectId: Mock<() => string | null>;
  getOutgoingBridgeProjectId: Mock<() => string | null>;
};

function makePvm(
  activeProjectId: string | null = null,
  outgoingBridgeProjectId: string | null = null
): ProjectViewManagerMock {
  return {
    getActiveProjectId: vi.fn(() => activeProjectId),
    getOutgoingBridgeProjectId: vi.fn(() => outgoingBridgeProjectId),
  };
}

function providerOf(managers: ProjectViewManagerMock[]): () => ProjectViewManager[] {
  return () => managers as unknown as ProjectViewManager[];
}

describe("collectActiveProjectIds (#11102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unions the foreground project of every window, not just the focused one", () => {
    const focused = makePvm("proj-a");
    const unfocused = makePvm("proj-b");

    const ids = collectActiveProjectIds(providerOf([focused, unfocused]), "proj-a", "test");

    expect(ids.has("proj-b")).toBe(true);
  });

  it("treats the outgoing paint-gate bridge as visible", () => {
    // Mid cold-switch: activeProjectId already points at the incoming project,
    // but the outgoing one is still painted behind the anti-flash bridge.
    const switching = makePvm("proj-incoming", "proj-outgoing");

    const ids = collectActiveProjectIds(providerOf([switching]), null, "test");

    expect([...ids].sort()).toEqual(["proj-incoming", "proj-outgoing"]);
  });

  it("unions the fallback pointer additively rather than using it as the sole source", () => {
    const window = makePvm("proj-visible");

    const ids = collectActiveProjectIds(providerOf([window]), "proj-db-pointer", "test");

    // Both survive: the DB pointer never displaces what the windows report.
    expect(ids.has("proj-visible")).toBe(true);
    expect(ids.has("proj-db-pointer")).toBe(true);
  });

  it("falls back to the pointer alone when no provider is wired yet (early startup)", () => {
    const ids = collectActiveProjectIds(null, "proj-db-pointer", "test");

    expect([...ids]).toEqual(["proj-db-pointer"]);
  });

  it("returns an empty set when nothing is visible and no pointer is set", () => {
    const ids = collectActiveProjectIds(providerOf([makePvm(null)]), null, "test");

    expect(ids.size).toBe(0);
  });

  it("still yields the fallback pointer when the provider itself throws", () => {
    const throwing = (): ProjectViewManager[] => {
      throw new Error("registry tearing down");
    };

    const ids = collectActiveProjectIds(throwing, "proj-db-pointer", "test");

    // Never reclaim a project we could not verify — the pointer survives.
    expect(ids.has("proj-db-pointer")).toBe(true);
  });

  it("isolates a throwing manager so later windows are still collected (#8607)", () => {
    const disposing = makePvm();
    disposing.getActiveProjectId.mockImplementation(() => {
      throw new Error("manager disposed");
    });
    const healthy = makePvm("proj-still-visible");

    const ids = collectActiveProjectIds(providerOf([disposing, healthy]), null, "test");

    expect(ids.has("proj-still-visible")).toBe(true);
    expect(healthy.getActiveProjectId).toHaveBeenCalled();
  });
});

describe("collectActiveProjectIds with Host mode visibility", () => {
  let off: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    off?.();
    off = null;
  });

  function registerVisibility(visibleProjectIds: () => Set<string>): void {
    off = setRemoteVisibleProjectIdsProvider(visibleProjectIds);
  }

  it("unions in projects a remote Shell is displaying", () => {
    registerVisibility(() => new Set(["remote-proj"]));
    const ids = collectActiveProjectIds(providerOf([makePvm("proj-a")]), null, "test");
    expect([...ids].sort()).toEqual(["proj-a", "remote-proj"]);
  });

  it("reads the remote set live on every call", () => {
    let visible = new Set<string>();
    registerVisibility(() => visible);
    expect(collectActiveProjectIds(null, null, "test").has("late")).toBe(false);
    visible = new Set(["late"]);
    expect(collectActiveProjectIds(null, null, "test").has("late")).toBe(true);
  });

  it("keeps the local set when the remote lookup throws", () => {
    registerVisibility(() => {
      throw new Error("tearing down");
    });
    const ids = collectActiveProjectIds(providerOf([makePvm("proj-a")]), "ptr", "test");
    expect([...ids].sort()).toEqual(["proj-a", "ptr"]);
  });
});

describe("collectShownProjectIds (#13813)", () => {
  let off: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    off?.();
    off = null;
  });

  it("reads each window's switched-to project and leaves the outgoing bridge out", () => {
    const switching = makePvm("proj-incoming", "proj-outgoing");
    const other = makePvm("proj-b");

    const ids = collectShownProjectIds(providerOf([switching, other]), "test");

    expect([...ids].sort()).toEqual(["proj-b", "proj-incoming"]);
    expect(switching.getOutgoingBridgeProjectId).not.toHaveBeenCalled();
  });

  it("unions in what a remote Shell shows, and has no DB pointer to fall back on", () => {
    off = setRemoteVisibleProjectIdsProvider(() => new Set(["remote-proj"]));

    expect([...collectShownProjectIds(null, "test")]).toEqual(["remote-proj"]);
  });

  it("isolates a throwing manager like the reclaim collector", () => {
    const broken = makePvm();
    broken.getActiveProjectId.mockImplementation(() => {
      throw new Error("disposing");
    });

    const ids = collectShownProjectIds(providerOf([broken, makePvm("proj-b")]), "test");

    expect([...ids]).toEqual(["proj-b"]);
  });
});

describe("projectViewManagersFrom", () => {
  it("re-reads the registry on each call so windows opened later are seen", () => {
    const contexts: Array<{ services: { projectViewManager?: ProjectViewManager } }> = [];
    const registry = { all: () => contexts } as unknown as WindowRegistry;

    const provider = projectViewManagersFrom(registry);
    expect(provider()).toHaveLength(0);

    contexts.push({
      services: { projectViewManager: makePvm("p") as unknown as ProjectViewManager },
    });

    expect(provider()).toHaveLength(1);
  });

  it("drops windows that have no ProjectViewManager", () => {
    const registry = {
      all: () => [
        { services: {} },
        { services: { projectViewManager: makePvm("p") as unknown as ProjectViewManager } },
      ],
    } as unknown as WindowRegistry;

    expect(projectViewManagersFrom(registry)()).toHaveLength(1);
  });

  it("yields an empty list when no registry is available", () => {
    expect(projectViewManagersFrom(undefined)()).toEqual([]);
  });
});

describe("collectHeldWorkspaceIds (#15614)", () => {
  function heldManager(opts: {
    active?: string | null;
    outgoing?: string | null;
    views?: string[];
  }): ProjectViewManager {
    return {
      getActiveProjectId: () => opts.active ?? null,
      getOutgoingBridgeProjectId: () => opts.outgoing ?? null,
      getAllViews: () => (opts.views ?? []).map((projectId) => ({ projectId })),
    } as unknown as ProjectViewManager;
  }

  const none = () => [];

  it("unions every window's shown, bridged and cached views with every other hold", () => {
    const ids = collectHeldWorkspaceIds({
      projectViewManagers: () => [
        heldManager({ active: "shown-a", views: ["shown-a", "cached-a"] }),
        heldManager({ active: "incoming-b", outgoing: "bridged-b" }),
      ],
      remoteViewWorkspaceIds: () => ["remote-cached", null],
      liveTerminalWorkspaceIds: () => ["terminal-only"],
      openingWorkspaceIds: () => ["opening"],
      restoringWorkspaceIds: () => ["restoring"],
    });

    expect([...ids].sort()).toEqual([
      "bridged-b",
      "cached-a",
      "incoming-b",
      "opening",
      "remote-cached",
      "restoring",
      "shown-a",
      "terminal-only",
    ]);
  });

  const healthy = {
    projectViewManagers: () => [heldManager({ active: "shown" })],
    remoteViewWorkspaceIds: none,
    liveTerminalWorkspaceIds: none,
    openingWorkspaceIds: none,
    restoringWorkspaceIds: none,
  };

  it.each([
    "projectViewManagers",
    "remoteViewWorkspaceIds",
    "liveTerminalWorkspaceIds",
    "openingWorkspaceIds",
    "restoringWorkspaceIds",
  ] as const)("throws rather than answer without %s", (failing) => {
    const sources = {
      ...healthy,
      [failing]: () => {
        throw new Error(`${failing} unavailable`);
      },
    };

    expect(() => collectHeldWorkspaceIds(sources)).toThrow(`${failing} unavailable`);
  });

  it("throws rather than answer from a source that fails part-way through", () => {
    function* partial(): Generator<string> {
      yield "first";
      throw new Error("enumeration failed");
    }

    expect(() =>
      collectHeldWorkspaceIds({ ...healthy, liveTerminalWorkspaceIds: partial })
    ).toThrow("enumeration failed");
  });

  it.each(["getActiveProjectId", "getOutgoingBridgeProjectId", "getAllViews"] as const)(
    "throws when one window's manager cannot answer %s",
    (method) => {
      const disposing = {
        getActiveProjectId: () => null,
        getOutgoingBridgeProjectId: () => null,
        getAllViews: () => [],
        [method]: () => {
          throw new Error("disposed");
        },
      } as unknown as ProjectViewManager;

      expect(() =>
        collectHeldWorkspaceIds({
          ...healthy,
          projectViewManagers: () => [heldManager({ active: "shown" }), disposing],
        })
      ).toThrow("disposed");
    }
  );
});
