import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types/project.js";

const h = vi.hoisted(() => ({
  windows: [] as Array<{ windowId: number; services: { projectViewManager?: unknown } }>,
  workspace: null as null | {
    loadProject: ReturnType<typeof vi.fn>;
    unregisterWindow: ReturnType<typeof vi.fn>;
  },
  pending: new Map<number, string[]>(),
}));

vi.mock("../windowRef.js", () => ({
  getWindowRegistry: () => ({ all: () => h.windows }),
}));
vi.mock("../serviceRefs.js", () => ({ getWorkspaceClientRef: () => h.workspace }));
vi.mock("../projectActivationClaims.js", () => ({
  getPendingActivationProjectIds: (windowId: number) => h.pending.get(windowId) ?? [],
}));

import { loadClonedProjectInWindows } from "../clonedProjectActivation.js";

const project: Project = {
  id: "p-clone",
  path: "/work/widgets",
  name: "widgets",
  emoji: "🧩",
  lastOpened: 1,
};

function pvm(active: string | null) {
  return {
    active,
    getActiveProjectId: vi.fn(function (this: { active: string | null }) {
      return this.active;
    }),
    releaseCachedView: vi.fn(() => true),
  };
}

describe("loadClonedProjectInWindows (#16352)", () => {
  beforeEach(() => {
    h.windows = [];
    h.pending.clear();
    h.workspace = {
      loadProject: vi.fn().mockResolvedValue("cold"),
      unregisterWindow: vi.fn(),
    };
  });

  it("loads the workspace for every window showing the project", async () => {
    const showing = pvm("p-clone");
    h.windows = [{ windowId: 1, services: { projectViewManager: showing } }];

    await loadClonedProjectInWindows(project);

    expect(h.workspace!.loadProject).toHaveBeenCalledExactlyOnceWith("/work/widgets", 1);
    expect(showing.releaseCachedView).not.toHaveBeenCalled();
  });

  it("lets a window holding it in its cache open it fresh next time", async () => {
    const elsewhere = pvm("p-other");
    h.windows = [{ windowId: 2, services: { projectViewManager: elsewhere } }];

    await loadClonedProjectInWindows(project);

    expect(elsewhere.releaseCachedView).toHaveBeenCalledWith("p-clone");
    expect(h.workspace!.loadProject).not.toHaveBeenCalled();
  });

  it("leaves a window with a switch in flight to that switch", async () => {
    h.windows = [{ windowId: 1, services: { projectViewManager: pvm("p-clone") } }];
    h.pending.set(1, ["p-next"]);

    await loadClonedProjectInWindows(project);

    expect(h.workspace!.loadProject).not.toHaveBeenCalled();
  });

  it("never loads a second workspace over a switch that started during its load", async () => {
    const showing = pvm("p-clone");
    h.windows = [{ windowId: 1, services: { projectViewManager: showing } }];
    h.workspace!.loadProject.mockImplementation(async () => {
      // The window moves on while the host loads; that switch's own load is
      // newer and owns the mapping.
      showing.active = "p-next";
      return "cold";
    });

    await loadClonedProjectInWindows(project);

    expect(h.workspace!.loadProject).toHaveBeenCalledTimes(1);
    expect(h.workspace!.unregisterWindow).not.toHaveBeenCalled();
  });
});
