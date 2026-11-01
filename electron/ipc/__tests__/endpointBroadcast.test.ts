import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { localViews, hasProjectViewsMock, projectViewsMock, registeredViewsMock } = vi.hoisted(
  () => ({
    localViews: [] as Array<{
      id: number;
      isDestroyed: () => boolean;
      send: ReturnType<typeof vi.fn>;
    }>,
    hasProjectViewsMock: vi.fn(() => false),
    projectViewsMock: vi.fn((_projectId: string) => [] as unknown[]),
    registeredViewsMock: vi.fn(() => [] as unknown[]),
  })
);

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
  getRegisteredProjectViews: registeredViewsMock,
  isCachedViewWebContents: vi.fn(() => false),
}));

import {
  broadcastSlicedToProjectRenderers,
  broadcastToProjectRenderers,
  getProjectPushTargets,
  broadcastToProjectRenderersExcept,
  broadcastToRemoteEndpoints,
  broadcastToRenderer,
  broadcastToVisibleRenderers,
  sendToRenderer,
  sendToRendererContext,
  setRemoteBoundViewFilter,
  typedBroadcast,
  typedSend,
} from "../utils.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import type { ClientEndpoint, EndpointGroup, HostFrame } from "../endpoint.js";
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

function group(): EndpointGroup & { sendToAll: Mock<(frame: HostFrame) => void> } {
  return { sendToAll: vi.fn<(frame: HostFrame) => void>() };
}

function grouped(handle: number, projectId: string | null, of: EndpointGroup) {
  return Object.assign(endpoint(handle, projectId), { group: of });
}

function localView(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn() };
}

