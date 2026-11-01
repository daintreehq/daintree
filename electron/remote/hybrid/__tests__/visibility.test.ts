import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectActiveProjectIds } from "../../../window/activeProjectIds.js";
import { onProjectPresenceChanged } from "../../../window/projectPresenceChanges.js";
import {
  ProjectVisibilityClock,
  trackProjectVisibility,
} from "../../../services/projectVisibilityClock.js";
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

  it("announces a change in which projects the Shells show, and only then", () => {
    const registry = fakeRegistry();
    const visibility = new EndpointVisibility(registry);
    const changes = vi.fn();
    const off = onProjectPresenceChanged(changes);
    try {
      registry.add("remote:s1:view-1", "p1");
      expect(changes).toHaveBeenCalledTimes(1);

      // A second Shell on the same project, then the first one hiding it:
      // p1 is on screen throughout.
      registry.add("remote:s2:view-9", "p1");
      visibility.report("remote:s1:view-1", false);
      expect(changes).toHaveBeenCalledTimes(1);

      visibility.report("remote:s2:view-9", false);
      expect(changes).toHaveBeenCalledTimes(2);
      visibility.report("remote:s2:view-9", false);
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      off();
      visibility.dispose();
    }
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

  it("lets the idle clock stamp a project as the last Shell stops showing it (#13844)", () => {
    const registry = fakeRegistry();
    const dispose = installEndpointVisibility({ server: null, registry });
    const time = { now: 1_000 };
    const clock = new ProjectVisibilityClock(() => time.now);
    const stop = trackProjectVisibility(() => collectActiveProjectIds(null, null, "test"), clock);
    try {
      time.now = 2_000;
      registry.add("remote:s1:view-1", "p1");
      time.now = 5_000;
      getRemoteService("endpointVisibility")!.report("remote:s1:view-1", false);
      time.now = 60_000;
      expect(clock.lastVisibleAt("p1")).toBe(5_000);
    } finally {
      stop();
      dispose();
    }
  });

  it("lets the idle clock stamp a project whose Shell view closed or moved to another project", () => {
    const registry = fakeRegistry();
    const dispose = installEndpointVisibility({ server: null, registry });
    const time = { now: 1_000 };
    const clock = new ProjectVisibilityClock(() => time.now);
    const stop = trackProjectVisibility(() => collectActiveProjectIds(null, null, "test"), clock);
    try {
      time.now = 2_000;
      const closing = registry.add("remote:s1:view-1", "p1");
      const moving = registry.add("remote:s2:view-1", "p2");
      time.now = 5_000;
      closing.closed = true;
      registry.change();
      time.now = 7_000;
      moving.projectId = "p3";
      registry.change();
      time.now = 60_000;
      expect(clock.lastVisibleAt("p1")).toBe(5_000);
      expect(clock.lastVisibleAt("p2")).toBe(7_000);
      expect(clock.lastVisibleAt("p3")).toBe(60_000);
    } finally {
      stop();
      dispose();
    }
  });

  it("announces that the Shells' projects stopped counting once uninstalled", () => {
    const registry = fakeRegistry();
    const dispose = installEndpointVisibility({ server: null, registry });
    registry.add("remote:s1:view-1", "p1");
    const changes = vi.fn(() => collectActiveProjectIds(null, null, "test"));
    const off = onProjectPresenceChanged(changes);
    try {
      dispose();
      expect(changes).toHaveBeenCalledTimes(1);
      expect(changes.mock.results[0]?.value).toEqual(new Set());
    } finally {
      off();
    }
  });
});

describe("ViewVisibilityReporter", () => {
  // A report must not be dropped unsent past a deadline: only a change sends another.
  const NO_DEADLINE = { timeoutMs: 0 };

  function session() {
    return { isOpen: true, call: vi.fn(async () => null) };
  }

  it("reports the view a window shows as visible and the one it replaced as hidden", () => {
    const reporter = new ViewVisibilityReporter();
    const s = session();
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 10, endpointId: "view-10" });
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 11, endpointId: "view-11" });
    expect(s.call).toHaveBeenLastCalledWith(
      ENDPOINT_VISIBILITY_METHOD,
      {
        endpointId: "view-11",
        visible: false,
      },
      NO_DEADLINE
    );

    reporter.noteViewActivated(1, 10);
    expect(s.call).toHaveBeenLastCalledWith(
      ENDPOINT_VISIBILITY_METHOD,
      {
        endpointId: "view-10",
        visible: true,
      },
      NO_DEADLINE
    );

    s.call.mockClear();
    reporter.noteViewActivated(1, 11);
    expect(s.call.mock.calls).toEqual([
      [ENDPOINT_VISIBILITY_METHOD, { endpointId: "view-10", visible: false }, NO_DEADLINE],
      [ENDPOINT_VISIBILITY_METHOD, { endpointId: "view-11", visible: true }, NO_DEADLINE],
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
    expect(next.call).toHaveBeenCalledWith(
      ENDPOINT_VISIBILITY_METHOD,
      {
        endpointId: "v",
        visible: true,
      },
      NO_DEADLINE
    );

    reporter.noteEndpointClosed(10, "v");
    next.call.mockClear();
    reporter.noteViewActivated(1, 10);
    expect(next.call).not.toHaveBeenCalled();
  });

  it("reports a window's host view hidden once it shows a view on this machine, and forgets closed windows", () => {
    const reporter = new ViewVisibilityReporter();
    const s = session();
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 10, endpointId: "view-10" });
    reporter.noteViewActivated(1, 10);
    s.call.mockClear();

    // View 20 is local: it has no endpoint, so only the host view's report goes out.
    reporter.noteViewActivated(1, 20);
    expect(s.call.mock.calls).toEqual([
      [ENDPOINT_VISIBILITY_METHOD, { endpointId: "view-10", visible: false }, NO_DEADLINE],
    ]);

    reporter.noteViewActivated(1, 10);
    reporter.noteWindowClosed(1);
    s.call.mockClear();
    // A later re-report (a resumed session) no longer counts the closed window's view as shown.
    reporter.noteEndpointOpened({ session: s as never, webContentsId: 10, endpointId: "view-10" });
    expect(s.call).toHaveBeenCalledWith(
      ENDPOINT_VISIBILITY_METHOD,
      {
        endpointId: "view-10",
        visible: false,
      },
      NO_DEADLINE
    );
  });
});
