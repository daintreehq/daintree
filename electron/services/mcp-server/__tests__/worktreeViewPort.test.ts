import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cachedViews } = vi.hoisted(() => ({ cachedViews: new Set<number>() }));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  isCachedViewWebContents: (id: number) => cachedViews.has(id),
}));

import { routedViewWorktreePort } from "../worktreeViewPort.js";
import { setWorkspaceClientRef, setWorktreePortBrokerRef } from "../../../window/serviceRefs.js";
import type { WorkspaceClient } from "../../WorkspaceClient.js";
import type { WorktreePortBroker, WorktreePortHost } from "../../WorktreePortBroker.js";

const PROJECT = { kind: "project" as const, workspaceId: "p1", workspacePath: "/repo" };

function makeBroker(options: { hasPort?: boolean; confirmed?: boolean } = {}) {
  return {
    hasPort: vi.fn(() => options.hasPort ?? false),
    brokerPort: vi.fn((_host: WorktreePortHost) => true),
    waitForConfirmation: vi.fn(async () => options.confirmed ?? true),
    closePortsForView: vi.fn(),
  };
}

function wc(id: number) {
  return { id } as unknown as Electron.WebContents;
}

describe("routedViewWorktreePort (#13348)", () => {
  const localHost: WorktreePortHost = { projectPath: "/repo", attachWorktreePort: () => true };
  let broker: ReturnType<typeof makeBroker>;
  let getHostForProject: ReturnType<typeof vi.fn>;

  function install(next: ReturnType<typeof makeBroker>): void {
    broker = next;
    setWorktreePortBrokerRef(next as unknown as WorktreePortBroker);
  }

  beforeEach(() => {
    cachedViews.clear();
    getHostForProject = vi.fn((path: string) => (path === "/repo" ? localHost : undefined));
    setWorkspaceClientRef({ getHostForProject } as unknown as WorkspaceClient);
    install(makeBroker());
  });

  afterEach(() => {
    setWorktreePortBrokerRef(null);
    setWorkspaceClientRef(null);
  });

  describe("prepare", () => {
    it("leaves a view that is not cached alone — activation owns its port", async () => {
      // Re-posting there would replace a port the startup path is still
      // waiting to have confirmed.
      await expect(routedViewWorktreePort.prepare(wc(1), PROJECT)).resolves.toBe(true);
      expect(broker.brokerPort).not.toHaveBeenCalled();
      expect(broker.waitForConfirmation).not.toHaveBeenCalled();
    });

    it("posts a cached view a port from its own project's host and waits for the receipt", async () => {
      cachedViews.add(1);
      const view = wc(1);

      await expect(routedViewWorktreePort.prepare(view, PROJECT)).resolves.toBe(true);

      expect(getHostForProject).toHaveBeenCalledWith("/repo");
      expect(broker.brokerPort).toHaveBeenCalledWith(localHost, view);
      expect(broker.waitForConfirmation).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("joins a port another dispatch already restored instead of replacing it", async () => {
      // A second post would retire the unconfirmed first one and fail the
      // confirmation that dispatch is waiting on.
      cachedViews.add(1);
      install(makeBroker({ hasPort: true }));

      await expect(routedViewWorktreePort.prepare(wc(1), PROJECT)).resolves.toBe(true);

      expect(broker.brokerPort).not.toHaveBeenCalled();
      expect(broker.waitForConfirmation).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("reports a port the renderer never confirmed", async () => {
      cachedViews.add(1);
      install(makeBroker({ confirmed: false }));

      await expect(routedViewWorktreePort.prepare(wc(1), PROJECT)).resolves.toBe(false);
    });

    it("hands the broker a refusing host when no local host serves the view's path", async () => {
      // A remote view's path is not served here: the broker's host override
      // swaps in its relay. A local view whose host is gone must not be given
      // another project's port instead.
      cachedViews.add(1);
      const elsewhere = { ...PROJECT, workspacePath: "/remote/repo" };
      broker.brokerPort.mockImplementation((host) => host.attachWorktreePort({} as never));

      await expect(routedViewWorktreePort.prepare(wc(1), elsewhere)).resolves.toBe(false);

      const [host] = broker.brokerPort.mock.calls[0];
      expect(host).not.toBe(localHost);
      expect(broker.waitForConfirmation).not.toHaveBeenCalled();
    });

    it("skips a scratch workspace, which has no worktree store", async () => {
      cachedViews.add(1);

      await expect(
        routedViewWorktreePort.prepare(wc(1), { ...PROJECT, kind: "scratch" })
      ).resolves.toBe(true);
      expect(broker.brokerPort).not.toHaveBeenCalled();
    });

    it("reports failure with no broker to ask", async () => {
      cachedViews.add(1);
      setWorktreePortBrokerRef(null);

      await expect(routedViewWorktreePort.prepare(wc(1), PROJECT)).resolves.toBe(false);
    });
  });

  describe("release", () => {
    it("closes a still-cached view's port again (#6273)", () => {
      cachedViews.add(1);

      routedViewWorktreePort.release(1);

      expect(broker.closePortsForView).toHaveBeenCalledWith(1);
    });

    it("keeps the port of a view brought to the foreground meanwhile", () => {
      routedViewWorktreePort.release(1);

      expect(broker.closePortsForView).not.toHaveBeenCalled();
    });
  });
});
