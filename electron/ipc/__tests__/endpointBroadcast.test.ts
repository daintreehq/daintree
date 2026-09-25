import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { localViews, hasProjectViewsMock, projectViewsMock } = vi.hoisted(() => ({
  localViews: [] as Array<{
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  }>,
  hasProjectViewsMock: vi.fn(() => false),
  projectViewsMock: vi.fn((_projectId: string) => [] as unknown[]),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => localViews),
  getWebContentsForProject: projectViewsMock,
  hasRegisteredProjectViews: hasProjectViewsMock,
  isCachedViewWebContents: vi.fn(() => false),
}));

import {
  broadcastToProjectRenderers,
  broadcastToProjectRenderersExcept,
  broadcastToRenderer,
  broadcastToVisibleRenderers,
  sendToRendererContext,
  typedBroadcast,
} from "../utils.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import type { ClientEndpoint, HostFrame } from "../endpoint.js";
import type { IpcContext } from "../types.js";

function endpoint(
  handle: number,
  projectId: string | null,
  kind: ClientEndpoint["kind"] = "remote-view"
): ClientEndpoint & { send: Mock<(frame: HostFrame) => void> } {
  return {
    endpointId: `${kind}:${handle}`,
    clientId: kind === "remote-view" ? "client-b" : "local",
    projectId,
    kind,
    handle,
    send: vi.fn<(frame: HostFrame) => void>(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

function localView(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn() };
}

beforeEach(() => {
  _resetEndpointRegistryForTesting();
  localViews.length = 0;
  hasProjectViewsMock.mockReset().mockReturnValue(false);
  projectViewsMock.mockReset().mockReturnValue([]);
});

describe("broadcast helpers with no remote endpoints", () => {
  it("deliver exactly as before and never enumerate endpoints", () => {
    const view = localView(1);
    localViews.push(view);
    const registry = getEndpointRegistry();
    registry.add(endpoint(1, "proj-1", "local-view"));
    const getRemote = vi.spyOn(registry, "getRemote");
    const getForProject = vi.spyOn(registry, "getForProject");
    hasProjectViewsMock.mockReturnValue(true);
    projectViewsMock.mockReturnValue([view]);

    broadcastToRenderer("a:b", 1);
    broadcastToVisibleRenderers("a:c", 2);
    typedBroadcast("a:d" as never, 3 as never);
    broadcastToProjectRenderers("proj-1", "terminal:data", "bytes");
    broadcastToProjectRenderersExcept(null, new Set([9]), "terminal:data", "bytes");

    expect(view.send.mock.calls).toEqual([
      ["a:b", 1],
      ["a:c", 2],
      ["a:d", 3],
      ["terminal:data", "bytes"],
      ["terminal:data", "bytes"],
    ]);
    expect(getRemote).not.toHaveBeenCalled();
    expect(getForProject).not.toHaveBeenCalled();
  });
});

describe("broadcast helpers with remote endpoints", () => {
  it("reach remote endpoints from the global helpers, never local-view endpoints twice", () => {
    const view = localView(1);
    localViews.push(view);
    const local = endpoint(1, "proj-1", "local-view");
    const remote = endpoint(-1, "proj-1");
    getEndpointRegistry().add(local);
    getEndpointRegistry().add(remote);

    broadcastToRenderer("a:b", 1);
    broadcastToVisibleRenderers("a:c", 2);
    typedBroadcast("a:d" as never, { x: 3 } as never);

    expect(remote.send.mock.calls).toEqual([
      [{ type: "event", channel: "a:b", args: [1] }],
      [{ type: "event", channel: "a:c", args: [2] }],
      [{ type: "event", channel: "a:d", args: [{ x: 3 }] }],
    ]);
    expect(local.send).not.toHaveBeenCalled();
    expect(view.send).toHaveBeenCalledTimes(3);
  });

  it("scope project broadcasts to the project's remote endpoints and honour exclusions", () => {
    hasProjectViewsMock.mockReturnValue(true);
    const inProject = endpoint(-1, "proj-1");
    const excluded = endpoint(-2, "proj-1");
    const otherProject = endpoint(-3, "proj-2");
    for (const ep of [inProject, excluded, otherProject]) getEndpointRegistry().add(ep);

    broadcastToProjectRenderersExcept("proj-1", new Set([-2]), "terminal:data", "id", "bytes");

    expect(inProject.send).toHaveBeenCalledWith({
      type: "event",
      channel: "terminal:data",
      args: ["id", "bytes"],
    });
    expect(excluded.send).not.toHaveBeenCalled();
    expect(otherProject.send).not.toHaveBeenCalled();
  });

  it("fall back to every remote endpoint when the project is unknown", () => {
    hasProjectViewsMock.mockReturnValue(true);
    const a = endpoint(-1, "proj-1");
    const b = endpoint(-2, null);
    getEndpointRegistry().add(a);
    getEndpointRegistry().add(b);

    broadcastToProjectRenderers(null, "x:y", 1);
    broadcastToProjectRenderersExcept(null, new Set([-2]), "x:z", 2);

    expect(a.send).toHaveBeenCalledTimes(2);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("keep delivering when one endpoint throws", () => {
    const broken = endpoint(-1, null);
    broken.send.mockImplementation(() => {
      throw new Error("link closing");
    });
    const healthy = endpoint(-2, null);
    getEndpointRegistry().add(broken);
    getEndpointRegistry().add(healthy);

    expect(() => broadcastToRenderer("a:b")).not.toThrow();
    expect(healthy.send).toHaveBeenCalledTimes(1);
  });
});

describe("sendToRendererContext", () => {
  it("pushes to the endpoint when a remote call has no window", () => {
    const remote = endpoint(-4, "proj-1");
    const ctx = { senderWindow: null, endpoint: remote } as unknown as IpcContext;

    sendToRendererContext(ctx, "x:reply", { ok: 1 });

    expect(remote.send).toHaveBeenCalledWith({
      type: "event",
      channel: "x:reply",
      args: [{ ok: 1 }],
    });
  });

  it("still drops a push for a local sender with no window", () => {
    const local = endpoint(7, null, "local-view");
    const ctx = { senderWindow: null, endpoint: local } as unknown as IpcContext;

    sendToRendererContext(ctx, "x:reply", 1);

    expect(local.send).not.toHaveBeenCalled();
  });
});
