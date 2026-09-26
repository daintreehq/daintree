import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectActiveProjectIds } from "../../../window/activeProjectIds.js";
import { _resetRemoteServicesForTest, getRemoteService } from "../../runtime.js";
import {
  ENDPOINT_VISIBILITY_METHOD,
  EndpointVisibility,
  ViewVisibilityReporter,
  installEndpointVisibility,
} from "../visibility.js";

interface FakeEndpoint {
  endpointId: string;
  projectId: string | null;
  kind: "remote-view";
  closed: boolean;
  isClosed(): boolean;
}

function fakeRegistry() {
  const endpoints = new Map<string, FakeEndpoint>();
  const listeners = new Set<() => void>();
  const add = (endpointId: string, projectId: string | null) => {
    const ep: FakeEndpoint = {
      endpointId,
      projectId,
      kind: "remote-view",
      closed: false,
      isClosed: () => ep.closed,
    };
    endpoints.set(endpointId, ep);
    listeners.forEach((l) => l());
    return ep;
  };
  return {
    add,
    change: () => listeners.forEach((l) => l()),
    get: (id: string) => endpoints.get(id) as never,
    getRemote: () => [...endpoints.values()].filter((e) => !e.closed) as never,
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

beforeEach(() => {
  _resetRemoteServicesForTest();
});

describe("EndpointVisibility", () => {
  it("counts a view that never reported as visible, and follows its reports", () => {
    const registry = fakeRegistry();
    const visibility = new EndpointVisibility(registry);
    registry.add("remote:s1:view-1", "p1");
    expect(visibility.isProjectVisibleRemotely("p1")).toBe(true);

    visibility.report("remote:s1:view-1", false);
    expect(visibility.isProjectVisibleRemotely("p1")).toBe(false);
    expect(visibility.visibleProjectIds()).toEqual(new Set());

    visibility.report("remote:s1:view-1", true);
    expect(visibility.visibleProjectIds()).toEqual(new Set(["p1"]));
  });

  it("keeps a project visible while any Shell still shows it", () => {
    const registry = fakeRegistry();
    const visibility = new EndpointVisibility(registry);
    registry.add("remote:s1:view-1", "p1");
    registry.add("remote:s2:view-9", "p1");
    visibility.report("remote:s1:view-1", false);
    expect(visibility.isProjectVisibleRemotely("p1")).toBe(true);
  });

  it("answers live, so a check repeated after an await sees a view that appeared", () => {
    const registry = fakeRegistry();
    const visibility = new EndpointVisibility(registry);
    expect(visibility.isProjectVisibleRemotely("p1")).toBe(false);
    registry.add("remote:s1:view-1", "p1");
    expect(visibility.isProjectVisibleRemotely("p1")).toBe(true);
  });

  it("ignores reports for unknown endpoints and forgets closed ones", () => {
    const registry = fakeRegistry();
    const visibility = new EndpointVisibility(registry);
    visibility.report("remote:s1:ghost", false);
    const ep = registry.add("remote:s1:view-1", "p1");
    visibility.report("remote:s1:view-1", false);
    ep.closed = true;
    registry.change();
    ep.closed = false;
    expect(visibility.isVisible("remote:s1:view-1")).toBe(true);
  });
});

describe("installEndpointVisibility", () => {
  it("answers each session's reports for that session's endpoints only", () => {
    const registry = fakeRegistry();
    let onSession: ((ctx: { sessionId: string; session: unknown }) => void) | null = null;
    const server = {
      onSession: vi.fn((cb) => {
        onSession = cb;
        return () => (onSession = null);
      }),
    };
    const dispose = installEndpointVisibility({ server: server as never, registry });
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const session = {
      registerCallHandler: vi.fn((method: string, schema: { parse(v: unknown): unknown }, fn) => {
        handlers.set(method, (payload) => fn(schema.parse(payload)));
        return () => undefined;
      }),
    };
    registry.add("remote:s1:view-1", "p1");
    registry.add("remote:s2:view-1", "p2");
    onSession!({ sessionId: "s1", session });

    handlers.get(ENDPOINT_VISIBILITY_METHOD)!({ endpointId: "view-1", visible: false });
    const service = getRemoteService("endpointVisibility")!;
    expect(service.isProjectVisibleRemotely("p1")).toBe(false);
    expect(service.isProjectVisibleRemotely("p2")).toBe(true);
    expect(() => handlers.get(ENDPOINT_VISIBILITY_METHOD)!({ endpointId: 3 })).toThrow();
    // The close and background guards see what the Shells display.
    expect(collectActiveProjectIds(null, null, "test")).toEqual(new Set(["p2"]));

    dispose();
    expect(getRemoteService("endpointVisibility")).toBeUndefined();
    expect(collectActiveProjectIds(null, null, "test")).toEqual(new Set());
    expect(onSession).toBeNull();
  });
});

describe("ViewVisibilityReporter", () => {
  function session() {
    return { isOpen: true, call: vi.fn(async () => null) };
  }

  it("reports the view a window shows as visible and the one it replaced as hidden", () => {
    const reporter = new ViewVisibilityReporter();
    const s = session();
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 10, endpointId: "view-10" });
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 11, endpointId: "view-11" });
    expect(s.call).toHaveBeenLastCalledWith(ENDPOINT_VISIBILITY_METHOD, {
      endpointId: "view-11",
      visible: false,
    });

    reporter.noteViewActivated(1, 10);
    expect(s.call).toHaveBeenLastCalledWith(ENDPOINT_VISIBILITY_METHOD, {
      endpointId: "view-10",
      visible: true,
    });

    s.call.mockClear();
    reporter.noteViewActivated(1, 11);
    expect(s.call.mock.calls).toEqual([
      [ENDPOINT_VISIBILITY_METHOD, { endpointId: "view-10", visible: false }],
      [ENDPOINT_VISIBILITY_METHOD, { endpointId: "view-11", visible: true }],
    ]);
  });

  it("re-reports on a new session and stays quiet for closed links or retired views", () => {
    const reporter = new ViewVisibilityReporter();
    reporter.noteViewActivated(1, 10);
    const closed = { isOpen: false, call: vi.fn() };
    reporter.noteEndpointOpened({ session: closed as never, webContentsId: 10, endpointId: "v" });
    expect(closed.call).not.toHaveBeenCalled();

    const next = session();
    reporter.noteEndpointOpened({ session: next as never, webContentsId: 10, endpointId: "v" });
    expect(next.call).toHaveBeenCalledWith(ENDPOINT_VISIBILITY_METHOD, {
      endpointId: "v",
      visible: true,
    });

    reporter.noteEndpointClosed(10, "v");
    next.call.mockClear();
    reporter.noteViewActivated(1, 10);
    expect(next.call).not.toHaveBeenCalled();
  });
});
