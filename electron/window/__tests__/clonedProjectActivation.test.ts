import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types/project.js";

const h = vi.hoisted(() => ({
  windows: [] as Array<{
    windowId: number;
    browserWindow: { isDestroyed: () => boolean };
    services: { projectViewManager?: unknown };
  }>,
  workspace: null as null | {
    loadProject: ReturnType<typeof vi.fn>;
    unregisterWindow: ReturnType<typeof vi.fn>;
    isWindowAttached: ReturnType<typeof vi.fn>;
    attachDirectPort: ReturnType<typeof vi.fn>;
    getHostForProject: ReturnType<typeof vi.fn>;
  },
  broker: { brokerPort: vi.fn() },
  pending: new Map<number, string[]>(),
  presenceListeners: new Set<() => void>(),
}));

vi.mock("../windowRef.js", () => ({
  getWindowRegistry: () => ({ all: () => h.windows }),
}));
vi.mock("../serviceRefs.js", () => ({
  getWorkspaceClientRef: () => h.workspace,
  getWorktreePortBrokerRef: () => h.broker,
}));
vi.mock("../projectActivationClaims.js", () => ({
  getPendingActivationProjectIds: (windowId: number) => h.pending.get(windowId) ?? [],
}));
vi.mock("../projectPresenceChanges.js", () => ({
  onProjectPresenceChanged: (listener: () => void) => {
    h.presenceListeners.add(listener);
    return () => h.presenceListeners.delete(listener);
  },
}));

import { loadClonedProjectInWindows } from "../clonedProjectActivation.js";

const project: Project = {
  id: "p-clone",
  path: "/work/widgets",
  name: "widgets",
  emoji: "🧩",
  lastOpened: 1,
};

const VIEW = { isDestroyed: () => false };

function pvm(active: string | null) {
  const manager = {
    active,
    getActiveProjectId: vi.fn(() => manager.active),
    getActiveView: vi.fn(() => ({ webContents: VIEW })),
    releaseCachedView: vi.fn(() => true),
  };
  return manager;
}

function windowOf(windowId: number, manager: ReturnType<typeof pvm>) {
  return {
    windowId,
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: manager },
  };
}

/** A claim is released: what the claims module announces. */
function settleClaims(windowId: number): void {
  h.pending.delete(windowId);
  for (const listener of [...h.presenceListeners]) listener();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("loadClonedProjectInWindows (#16352)", () => {
  beforeEach(() => {
    h.windows = [];
    h.pending.clear();
    h.presenceListeners.clear();
    h.broker.brokerPort.mockReset();
    h.workspace = {
      loadProject: vi.fn().mockResolvedValue("cold"),
      unregisterWindow: vi.fn(),
      // A load that resolves leaves the window attached, as the pool does.
      isWindowAttached: vi.fn(() => true),
      attachDirectPort: vi.fn(),
      getHostForProject: vi.fn(() => ({ id: "host" })),
    };
  });

  it("loads the workspace for every window showing the project", async () => {
    const showing = pvm("p-clone");
    h.windows = [windowOf(1, showing)];

    await loadClonedProjectInWindows(project);

    expect(h.workspace!.loadProject).toHaveBeenCalledExactlyOnceWith("/work/widgets", 1);
    expect(showing.releaseCachedView).not.toHaveBeenCalled();
  });

  it("lets a window holding it in its cache open it fresh next time", async () => {
    const elsewhere = pvm("p-other");
    h.windows = [windowOf(2, elsewhere)];

    await loadClonedProjectInWindows(project);

    expect(elsewhere.releaseCachedView).toHaveBeenCalledWith("p-clone");
    expect(h.workspace!.loadProject).not.toHaveBeenCalled();
  });

  it("never loads a second workspace over a switch that started during its load", async () => {
    const showing = pvm("p-clone");
    h.windows = [windowOf(1, showing)];
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

  describe("a window with a switch in flight", () => {
    it("waits for the switch, then loads and hands the view its ports if it stayed", async () => {
      h.windows = [windowOf(1, pvm("p-clone"))];
      h.pending.set(1, ["p-next"]);

      await loadClonedProjectInWindows(project);
      // The switch may already have asked for its own workspace.
      expect(h.workspace!.loadProject).not.toHaveBeenCalled();

      // It failed before activating anything: the window still shows the clone.
      settleClaims(1);
      await flush();

      expect(h.workspace!.loadProject).toHaveBeenCalledExactlyOnceWith("/work/widgets", 1);
      expect(h.workspace!.attachDirectPort).toHaveBeenCalledWith(1, VIEW);
      expect(h.broker.brokerPort).toHaveBeenCalledWith({ id: "host" }, VIEW);
      expect(h.presenceListeners.size).toBe(0);
    });

    it("leaves the window to a switch that went elsewhere", async () => {
      const manager = pvm("p-clone");
      h.windows = [windowOf(1, manager)];
      h.pending.set(1, ["p-next"]);

      await loadClonedProjectInWindows(project);
      manager.active = "p-next";
      settleClaims(1);
      await flush();

      expect(h.workspace!.loadProject).not.toHaveBeenCalled();
    });

    it("tries again when a newer switch overtook its load", async () => {
      h.windows = [windowOf(1, pvm("p-clone"))];
      h.pending.set(1, ["p-next"]);
      await loadClonedProjectInWindows(project);
      // The first load is superseded: another switch claims the window meanwhile.
      h.workspace!.loadProject.mockImplementationOnce(async () => {
        h.pending.set(1, ["p-other"]);
        return "cold";
      });

      settleClaims(1);
      await flush();
      expect(h.workspace!.attachDirectPort).not.toHaveBeenCalled();

      // That switch fails and rolls back: the window still shows the clone.
      settleClaims(1);
      await flush();

      expect(h.workspace!.loadProject).toHaveBeenCalledTimes(2);
      expect(h.workspace!.attachDirectPort).toHaveBeenCalledExactlyOnceWith(1, VIEW);
      expect(h.presenceListeners.size).toBe(0);
    });

    it("tries again at once when the overtaking switch settled before its load did", async () => {
      h.windows = [windowOf(1, pvm("p-clone"))];
      h.pending.set(1, ["p-next"]);
      await loadClonedProjectInWindows(project);
      let attached = true;
      h.workspace!.isWindowAttached.mockImplementation(() => attached);
      // A newer switch takes the window and fails before this load resolves:
      // the load lands detached, and the rollback re-attaches without a word.
      h.workspace!.loadProject.mockImplementationOnce(async () => {
        attached = false;
        return "cold";
      });
      h.workspace!.loadProject.mockImplementationOnce(async () => {
        attached = true;
        return "warm";
      });

      settleClaims(1);
      await flush();

      expect(h.workspace!.loadProject).toHaveBeenCalledTimes(2);
      expect(h.workspace!.attachDirectPort).toHaveBeenCalledExactlyOnceWith(1, VIEW);
      expect(h.presenceListeners.size).toBe(0);
    });
  });
});
