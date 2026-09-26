import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EndpointRegistryImpl } from "../../../ipc/endpointRegistry.js";
import type { EndpointInvocation } from "../../../ipc/endpoint.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { Lane } from "../../link/frames.js";
import { ControlKind } from "../../link/messages.js";
import type { EnqueueResult } from "../../link/scheduler.js";
import type { LinkSession } from "../../link/session.js";
import type { HostSessionContext, HostSessionExpired } from "../HostServer.js";
import { LinkMethod } from "../linkMethods.js";
import { SessionHost } from "../SessionHost.js";

type Listener = (body: unknown) => void;

/** Just enough of a LinkSession to drive SessionHost deterministically. */
function fakeLink() {
  const listeners = new Map<string, Set<Listener>>();
  const writable = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const posted: Array<{ lane: number; kind: number; body: unknown }> = [];
  const calls: Array<{ method: string; payload: unknown }> = [];
  const link = {
    isOpen: true,
    isClosed: false,
    postResult: "queued" as EnqueueResult,
    queued: 0,
    invokeHandler: null as ((m: unknown) => Promise<IpcEnvelope>) | null,
    reverseRequest: vi.fn((): Promise<unknown> => new Promise(() => {})),
    on(lane: number, kind: number, listener: Listener) {
      const key = `${lane}/${kind}`;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
    onWritable(cb: () => void) {
      writable.add(cb);
      return () => writable.delete(cb);
    },
    onClose(cb: () => void) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    registerCallHandler: () => () => {},
    setInvokeHandler(handler: ((m: unknown) => Promise<IpcEnvelope>) | null) {
      link.invokeHandler = handler;
    },
    setSendHandler: () => {},
    post(message: { lane: number; kind: number; body: unknown }) {
      posted.push(message);
      return link.postResult;
    },
    queuedBytes: () => link.queued,
    call: vi.fn(async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      return null;
    }),
    emit(lane: number, kind: number, body: unknown) {
      for (const listener of listeners.get(`${lane}/${kind}`) ?? []) listener(body);
    },
    tick() {
      for (const cb of [...writable]) cb();
    },
    drop() {
      link.isOpen = false;
      link.isClosed = true;
      for (const cb of [...closeListeners]) cb();
    },
    posted,
    calls,
  };
  return link;
}

function fakeServer() {
  const sessionListeners = new Set<(ctx: HostSessionContext) => void>();
  const expiredListeners = new Set<(info: HostSessionExpired) => void>();
  return {
    onSession: (l: (ctx: HostSessionContext) => void) => {
      sessionListeners.add(l);
      return () => sessionListeners.delete(l);
    },
    onSessionExpired: (l: (info: HostSessionExpired) => void) => {
      expiredListeners.add(l);
      return () => expiredListeners.delete(l);
    },
    attach(sessionId: string, link: ReturnType<typeof fakeLink>, resumed = false) {
      const ctx = {
        sessionId,
        resumed,
        client: { clientId: "c1", clientName: "greg-mbp", platform: "darwin" as const },
        session: link as unknown as LinkSession,
      };
      for (const l of sessionListeners) l(ctx);
    },
    expire(sessionId: string) {
      for (const l of expiredListeners) l({ sessionId, clientId: "c1" });
    },
  };
}

let registry: EndpointRegistryImpl;
let server: ReturnType<typeof fakeServer>;
let host: SessionHost;
let counts: number[];
const invocations: Array<{ invocation: EndpointInvocation; channel: string }> = [];

beforeEach(() => {
  vi.useFakeTimers();
  registry = new EndpointRegistryImpl();
  server = fakeServer();
  counts = [];
  invocations.length = 0;
  host = new SessionHost(server, {
    dispatcher: {
      invokeForEndpoint: async (invocation, channel) => {
        invocations.push({ invocation, channel });
        return wrapSuccess(invocation.endpoint.projectId);
      },
      sendForEndpoint: () => {},
    },
    registry,
    setAttachedFrontendCount: (n) => counts.push(n),
    eventsHighWaterBytes: 1_000,
    overHighWaterGraceMs: 100,
    maxEndpointsPerSession: 2,
  });
});

afterEach(() => {
  host.dispose();
  vi.useRealTimers();
});

function open(link: ReturnType<typeof fakeLink>, endpointId: string, projectId: string | null) {
  link.emit(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, { endpointId, projectId });
}