beforeEach(() => {
  _resetEndpointRegistryForTesting();
  localViews.length = 0;
  hasProjectViewsMock.mockReset().mockReturnValue(false);
  projectViewsMock.mockReset().mockReturnValue([]);
  registeredViewsMock.mockReset().mockReturnValue([]);
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

  it("scope remote endpoints by project on a windowless host with no local views", () => {
    const a = endpoint(-1, "proj-a");
    const b = endpoint(-2, "proj-b");
    getEndpointRegistry().add(a);
    getEndpointRegistry().add(b);

    broadcastToProjectRenderers("proj-a", "terminal:data", "a-bytes");
    broadcastToProjectRenderersExcept("proj-b", new Set([9]), "terminal:data", "b-bytes");

    expect(a.send.mock.calls).toEqual([
      [{ type: "event", channel: "terminal:data", args: ["a-bytes"] }],
    ]);
    expect(b.send.mock.calls).toEqual([
      [{ type: "event", channel: "terminal:data", args: ["b-bytes"] }],
    ]);
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

describe("broadcast helpers with a link session's grouped endpoints (#15902)", () => {
  it("push each session once from the global helpers, and ungrouped endpoints one by one", () => {
    const studio = group();
    const laptop = group();
    const a = grouped(-1, "proj-1", studio);
    const b = grouped(-2, "proj-2", studio);
    const c = grouped(-3, "proj-1", laptop);
    const loose = endpoint(-4, "proj-1");
    for (const ep of [a, b, c, loose]) getEndpointRegistry().add(ep);

    broadcastToRenderer("a:b", 1);
    broadcastToVisibleRenderers("a:c", 2);
    typedBroadcast("a:d" as never, { x: 3 } as never);
    broadcastToRemoteEndpoints("events:push", [{ name: "system:wake", payload: {} }]);

    const expected = [
      [{ type: "event", channel: "a:b", args: [1] }],
      [{ type: "event", channel: "a:c", args: [2] }],
      [{ type: "event", channel: "a:d", args: [{ x: 3 }] }],
      [{ type: "event", channel: "events:push", args: [{ name: "system:wake", payload: {} }] }],
    ];
    expect(studio.sendToAll.mock.calls).toEqual(expected);
    expect(laptop.sendToAll.mock.calls).toEqual(expected);
    expect(loose.send.mock.calls).toEqual(expected);
    for (const ep of [a, b, c]) expect(ep.send).not.toHaveBeenCalled();
  });

  it("address each grouped endpoint for project-scoped and excluding pushes", () => {
    hasProjectViewsMock.mockReturnValue(true);
    const studio = group();
    const a = grouped(-1, "proj-1", studio);
    const b = grouped(-2, "proj-1", studio);
    const c = grouped(-3, "proj-2", studio);
    for (const ep of [a, b, c]) getEndpointRegistry().add(ep);

    broadcastToProjectRenderers("proj-1", "terminal:data", "one");
    broadcastToProjectRenderersExcept(null, new Set([-2]), "terminal:data", "all-but-b");

    expect(studio.sendToAll).not.toHaveBeenCalled();
    expect(a.send.mock.calls.map(([frame]) => frame.args)).toEqual([["one"], ["all-but-b"]]);
    expect(b.send.mock.calls.map(([frame]) => frame.args)).toEqual([["one"]]);
    expect(c.send.mock.calls.map(([frame]) => frame.args)).toEqual([["all-but-b"]]);
  });

  it("keep delivering to other sessions when one session's push throws", () => {
    const broken = group();
    broken.sendToAll.mockImplementation(() => {
      throw new Error("link closing");
    });
    const healthy = group();
    getEndpointRegistry().add(grouped(-1, null, broken));
    getEndpointRegistry().add(grouped(-2, null, broken));
    getEndpointRegistry().add(grouped(-3, null, healthy));

    expect(() => broadcastToRenderer("a:b")).not.toThrow();
    expect(broken.sendToAll).toHaveBeenCalledTimes(1);
    expect(healthy.sendToAll).toHaveBeenCalledTimes(1);
  });
});

describe("remote-bound view filter", () => {
  it("withholds a push only from the views the filter refuses, across every local helper", () => {
    const remoteBound = localView(1);
    const local = localView(2);
    localViews.push(remoteBound, local);
    hasProjectViewsMock.mockReturnValue(true);
    projectViewsMock.mockReturnValue([remoteBound, local]);
    const filter = vi.fn((webContentsId: number, channel: string) => {
      return webContentsId !== 1 || channel === "shell:ok";
    });
    const uninstall = setRemoteBoundViewFilter(filter);

    broadcastToRenderer("host:thing", 1);
    broadcastToVisibleRenderers("host:thing", 2);
    broadcastToProjectRenderers("proj-1", "host:thing", 3);
    broadcastToRenderer("shell:ok", 4);

    expect(remoteBound.send.mock.calls).toEqual([["shell:ok", 4]]);
    expect(local.send).toHaveBeenCalledTimes(4);
    expect(filter).toHaveBeenCalledWith(1, "host:thing", [3]);

    uninstall();
    broadcastToRenderer("host:thing", 5);
    expect(remoteBound.send).toHaveBeenLastCalledWith("host:thing", 5);
  });

  it("applies to the per-window and typed helpers as well", () => {
    const remoteBound = localView(1);
    const local = localView(2);
    localViews.push(remoteBound, local);
    const windowOf = (view: ReturnType<typeof localView>) => {
      vi.mocked(getAppWebContents).mockReturnValueOnce(view as never);
      return { isDestroyed: () => false } as never;
    };
    const uninstall = setRemoteBoundViewFilter(
      (webContentsId, channel) => webContentsId !== 1 || channel === "shell:ok"
    );

    sendToRenderer(windowOf(remoteBound), "host:thing", 1);
    sendToRenderer(windowOf(remoteBound), "shell:ok", 2);
    sendToRenderer(windowOf(local), "host:thing", 3);
    typedSend(windowOf(remoteBound), "worktree:update" as never, {} as never);
    typedBroadcast("worktree:update" as never, { n: 4 } as never);

    expect(remoteBound.send.mock.calls).toEqual([["shell:ok", 2]]);
    expect(local.send.mock.calls).toEqual([
      ["host:thing", 3],
      ["worktree:update", { n: 4 }],
    ]);
    uninstall();
  });

  it("only clears the filter it installed", () => {
    const view = localView(1);
    localViews.push(view);
    const first = setRemoteBoundViewFilter(() => false);
    const second = setRemoteBoundViewFilter(() => false);
    first();
    broadcastToRenderer("a:b");
    expect(view.send).not.toHaveBeenCalled();
    second();
    broadcastToRenderer("a:b");
    expect(view.send).toHaveBeenCalledTimes(1);
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

describe("getProjectPushTargets", () => {
  it("adds the project's remote views to its local ones, as stable targets", () => {
    const view = localView(1);
    hasProjectViewsMock.mockReturnValue(true);
    projectViewsMock.mockReturnValue([view]);
    const mine = endpoint(-1, "proj-1");
    const other = endpoint(-2, "proj-2");
    getEndpointRegistry().add(mine);
    getEndpointRegistry().add(other);
    getEndpointRegistry().add(endpoint(5, "proj-1", "local-view"));

    const targets = getProjectPushTargets("proj-1", "plugin-push:batch");
    expect(targets.map((t) => t.id)).toEqual([1, -1]);
    expect(getProjectPushTargets("proj-1", "plugin-push:batch")[1]).toBe(targets[1]);

    targets[1]!.send("plugin-push:batch", [["plugin:a:x", {}]]);
    expect(mine.send).toHaveBeenCalledWith({
      type: "event",
      channel: "plugin-push:batch",
      args: [[["plugin:a:x", {}]]],
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("reaches every remote view for an app-global scope", () => {
    getEndpointRegistry().add(endpoint(-1, "proj-1"));
    getEndpointRegistry().add(endpoint(-2, null));
    expect(getProjectPushTargets(null, "plugin-push:batch").map((t) => t.id)).toEqual([-1, -2]);
  });

  it("drops a local view the remote-bound filter withholds", () => {
    const shown = localView(1);
    const bound = localView(2);
    localViews.push(shown, bound);
    const off = setRemoteBoundViewFilter((id) => id !== 2);
    try {
      expect(getProjectPushTargets(null, "plugin-push:batch").map((t) => t.id)).toEqual([1]);
    } finally {
      off();
    }
  });
});

describe("broadcastSlicedToProjectRenderers with remote endpoints", () => {
  const wrap = (slice: Record<string, number>) => ({ slice });

  it("gives each remote view its own project's slice beside local views", () => {
    const view = localView(1);
    hasProjectViewsMock.mockReturnValue(true);
    registeredViewsMock.mockReturnValue([{ webContents: view, projectId: "proj-1" }]);
    const remote = endpoint(-1, "proj-2");
    getEndpointRegistry().add(remote);

    broadcastSlicedToProjectRenderers(
      "terminal:resource-metrics",
      { a: 1, b: 2, c: 3 },
      (key) => ({ a: "proj-1", b: "proj-2" })[key] ?? null,
      wrap
    );

    expect(view.send).toHaveBeenCalledWith("terminal:resource-metrics", { slice: { a: 1, c: 3 } });
    expect(remote.send).toHaveBeenCalledWith({
      type: "event",
      channel: "terminal:resource-metrics",
      args: [{ slice: { b: 2, c: 3 } }],
    });
  });

  it("scopes remote views by project even when this machine has no project views", () => {
    const remote = endpoint(-1, "proj-2");
    getEndpointRegistry().add(remote);
    broadcastSlicedToProjectRenderers(
      "terminal:resource-metrics",
      { a: 1, b: 2 },
      (key) => ({ a: "proj-1", b: "proj-2" })[key] ?? null,
      wrap
    );
    // proj-1 has no audience here, so its entry is shared.
    expect(remote.send).toHaveBeenCalledWith({
      type: "event",
      channel: "terminal:resource-metrics",
      args: [{ slice: { b: 2, a: 1 } }],
    });
  });

  it("withholds the batch from a local view bound to a remote host", () => {
    const shown = localView(1);
    const bound = localView(2);
    hasProjectViewsMock.mockReturnValue(true);
    registeredViewsMock.mockReturnValue([
      { webContents: shown, projectId: "proj-1" },
      { webContents: bound, projectId: "proj-1" },
    ]);
    const off = setRemoteBoundViewFilter((id) => id !== 2);
    try {
      broadcastSlicedToProjectRenderers(
        "terminal:resource-metrics",
        { a: 1 },
        () => "proj-1",
        wrap
      );
    } finally {
      off();
    }
    expect(shown.send).toHaveBeenCalled();
    expect(bound.send).not.toHaveBeenCalled();
  });
});
