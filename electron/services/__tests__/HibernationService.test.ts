import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { logInfo, logError } from "../../utils/logger.js";
import { HibernationService } from "../HibernationService.js";
import type { ProjectViewManager } from "../../window/ProjectViewManager.js";

describe("HibernationService renderer eviction (#10668)", () => {
  type ProjectViewManagerMock = {
    getActiveProjectId: Mock<() => string | null>;
    getOutgoingBridgeProjectId: Mock<() => string | null>;
    destroyView: Mock<(projectId: string, options?: { protectMcpDispatch?: boolean }) => boolean>;
  };

  function makeManager(
    activeProjectId: string | null = null,
    outgoingBridgeProjectId: string | null = null
  ): ProjectViewManagerMock {
    return {
      getActiveProjectId: vi.fn(() => activeProjectId),
      getOutgoingBridgeProjectId: vi.fn(() => outgoingBridgeProjectId),
      destroyView: vi.fn(() => true),
    };
  }

  function makeServiceWithManagers(managers: ProjectViewManagerMock[]): HibernationService {
    const service = new HibernationService();
    service.setProjectViewManagersProvider(() => managers as unknown as ProjectViewManager[]);
    return service;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evicts the cached renderer on every window where the project is not active", () => {
    const background = makeManager("other-proj");
    const alsoBackground = makeManager(null);
    const service = makeServiceWithManagers([background, alsoBackground]);

    expect(service.evictProjectRenderer("proj-1")).toBe(2);

    expect(background.destroyView).toHaveBeenCalledWith("proj-1");
    expect(alsoBackground.destroyView).toHaveBeenCalledWith("proj-1");
  });

  it("hands an automatic sleep's MCP-dispatch guard to every window (#13845)", () => {
    const background = makeManager("other-proj");
    const alsoBackground = makeManager(null);
    background.destroyView.mockReturnValue(false);
    const service = makeServiceWithManagers([background, alsoBackground]);

    const evicted = service.evictProjectRenderer("proj-1", { protectMcpDispatch: true });

    // A window that kept its view because a dispatch is waiting on it doesn't count.
    expect(evicted).toBe(1);
    expect(background.destroyView).toHaveBeenCalledWith("proj-1", { protectMcpDispatch: true });
    expect(alsoBackground.destroyView).toHaveBeenCalledWith("proj-1", {
      protectMcpDispatch: true,
    });
  });

  it("skips the window where the project is the active/foreground view", () => {
    const foreground = makeManager("proj-1");
    const background = makeManager("other-proj");
    const service = makeServiceWithManagers([foreground, background]);

    expect(service.evictProjectRenderer("proj-1")).toBe(1);

    expect(foreground.destroyView).not.toHaveBeenCalled();
    expect(background.destroyView).toHaveBeenCalledWith("proj-1");
  });

  it("skips the window where the project is the outgoing paint-gate bridge", () => {
    // Mid cold-switch: activeProjectId is already the incoming project, but
    // proj-1 is still painted as the anti-flash bridge. Destroying it would
    // expose a blank frame — it must be skipped like the active view.
    const switching = makeManager("incoming-proj", "proj-1");
    const service = makeServiceWithManagers([switching]);

    expect(service.evictProjectRenderer("proj-1")).toBe(0);

    expect(switching.destroyView).not.toHaveBeenCalled();
  });

  it("continues evicting other windows when one destroyView throws", () => {
    const failing = makeManager(null);
    failing.destroyView.mockImplementation(() => {
      throw new Error("boom");
    });
    const healthy = makeManager(null);
    const service = makeServiceWithManagers([failing, healthy]);

    expect(service.evictProjectRenderer("proj-1")).toBe(1);

    expect(failing.destroyView).toHaveBeenCalledWith("proj-1");
    expect(healthy.destroyView).toHaveBeenCalledWith("proj-1");
    expect(logError).toHaveBeenCalledWith(
      "user-initiated-hibernate-evict-failed",
      expect.any(Error),
      { projectId: "proj-1" }
    );
  });

  it("continues to the next window when a guard accessor throws", () => {
    const failing = makeManager(null);
    failing.getActiveProjectId.mockImplementation(() => {
      throw new Error("registry torn down");
    });
    const healthy = makeManager(null);
    const service = makeServiceWithManagers([failing, healthy]);

    service.evictProjectRenderer("proj-1");

    expect(failing.destroyView).not.toHaveBeenCalled();
    expect(healthy.destroyView).toHaveBeenCalledWith("proj-1");
  });

  it("returns 0 without throwing when the provider throws", () => {
    const service = new HibernationService();
    service.setProjectViewManagersProvider(() => {
      throw new Error("windowRegistry tearing down");
    });

    expect(service.evictProjectRenderer("proj-1")).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "user-initiated-hibernate-evict-provider-failed",
      expect.any(Error),
      { projectId: "proj-1" }
    );
  });

  it("counts only windows that actually had a cached view", () => {
    const withView = makeManager(null);
    withView.destroyView.mockReturnValue(true);
    const withoutView = makeManager(null);
    withoutView.destroyView.mockReturnValue(false);
    const service = makeServiceWithManagers([withView, withoutView]);

    service.evictProjectRenderer("proj-1");

    expect(logInfo).toHaveBeenCalledWith("user-initiated-hibernate-renderer-evicted", {
      projectId: "proj-1",
      evictedViewCount: 1,
    });
  });

  it("logs nothing when no window had a cached view", () => {
    const withoutView = makeManager(null);
    withoutView.destroyView.mockReturnValue(false);
    const service = makeServiceWithManagers([withoutView]);

    expect(service.evictProjectRenderer("proj-1")).toBe(0);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("returns 0 when no provider is wired", () => {
    expect(new HibernationService().evictProjectRenderer("proj-1")).toBe(0);
  });
});