describe("SessionHost", () => {
  it("creates uniquely named endpoints with negative handles per session", () => {
    const one = fakeLink();
    const two = fakeLink();
    server.attach("s1", one);
    server.attach("s2", two);
    open(one, "view-1", "p");
    open(two, "view-1", "p");

    const remote = registry.getRemote();
    expect(remote).toHaveLength(2);
    expect(new Set(remote.map((e) => e.endpointId)).size).toBe(2);
    expect(remote.every((e) => e.handle < 0)).toBe(true);
    expect(new Set(remote.map((e) => e.handle)).size).toBe(2);
    expect(counts).toEqual([1, 2]);
  });

  it("caps endpoints per session", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "a", null);
    open(link, "b", null);
    open(link, "c", null);
    expect(registry.getRemote()).toHaveLength(2);
  });

  it("rebinds an endpoint and makes answers to earlier requests stale", async () => {
    const link = fakeLink();
    let answer!: (value: unknown) => void;
    link.reverseRequest.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const endpoint = registry.getRemote()[0]!;

    const pending = endpoint.request("plugin:prompt", {});
    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, { endpointId: "view-1", projectId: "p2" });
    answer("yes");

    await expect(pending).rejects.toMatchObject({ code: "STALE_GENERATION" });
    expect(endpoint.projectId).toBe("p2");
    expect(registry.getForProject("p2")).toEqual([endpoint]);
  });

  it("settles a pending request with HOST_DISCONNECTED when its endpoint closes", async () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const endpoint = registry.getRemote()[0]!;
    const pending = endpoint.request("mcp:dispatch-action", {});

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });

    await expect(pending).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(registry.getRemote()).toHaveLength(0);
  });

  it("answers an invoke for an unknown endpoint with NOT_FOUND, without dispatching", async () => {
    const link = fakeLink();
    server.attach("s1", link);
    const envelope = await link.invokeHandler!({
      requestId: 1,
      endpointId: "never-opened",
      channel: "git:get-file-diff",
      args: [],
    });
    expect(envelope.ok ? null : envelope.error.code).toBe("NOT_FOUND");
    expect(invocations).toHaveLength(0);
  });

  it("keeps endpoints while the Shell is away and closes them only when the session expires", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    link.drop();
    expect(counts.at(-1)).toBe(0);
    expect(registry.getRemote()).toHaveLength(1);

    server.expire("s1");
    expect(registry.getRemote()).toHaveLength(0);
  });

  it("reports its endpoints' link dropping and resuming, before the session expires", () => {
    const changes: Array<[string[], boolean]> = [];
    host.onTransportChange((endpointIds, attached) => changes.push([endpointIds, attached]));
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    const ids = registry.getRemote().map((e) => e.endpointId);
    expect(changes).toEqual([]);

    link.drop();
    expect(changes).toEqual([[ids, false]]);

    server.attach("s1", fakeLink(), true);
    expect(changes).toEqual([
      [ids, false],
      [ids, true],
    ]);

    // A fresh session announces nothing: its endpoints start attached.
    server.attach("s2", fakeLink());
    expect(changes).toHaveLength(2);
  });

  it("resyncs a Shell whose event lane stays over high water past the grace", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const endpoint = registry.getRemote()[0]!;

    link.postResult = "over-high-water";
    link.queued = 5_000;
    endpoint.send({ type: "event", channel: "terminal:data", args: [1] });
    vi.advanceTimersByTime(100);

    // Dropping now: nothing more is queued for it.
    const postedBefore = link.posted.length;
    endpoint.send({ type: "event", channel: "terminal:data", args: [2] });
    expect(link.posted).toHaveLength(postedBefore);

    // Not until what was queued has drained.
    link.tick();
    expect(link.calls).toHaveLength(0);
    link.queued = 0;
    link.postResult = "queued";
    link.tick();
    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1"], reason: "overflow" },
      },
    ]);

    endpoint.send({ type: "event", channel: "terminal:data", args: [3] });
    expect(link.posted.length).toBe(postedBefore + 1);
  });

  it("does not resync when the lane recovers within the grace", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const endpoint = registry.getRemote()[0]!;

    link.postResult = "over-high-water";
    link.queued = 5_000;
    endpoint.send({ type: "event", channel: "terminal:data", args: [1] });
    link.queued = 200;
    vi.advanceTimersByTime(100);
    link.tick();

    expect(link.calls).toHaveLength(0);
    link.postResult = "queued";
    const before = link.posted.length;
    endpoint.send({ type: "event", channel: "terminal:data", args: [2] });
    expect(link.posted).toHaveLength(before + 1);
  });

  it("tells a resumed Shell which endpoints missed events while it was away", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1");
    open(first, "view-2", "p2");
    first.drop();
    registry.getForProject("p1")[0]!.send({ type: "event", channel: "terminal:data", args: [] });

    const second = fakeLink();
    server.attach("s1", second, true);

    expect(second.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "reattached" },
      },
    ]);
    expect(registry.getRemote()).toHaveLength(2);
    expect(counts.at(-1)).toBe(1);
  });

  it("resumes delivery for a new endpoint when every stale endpoint closed mid-resync", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    link.postResult = "refused";
    registry.getRemote()[0]!.send({ type: "event", channel: "terminal:data", args: [] });
    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });

    link.postResult = "queued";
    link.tick();
    open(link, "view-2", "p1");
    const before = link.posted.length;
    registry.getRemote()[0]!.send({ type: "event", channel: "terminal:data", args: [] });
    expect(link.posted).toHaveLength(before + 1);
    expect(link.calls).toHaveLength(0);
  });

  it("keeps owing a resync when the notice could not be delivered", async () => {
    const link = fakeLink();
    link.call.mockRejectedValueOnce(new Error("queue full"));
    server.attach("s1", link);
    open(link, "view-1", "p1");
    link.postResult = "refused";
    registry.getRemote()[0]!.send({ type: "event", channel: "terminal:data", args: [] });
    link.postResult = "queued";
    link.tick();
    await vi.waitFor(() => expect(link.call).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    link.tick();
    expect(link.call).toHaveBeenCalledTimes(2);
    expect(link.call.mock.calls[1]![1]).toEqual({ endpointIds: ["view-1"], reason: "overflow" });
  });

  it("reports the endpoint to bridges that follow it, with its current link", () => {
    const link = fakeLink();
    const opened = vi.fn();
    host.onEndpointOpened(opened);
    server.attach("s1", link);
    open(link, "view-1", "p1");

    expect(opened).toHaveBeenCalledTimes(1);
    const [endpoint, handle] = opened.mock.calls[0]!;
    expect(endpoint).toBe(registry.getRemote()[0]);
    expect(handle.sessionId).toBe("s1");
    expect(handle.link()).toBe(link);
    link.drop();
    expect(handle.link()).toBeNull();
  });
});

