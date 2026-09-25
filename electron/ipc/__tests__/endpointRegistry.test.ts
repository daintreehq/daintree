import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectOf } = vi.hoisted(() => ({ projectOf: new Map<number, string>() }));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getProjectForWebContents: (id: number) => projectOf.get(id) ?? null,
}));

import { EndpointRegistryImpl } from "../endpointRegistry.js";
import { _resetEndpointRegistryForTesting, getEndpointRegistry } from "../endpointRegistry.js";
import {
  _resetLocalEndpointsForTesting,
  disposeLocalEndpoint,
  getLocalEndpoint,
} from "../localEndpoint.js";
import type { ClientEndpoint } from "../endpoint.js";

function remote(handle: number, projectId: string | null) {
  const closeListeners = new Set<() => void>();
  let closed = false;
  const endpoint: ClientEndpoint = {
    endpointId: `r${handle}`,
    clientId: "c",
    projectId,
    kind: "remote-view",
    handle,
    send: vi.fn(),
    request: vi.fn(),
    onClose: (cb) => {
      closeListeners.add(cb);
      return { dispose: () => closeListeners.delete(cb) };
    },
    isClosed: () => closed,
  };
  const close = () => {
    closed = true;
    for (const cb of closeListeners) cb();
  };
  return { endpoint, close };
}

function fakeWebContents(id: number) {
  const listeners = new Map<string, () => void>();
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: (event: string, cb: () => void) => listeners.set(event, cb),
    destroy: () => listeners.get("destroyed")?.(),
  };
}

beforeEach(() => {
  projectOf.clear();
  _resetEndpointRegistryForTesting();
  _resetLocalEndpointsForTesting();
});

describe("EndpointRegistryImpl", () => {
  it("indexes by id, handle and project, and drops an endpoint when it closes", () => {
    const registry = new EndpointRegistryImpl();
    const onChange = vi.fn();
    registry.onChange(onChange);
    const a = remote(-1, "p1");
    const b = remote(-2, "p2");
    registry.add(a.endpoint);
    registry.add(b.endpoint);

    expect(registry.get("r-1")).toBe(a.endpoint);
    expect(registry.getByHandle(-2)).toBe(b.endpoint);
    expect(registry.getForProject("p1")).toEqual([a.endpoint]);
    expect(registry.getRemote()).toHaveLength(2);
    expect(registry.hasRemote()).toBe(true);

    a.close();
    expect(registry.get("r-1")).toBeUndefined();
    expect(registry.getByHandle(-1)).toBeUndefined();
    b.close();
    expect(registry.hasRemote()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("rebinds a remote endpoint to another project", () => {
    const registry = new EndpointRegistryImpl();
    const a = remote(-1, "p1");
    registry.add(a.endpoint);
    registry.rebind("r-1", "p2");
    expect(registry.getForProject("p1")).toEqual([]);
    expect(registry.getForProject("p2")).toEqual([a.endpoint]);
  });
});

describe("local view endpoints", () => {
  it("wrap a WebContents, follow its project binding and dispose on destroy", () => {
    const wc = fakeWebContents(12);
    projectOf.set(12, "p1");
    const endpoint = getLocalEndpoint(wc as never);

    expect(endpoint).toMatchObject({ endpointId: "local:12", handle: 12, kind: "local-view" });
    expect(getLocalEndpoint(wc as never)).toBe(endpoint);
    expect(getEndpointRegistry().getForProject("p1")).toEqual([endpoint]);
    expect(getEndpointRegistry().hasRemote()).toBe(false);

    projectOf.set(12, "p2");
    expect(endpoint.projectId).toBe("p2");

    endpoint.send({ type: "event", channel: "a:b", args: [1, 2] });
    expect(wc.send).toHaveBeenCalledWith("a:b", 1, 2);

    wc.destroy();
    expect(endpoint.isClosed()).toBe(true);
    expect(getEndpointRegistry().getByHandle(12)).toBeUndefined();
    endpoint.send({ type: "event", channel: "a:b", args: [] });
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it("never registers a sender that is already destroyed", () => {
    const wc = { ...fakeWebContents(14), isDestroyed: () => true };
    const endpoint = getLocalEndpoint(wc as never);
    expect(endpoint.isClosed()).toBe(true);
    expect(getEndpointRegistry().getByHandle(14)).toBeUndefined();
  });

  it("reject server-to-client requests as unsupported", async () => {
    const endpoint = getLocalEndpoint(fakeWebContents(13) as never);
    await expect(endpoint.request("mcp:dispatch-action", {})).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    disposeLocalEndpoint(13);
    expect(endpoint.isClosed()).toBe(true);
  });
});
