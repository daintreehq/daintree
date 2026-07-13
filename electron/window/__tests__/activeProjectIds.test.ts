import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { collectActiveProjectIds, projectViewManagersFrom } from "../activeProjectIds.js";
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

  it("deduplicates a project that is foreground in more than one window", () => {
    const windowOne = makePvm("proj-a");
    const windowTwo = makePvm("proj-a");

    const ids = collectActiveProjectIds(providerOf([windowOne, windowTwo]), "proj-a", "test");

    expect(ids.size).toBe(1);
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