describe("SessionHost: the project a Shell last showed here", () => {
  const client = (clientName: string) => ({
    clientId: `${clientName}-launch`,
    clientName,
    platform: "darwin" as const,
    kind: "remote" as const,
  });
  const known = new Set(["p1", "p2"]);

  function remembering() {
    return new SessionHost(fakeServer(), {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: new EndpointRegistryImpl(),
      describeProject: (projectId) =>
        known.has(projectId) ? { projectId, path: `/srv/${projectId}`, name: projectId } : null,
    });
  }

  it("remembers per Shell machine, across that Shell's relaunches", () => {
    const sessions = remembering();
    sessions.noteActiveProject(client("greg-mbp"), "p1");
    sessions.noteActiveProject(client("studio-02"), "p2");
    // A relaunched Shell has a new client id but the same machine.
    expect(
      sessions.lastActiveProject({ ...client("greg-mbp"), clientId: "second-launch" })
    ).toEqual({ projectId: "p1", path: "/srv/p1", name: "p1" });
    expect(sessions.lastActiveProject(client("studio-02"))?.projectId).toBe("p2");
    expect(sessions.lastActiveProject(client("elsewhere"))).toBeNull();
    sessions.dispose();
  });

  it("keeps only projects this host has, and forgets one it no longer has", () => {
    const sessions = remembering();
    sessions.noteActiveProject(client("greg-mbp"), "p1");
    sessions.noteActiveProject(client("greg-mbp"), "not-here");
    expect(sessions.lastActiveProject(client("greg-mbp"))?.projectId).toBe("p1");
    known.delete("p1");
    try {
      expect(sessions.lastActiveProject(client("greg-mbp"))).toBeNull();
      known.add("p1");
      // Forgotten, not merely hidden.
      expect(sessions.lastActiveProject(client("greg-mbp"))).toBeNull();
    } finally {
      known.add("p1");
      sessions.dispose();
    }
  });

  it("answers both over the link", () => {
    const handlers = new Map<string, (payload: never) => unknown>();
    const link = fakeLink();
    link.registerCallHandler = ((method: string, _schema: unknown, handler: never) => {
      handlers.set(method, handler);
      return () => {};
    }) as never;
    const fake = fakeServer();
    const sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: new EndpointRegistryImpl(),
      describeProject: (projectId) =>
        known.has(projectId) ? { projectId, path: `/srv/${projectId}`, name: projectId } : null,
    });
    fake.attach("s1", link);
    expect(handlers.get(LinkMethod.LAST_ACTIVE_PROJECT)!(null as never)).toBeNull();
    expect(handlers.get(LinkMethod.NOTE_ACTIVE_PROJECT)!({ projectId: "p2" } as never)).toBeNull();
    expect(handlers.get(LinkMethod.LAST_ACTIVE_PROJECT)!(null as never)).toEqual({
      projectId: "p2",
      path: "/srv/p2",
      name: "p2",
    });
    sessions.dispose();
  });
});
