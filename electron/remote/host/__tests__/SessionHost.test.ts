import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("electron", () => ({
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { EndpointRegistryImpl } from "../../../ipc/endpointRegistry.js";
import { DriveLeaseService } from "../../../services/DriveLeaseService.js";
import type { EndpointInvocation, RemoteSessionExpiryCause } from "../../../ipc/endpoint.js";
import { logBuffer } from "../../../services/LogBuffer.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { CHANNELS } from "../../../ipc/channels.js";
import type { HandshakeMismatch } from "../../../../shared/types/remoteHosts.js";
import { Lane } from "../../link/frames.js";
import { ControlKind, EventKind } from "../../link/messages.js";
import type { EnqueueResult } from "../../link/scheduler.js";
import type { LinkSession } from "../../link/session.js";
import type { HostSessionContext, HostSessionExpired } from "../HostServer.js";
import { LinkMethod } from "../linkMethods.js";
import { ANSWER_RETRY_MS, SessionHost } from "../SessionHost.js";

type Listener = (body: unknown) => void;

/** Just enough of a LinkSession to drive SessionHost deterministically. */
function fakeLink() {
  const listeners = new Map<string, Set<Listener>>();
  const writable = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const posted: Array<{ lane: number; kind: number; body: unknown }> = [];
  const calls: Array<{ method: string; payload: unknown }> = [];
  const callHandlers = new Map<string, { schema: z.ZodType; handler: (p: never) => unknown }>();
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
    registerCallHandler(method: string, schema: z.ZodType, handler: (p: never) => unknown) {
      const entry = { schema, handler };
      callHandlers.set(method, entry);
      return () => {
        if (callHandlers.get(method) === entry) callHandlers.delete(method);
      };
    },
    /** What the Shell's CALL would run, its payload validated as the session would. */
    runCall(method: string, payload: unknown) {
      const entry = callHandlers.get(method);
      if (!entry) throw new Error(`no handler for ${method}`);
      return entry.handler(entry.schema.parse(payload) as never);
    },
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
    attach(
      sessionId: string,
      link: ReturnType<typeof fakeLink>,
      resumed = false,
      clientId = "c1",
      buildMismatch: HandshakeMismatch | null = null
    ) {
      const ctx = {
        sessionId,
        resumed,
        client: { clientId, clientName: "greg-mbp", platform: "darwin" as const },
        session: link as unknown as LinkSession,
        buildMismatch,
      };
      for (const l of sessionListeners) l(ctx);
    },
    expire(sessionId: string, cause: RemoteSessionExpiryCause = "grace-expired") {
      for (const l of expiredListeners) l({ sessionId, clientId: "c1", cause });
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

function open(
  link: ReturnType<typeof fakeLink>,
  endpointId: string,
  projectId: string | null,
  openId?: string
) {
  link.emit(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, {
    endpointId,
    projectId,
    ...(openId ? { openId } : {}),
  });
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
    expect(counts).toEqual([0, 1, 2]);
  });

  it("counts a Shell toward keep-awake only while it has a view open here", () => {
    const link = fakeLink();
    server.attach("s1", link);
    // A summary-only link: nobody is using this host from it.
    expect(counts).toEqual([0]);
    open(link, "view-1", "p");
    expect(counts.at(-1)).toBe(1);
    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });
    expect(counts.at(-1)).toBe(0);
    expect(host.attachedCount).toBe(0);
  });

  it("serves views only while a live link has one open, untouched or not (#15907)", () => {
    const link = fakeLink();
    server.attach("s1", link);
    // A summary-only link reads no view's answers.
    expect(host.servesViews).toBe(false);
    open(link, "view-1", "p");
    expect(host.servesViews).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(host.attachedCount).toBe(0);
    expect(host.servesViews).toBe(true);

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });
    expect(host.servesViews).toBe(false);

    open(link, "view-2", "p");
    link.drop();
    // Its views are kept for the Shell, but nothing can read their answers.
    expect(registry.getRemote()).toHaveLength(1);
    expect(host.servesViews).toBe(false);
    const handshaking = fakeLink();
    handshaking.isOpen = false;
    server.attach("s1", handshaking, true);
    expect(host.servesViews).toBe(false);
    server.attach("s1", fakeLink(), true);
    expect(host.servesViews).toBe(true);

    const other = fakeLink();
    server.attach("s2", other);
    open(other, "view-1", "q");
    server.expire("s1");
    expect(host.servesViews).toBe(true);
    host.dispose();
    expect(host.servesViews).toBe(false);
  });

  it("stops holding the host awake once a window has gone unused, and resumes on input", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p");
    expect(counts.at(-1)).toBe(1);

    vi.advanceTimersByTime(5 * 60_000);
    // Still attached and still showing a view, but nobody has touched it.
    expect(counts.at(-1)).toBe(0);
    expect(registry.getRemote()).toHaveLength(1);

    host.noteActivity("s1");
    expect(counts.at(-1)).toBe(1);
    vi.advanceTimersByTime(4 * 60_000);
    host.noteActivity("s1");
    vi.advanceTimersByTime(4 * 60_000);
    // Each use renews the window.
    expect(counts.at(-1)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(counts.at(-1)).toBe(0);
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

  it("says why each endpoint closed, in its close listeners and in the log", () => {
    logBuffer.clear();
    const one = fakeLink();
    server.attach("s1", one);
    open(one, "view-1", "p1");
    open(one, "view-2", "p1");
    const two = fakeLink();
    server.attach("s2", two);
    open(two, "view-1", "p2");
    const three = fakeLink();
    server.attach("s3", three);
    open(three, "view-1", "p3");
    const closed: Array<[string, unknown]> = [];
    for (const endpoint of registry.getRemote()) {
      endpoint.onClose(() => closed.push([endpoint.endpointId, endpoint.closeCause]));
    }

    one.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });
    // A dropped link closes nothing: the session waits for a resume.
    one.drop();
    expect(closed).toHaveLength(1);
    server.expire("s1", "grace-expired");
    // A fresh session under an id the host still holds replaces it.
    server.attach("s2", fakeLink());
    host.dispose();

    expect(closed).toEqual([
      ["remote:s1:view-1", "client-closed"],
      ["remote:s1:view-2", "grace-expired"],
      ["remote:s2:view-1", "session-replaced"],
      ["remote:s3:view-1", "host-shutdown"],
    ]);
    const lines = logBuffer
      .getFiltered({ sources: ["main:SessionHost"] })
      .filter((entry) => entry.message === "Remote view endpoint closed")
      .map((entry) => entry.context);
    expect(lines).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        clientId: "c1",
        clientEndpointId: "view-1",
        projectId: "p1",
        cause: "client-closed",
      }),
      expect.objectContaining({
        sessionId: "s1",
        clientEndpointId: "view-2",
        cause: "grace-expired",
      }),
      expect.objectContaining({ sessionId: "s2", cause: "session-replaced" }),
      expect.objectContaining({ sessionId: "s3", cause: "host-shutdown" }),
    ]);
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

describe("SessionHost: one push for every view of a session (#15902)", () => {
  const frame = { type: "event" as const, channel: "worktree:update", args: [{ id: "w" }] };
  const events = (link: ReturnType<typeof fakeLink>) =>
    link.posted.filter((m) => m.lane === Lane.EVENTS && m.kind === EventKind.EVENT);
  const addressed = (link: ReturnType<typeof fakeLink>) =>
    events(link).map((m) => (m.body as { endpointId: unknown }).endpointId);

  it("posts one EVENT addressed to the whole session, and none to another session", () => {
    const one = fakeLink();
    const two = fakeLink();
    server.attach("s1", one);
    server.attach("s2", two, false, "c2");
    open(one, "view-1", "p1");
    open(one, "view-2", "p2");
    open(two, "view-1", "p1");
    const [a, b] = registry.getRemote().filter((e) => e.clientId === "c1");
    const other = registry.getRemote().find((e) => e.clientId === "c2")!;
    expect(a!.group).toBeDefined();
    expect(b!.group).toBe(a!.group);
    expect(other.group).not.toBe(a!.group);

    a!.group!.sendToAll(frame);

    expect(events(one)).toEqual([
      {
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: frame.channel, args: frame.args },
      },
    ]);
    expect(events(two)).toEqual([]);
  });

  it("keeps the group of a resumed session, so its views still share one push", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1");
    const group = registry.getRemote()[0]!.group;
    first.drop();
    const second = fakeLink();
    server.attach("s1", second, true);
    open(second, "view-2", "p1");

    const [kept, added] = registry.getRemote();
    expect(kept!.group).toBe(group);
    expect(added!.group).toBe(group);
    group!.sendToAll(frame);
    expect(addressed(second)).toEqual([null]);
  });

  it("goes quiet once its session expires, leaving a new session under the id its own group", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1");
    const expired = registry.getRemote()[0]!.group!;
    server.expire("s1");

    const second = fakeLink();
    server.attach("s1", second);
    open(second, "view-1", "p1");
    expired.sendToAll(frame);
    expect(addressed(second)).toEqual([]);

    const current = registry.getRemote()[0]!.group!;
    expect(current).not.toBe(expired);
    current.sendToAll(frame);
    expect(addressed(second)).toEqual([null]);
  });

  it("owes each view it was meant for a repaint when it is dropped with the link not open", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    const group = registry.getRemote()[0]!.group!;
    // Not open, and no close heard: only the drop itself owes the views anything.
    link.isOpen = false;

    group.sendToAll(frame);
    expect(events(link)).toEqual([]);

    link.isOpen = true;
    link.tick();
    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "reattached" },
      },
    ]);
  });

  it("addresses each endpoint for the rest of a session that refused a view at the cap", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1");
    open(first, "view-2", "p1");
    open(first, "view-3", "p1");
    const group = registry.getRemote()[0]!.group!;

    group.sendToAll(frame);
    // The Shell would hand a session-wide event to view-3 too, which has no endpoint here.
    expect(addressed(first)).toEqual(["view-1", "view-2"]);

    // Room below the cap doesn't open view-3, which the Shell still holds.
    first.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });
    first.posted.length = 0;
    group.sendToAll(frame);
    expect(addressed(first)).toEqual(["view-2"]);

    // A resumed link forgets the refusal until the Shell repeats view-3's open.
    first.drop();
    const second = fakeLink();
    server.attach("s1", second, true);
    group.sendToAll(frame);
    expect(addressed(second)).toEqual(["view-2"]);
  });

  it("keeps one push for a session filled to the cap without turning a view away", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p1");

    registry.getRemote()[0]!.group!.sendToAll(frame);
    expect(addressed(link)).toEqual([null]);
  });

  it("owes every view of the session a repaint when the event can't be sent", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    const group = registry.getRemote()[0]!.group!;
    link.post = vi.fn(() => {
      throw new Error("frame too large");
    });

    group.sendToAll(frame);

    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "overflow" },
      },
    ]);
  });

  it("owes a repaint only to the view an addressed event that can't be sent was for", () => {
    const link = fakeLink();
    const other = fakeLink();
    server.attach("s1", link);
    server.attach("s2", other, false, "c2");
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    open(other, "view-1", "p1");
    link.post = vi.fn(() => {
      throw new Error("frame too large");
    });

    registry
      .getForProject("p1")
      .find((e) => e.clientId === "c1")!
      .send(frame);

    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1"], reason: "overflow" },
      },
    ]);
    expect(other.calls).toEqual([]);
  });

  it("owes a view opened mid-resync the session-wide events it missed", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const group = registry.getRemote()[0]!.group!;
    link.postResult = "refused";
    group.sendToAll(frame);
    link.postResult = "queued";
    link.queued = 10;
    link.tick();
    // Opened after the resync began, so only the dropped event owes it one.
    open(link, "view-2", "p2");

    group.sendToAll(frame);
    link.queued = 0;
    link.tick();

    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "overflow" },
      },
    ]);
  });

  it("drops session-wide events while the Shell resyncs, then resumes them", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    const group = registry.getRemote()[0]!.group!;

    link.postResult = "refused";
    group.sendToAll(frame);
    link.postResult = "queued";
    const posted = link.posted.length;
    group.sendToAll(frame);
    expect(link.posted).toHaveLength(posted);

    link.tick();
    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "overflow" },
      },
    ]);
    group.sendToAll(frame);
    expect(link.posted).toHaveLength(posted + 1);
  });

  it("resyncs the session when session-wide events keep its lane over high water", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    const group = registry.getRemote()[0]!.group!;

    link.postResult = "over-high-water";
    link.queued = 5_000;
    group.sendToAll(frame);
    vi.advanceTimersByTime(100);
    link.queued = 0;
    link.postResult = "queued";
    link.tick();

    expect(link.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1", "view-2"], reason: "overflow" },
      },
    ]);
  });

  it("posts nothing for a session with no open endpoint", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    const group = registry.getRemote()[0]!.group!;
    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });

    group.sendToAll(frame);
    expect(events(link)).toEqual([]);
  });
});

describe("SessionHost: pushes a Shell would discard by locality (#15901)", () => {
  /** What a host broadcast does: one event per remote endpoint in the registry. */
  function broadcast(channel: string, args: unknown[]) {
    for (const endpoint of registry.getRemote()) endpoint.send({ type: "event", channel, args });
  }

  const eventFrames = (link: ReturnType<typeof fakeLink>) =>
    link.posted
      .filter((m) => m.lane === Lane.EVENTS && m.kind === EventKind.EVENT)
      .map((m) => m.body as { endpointId: string; channel: string; args: unknown[] });

  it("sends no EVENT frame for a shell-locality broadcast and still sends a host-locality one", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");

    broadcast(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, [{ percent: 40 }]);
    expect(eventFrames(link)).toEqual([]);

    broadcast(CHANNELS.TERMINAL_DATA, ["t1", "hi"]);
    expect(eventFrames(link).map((f) => [f.endpointId, f.channel])).toEqual([
      ["view-1", CHANNELS.TERMINAL_DATA],
      ["view-2", CHANNELS.TERMINAL_DATA],
    ]);
  });

  it("decides events:push by event name and hybrid channels by the half the host owns", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");

    broadcast(CHANNELS.EVENTS_PUSH, [{ name: "sound:cancel", payload: {} }]);
    broadcast(CHANNELS.KEEP_AWAKE_STATE_CHANGED, [{ active: true }]);
    broadcast(CHANNELS.EVENTS_PUSH, [{ name: "agent-session:recorded", payload: {} }]);
    broadcast(CHANNELS.APP_CONFIG_RELOADED, []);

    expect(eventFrames(link).map((f) => f.channel)).toEqual([
      CHANNELS.EVENTS_PUSH,
      CHANNELS.APP_CONFIG_RELOADED,
    ]);
    expect(eventFrames(link)[0]!.args[0]).toMatchObject({ name: "agent-session:recorded" });
  });

  it("sends nothing a matching Shell would drop as unclassified, and keeps plugin pushes", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");

    broadcast("made:up", []);
    broadcast(CHANNELS.EVENTS_PUSH, [{ name: "made:up", payload: {} }]);
    broadcast(CHANNELS.EVENTS_PUSH, ["not an envelope"]);
    broadcast("plugin:acme:status", [{ ok: true }]);

    expect(eventFrames(link).map((f) => f.channel)).toEqual(["plugin:acme:status"]);
  });

  it("keeps a discarded push off a backed-up lane, so it starts no resync", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1");

    link.postResult = "refused";
    broadcast(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, [{ percent: 40 }]);
    link.postResult = "over-high-water";
    link.queued = 5_000;
    broadcast(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, [{ percent: 41 }]);
    vi.advanceTimersByTime(100);

    link.postResult = "queued";
    link.queued = 0;
    broadcast(CHANNELS.TERMINAL_DATA, ["t1", "hi"]);
    link.tick();
    expect(eventFrames(link).map((f) => f.channel)).toEqual([CHANNELS.TERMINAL_DATA]);
    expect(link.calls).toEqual([]);
  });

  it("follows the build of the Shell's latest attach across resumes", () => {
    const mismatch: HandshakeMismatch = { kind: "version", local: "1.2.3", remote: "1.2.4" };
    const sent = (link: ReturnType<typeof fakeLink>) => {
      broadcast(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, [{ percent: 40 }]);
      return eventFrames(link).length;
    };
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1");
    expect(sent(first)).toBe(0);

    first.drop();
    const second = fakeLink();
    server.attach("s1", second, true, "c1", mismatch);
    expect(sent(second)).toBe(1);

    second.drop();
    const third = fakeLink();
    server.attach("s1", third, true);
    expect(sent(third)).toBe(0);
  });

  it.each<[string, HandshakeMismatch]>([
    ["version", { kind: "version", local: "1.2.3", remote: "1.2.4" }],
    ["commit", { kind: "commit", local: "abc", remote: "def" }],
  ])(
    "keeps sending everything to a Shell on another %s, whose own tables decide",
    (_, mismatch) => {
      const link = fakeLink();
      server.attach("s1", link, false, "c1", mismatch);
      open(link, "view-1", "p1");

      broadcast(CHANNELS.UPDATE_DOWNLOAD_PROGRESS, [{ percent: 40 }]);
      broadcast(CHANNELS.EVENTS_PUSH, [{ name: "made:up", payload: {} }]);
      broadcast(CHANNELS.TERMINAL_DATA, ["t1", "hi"]);
      expect(eventFrames(link).map((f) => f.channel)).toEqual([
        CHANNELS.UPDATE_DOWNLOAD_PROGRESS,
        CHANNELS.EVENTS_PUSH,
        CHANNELS.TERMINAL_DATA,
      ]);
    }
  );
});

describe("SessionHost: endpoint changes a dropped link lost (#13917)", () => {
  function resumed(): ReturnType<typeof fakeLink> {
    const link = fakeLink();
    server.attach("s1", link, true);
    return link;
  }

  it("closes what a resumed Shell no longer holds, as the Shell's own close would", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1", "o1");
    open(first, "view-2", "p2", "o2");
    const kept = host.getEndpoint("s1", "view-1")!;
    const lost = host.getEndpoint("s1", "view-2")!;
    first.drop();

    const second = resumed();
    open(second, "view-1", "p1", "o1");
    second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1"] });

    expect(lost.closeCause).toBe("client-closed");
    expect(host.getEndpoint("s1", "view-2")).toBeUndefined();
    expect(registry.getRemote()).toEqual([kept]);
  });

  describe("with the endpoint cap full of what the Shell closed", () => {
    /** view-2's close was lost; view-3's repeated open finds the allowance of two taken. */
    function crowded() {
      const first = fakeLink();
      server.attach("s1", first);
      open(first, "view-1", "p1", "o1");
      open(first, "view-2", "p2", "o2");
      first.drop();
      const second = resumed();
      const opened = vi.fn();
      host.onEndpointOpened(opened);
      open(second, "view-1", "p1", "o1");
      open(second, "view-3", "p3", "o3");
      expect(host.getEndpoint("s1", "view-3")).toBeUndefined();
      return { second, opened };
    }

    it("opens the crowded-out view within the reconcile, and tells it to resync", () => {
      const { second, opened } = crowded();

      second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1", "view-3"] });

      expect(host.getEndpoint("s1", "view-2")).toBeUndefined();
      const reopened = host.getEndpoint("s1", "view-3")!;
      expect(reopened).toMatchObject({ projectId: "p3", openId: "o3" });
      // Its bridges are in place before the stream requests behind the call arrive.
      expect(opened).toHaveBeenCalledWith(reopened, expect.anything());
      expect(second.calls.at(-1)).toEqual({
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-3"], reason: "reattached" },
      });
    });

    it("opens it on the project the Shell moved it to since", () => {
      const { second } = crowded();
      second.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, {
        endpointId: "view-3",
        projectId: "p4",
      });
      second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1", "view-3"] });
      expect(host.getEndpoint("s1", "view-3")?.projectId).toBe("p4");
    });

    it("leaves closed a crowded-out view the Shell closed before reconciling", () => {
      const { second } = crowded();
      second.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-3" });
      second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1", "view-3"] });
      expect(host.getEndpoint("s1", "view-3")).toBeUndefined();
      expect(registry.getRemote()).toHaveLength(1);
    });
  });

  it("keeps an endpoint opened after the Shell's list, which the control lane put ahead of it", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1", "o1");
    open(first, "view-2", "p2", "o2");
    first.drop();

    const second = resumed();
    open(second, "view-1", "p1", "o1");
    // The Shell had closed view-2 and opened it again since it took the list.
    open(second, "view-2", "p2", "o3");
    const reopened = host.getEndpoint("s1", "view-2")!;
    second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1"] });

    expect(reopened.isClosed()).toBe(false);
    expect(registry.getRemote()).toHaveLength(2);
  });

  it("starts a view afresh when it is opened again under another open, and only then", () => {
    const link = fakeLink();
    server.attach("s1", link);
    open(link, "view-1", "p1", "o1");
    const first = host.getEndpoint("s1", "view-1")!;
    open(link, "view-1", "p1", "o1");
    // A Shell that names no open moves the endpoint, as it always has.
    open(link, "view-1", "p2");
    expect(host.getEndpoint("s1", "view-1")).toBe(first);
    expect(first.projectId).toBe("p2");

    open(link, "view-1", "p1", "o2");

    const reopened = host.getEndpoint("s1", "view-1")!;
    expect(reopened).not.toBe(first);
    expect(first.closeCause).toBe("client-closed");
    expect(reopened.projectId).toBe("p1");
    expect(registry.getRemote()).toEqual([reopened]);
  });

  it("tells the Shell to resync a view whose open the drop lost", () => {
    const first = fakeLink();
    server.attach("s1", first);
    open(first, "view-1", "p1", "o1");
    first.drop();

    const second = resumed();
    open(second, "view-1", "p1", "o1");
    open(second, "view-2", "p2", "o2");
    second.runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: ["view-1", "view-2"] });

    expect(second.calls).toEqual([
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-1"], reason: "reattached" },
      },
      {
        method: LinkMethod.ENDPOINT_RESYNC,
        payload: { endpointIds: ["view-2"], reason: "reattached" },
      },
    ]);
  });

  describe("and the drive lease the lost view held", () => {
    const GRACE_MS = 1_000;
    let lease: DriveLeaseService;

    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    beforeEach(() => {
      lease = new DriveLeaseService({
        registry,
        releaseGraceMs: GRACE_MS,
        now: () => 1_000,
        applyDriveLeases: () => {},
      });
      host.onTransportChange((endpointIds, attached) =>
        lease.noteEndpointTransport(endpointIds, attached)
      );
    });

    afterEach(() => lease.dispose());

    /** A laptop holding p closes its view, loses the close with its link, and comes back. */
    async function laptopLosesItsClose() {
      const laptop = fakeLink();
      server.attach("s1", laptop);
      open(laptop, "view-1", "p", "o1");
      await settle();
      const desk = fakeLink();
      server.attach("s2", desk, false, "c2");
      open(desk, "view-1", "p", "o1");
      await settle();
      expect(lease.getHolder("p")?.endpointId).toBe("remote:s1:view-1");
      laptop.drop();
      return {
        desk: host.getEndpoint("s2", "view-1")!,
        resume: async () => {
          resumed().runCall(LinkMethod.ENDPOINT_RECONCILE, { endpointIds: [] });
          await settle();
        },
      };
    }

    it("gives it up through the release grace, then to the successor", async () => {
      const { resume } = await laptopLosesItsClose();
      await resume();

      vi.advanceTimersByTime(GRACE_MS - 1);
      expect(lease.getHolder("p")?.endpointId).toBe("remote:s1:view-1");
      vi.advanceTimersByTime(1);
      expect(lease.getHolder("p")?.endpointId).toBe("remote:s2:view-1");
    });

    it("leaves a takeover made while the laptop was away where it is", async () => {
      const { desk, resume } = await laptopLosesItsClose();
      const taken = lease.takeOver("p", desk);
      await resume();

      vi.advanceTimersByTime(GRACE_MS * 2);
      expect(lease.getHolder("p")).toEqual(taken);
    });
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

  it("tells apart two installs that share a machine name, by the install each says it is", () => {
    const sessions = remembering();
    const first = { ...client("greg-mbp"), deviceId: "d-first" };
    const second = { ...client("greg-mbp"), deviceId: "d-second" };
    sessions.noteActiveProject(first, "p1");
    sessions.noteActiveProject(second, "p2");
    expect(sessions.lastActiveProject({ ...first, clientId: "first-relaunched" })?.projectId).toBe(
      "p1"
    );
    expect(sessions.lastActiveProject(second)?.projectId).toBe("p2");
    // A Shell too old to say which install it is still finds its machine's.
    sessions.noteActiveProject(client("greg-mbp"), "p2");
    expect(sessions.lastActiveProject(client("greg-mbp"))?.projectId).toBe("p2");
    expect(sessions.lastActiveProject(first)?.projectId).toBe("p1");
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

describe("SessionHost assistant liveness (#13349)", () => {
  /** Endpoint handle → the project its live assistant was launched for. */
  let liveAssistants: Map<number, string>;
  let sessions: SessionHost;
  let fake: ReturnType<typeof fakeServer>;
  let endpoints: EndpointRegistryImpl;

  beforeEach(() => {
    liveAssistants = new Map();
    fake = fakeServer();
    endpoints = new EndpointRegistryImpl();
    sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: endpoints,
      assistantLive: (endpoint) => liveAssistants.get(endpoint.handle) === endpoint.projectId,
    });
  });

  afterEach(() => sessions.dispose());

  const assistantCalls = (link: ReturnType<typeof fakeLink>) =>
    link.calls.filter(({ method }) => method === LinkMethod.ENDPOINT_ASSISTANT);
  const handleOf = (projectId: string) => endpoints.getForProject(projectId)[0]!.handle;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("tells the Shell when a view's assistant starts and stops, and nothing in between", () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    sessions.refreshAssistants();
    // A new endpoint has no assistant, which the Shell already assumes.
    expect(assistantCalls(link)).toEqual([]);

    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();
    sessions.refreshAssistants();
    expect(assistantCalls(link)).toEqual([
      {
        method: LinkMethod.ENDPOINT_ASSISTANT,
        payload: { endpoints: [{ endpointId: "view-1", projectId: "p1", live: true }] },
      },
    ]);

    liveAssistants.clear();
    sessions.refreshAssistants();
    expect(assistantCalls(link).at(-1)!.payload).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", live: false }],
    });
    expect(assistantCalls(link)).toHaveLength(2);
  });

  it("tells a resumed Shell every view's answer, including what changed while it was away", () => {
    const first = fakeLink();
    fake.attach("s1", first);
    open(first, "view-1", "p1");
    open(first, "view-2", "p2");
    liveAssistants.set(handleOf("p1"), "p1");
    liveAssistants.set(handleOf("p2"), "p2");
    sessions.refreshAssistants();
    first.drop();

    // The p1 assistant quit while nobody was attached to hear it.
    liveAssistants.delete(handleOf("p1"));
    sessions.refreshAssistants();

    const second = fakeLink();
    fake.attach("s1", second, true);
    expect(assistantCalls(second)).toEqual([
      {
        method: LinkMethod.ENDPOINT_ASSISTANT,
        payload: {
          endpoints: [
            { endpointId: "view-1", projectId: "p1", live: false },
            { endpointId: "view-2", projectId: "p2", live: true },
          ],
        },
      },
    ]);
  });

  it("answers again for a view that moved to another project", () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, { endpointId: "view-1", projectId: "p2" });

    expect(assistantCalls(link).at(-1)!.payload).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p2", live: false }],
    });
  });

  const coded = (code: string) => Object.assign(new Error(code), { code });
  const sentAssistants = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls.filter(([method]) => method === LinkMethod.ENDPOINT_ASSISTANT);

  it("asks an attached Shell again when it failed to take an answer", async () => {
    // A missed start would leave the view open to eviction until some other
    // terminal spawned or exited, so the retry can't wait for one.
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    link.call.mockRejectedValueOnce(coded("RATE_LIMITED"));
    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();
    await flush();
    expect(sentAssistants(link)).toHaveLength(1);

    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    expect(sentAssistants(link)).toHaveLength(2);
    expect(sentAssistants(link)[1]![1]).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", live: true }],
    });
  });

  it("doesn't keep asking a Shell from before the call", async () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    link.call.mockRejectedValueOnce(coded("UNSUPPORTED"));
    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();
    await flush();

    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    sessions.refreshAssistants();
    expect(sentAssistants(link)).toHaveLength(1);
  });

  it("answers for the other views when one view's read throws, and keeps what it last said", () => {
    const failing = new Set<string>();
    sessions.dispose();
    sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: endpoints,
      assistantLive: (endpoint) => {
        if (failing.has(endpoint.projectId ?? "")) throw new Error("backends unreadable");
        return liveAssistants.get(endpoint.handle) === endpoint.projectId;
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();

    failing.add("p1");
    liveAssistants.set(handleOf("p2"), "p2");
    expect(() => sessions.refreshAssistants()).not.toThrow();
    expect(assistantCalls(link).at(-1)!.payload).toEqual({
      endpoints: [{ endpointId: "view-2", projectId: "p2", live: true }],
    });

    // Readable again and unchanged: nothing to correct.
    failing.clear();
    sessions.refreshAssistants();
    expect(assistantCalls(link)).toHaveLength(2);
    error.mockRestore();
  });

  it("says nothing more about a view whose endpoint closed", () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    liveAssistants.set(handleOf("p1"), "p1");
    sessions.refreshAssistants();
    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, { endpointId: "view-1" });

    sessions.refreshAssistants();
    expect(assistantCalls(link)).toHaveLength(1);
  });
});

describe("SessionHost residency (#13933)", () => {
  /** Projects the user granted residency on this host. */
  let granted: Set<string>;
  let sessions: SessionHost;
  let fake: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    granted = new Set();
    fake = fakeServer();
    sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: new EndpointRegistryImpl(),
      keepResident: (endpoint) => granted.has(endpoint.projectId ?? ""),
    });
  });

  afterEach(() => sessions.dispose());

  const residencyCalls = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_RESIDENCY)
      .map(([, payload]) => payload);

  it("answers a view that opens onto a granted project, and only changes after", () => {
    granted.add("p1");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    expect(residencyCalls(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", keepResident: true }] },
      { endpoints: [{ endpointId: "view-2", projectId: "p2", keepResident: false }] },
    ]);

    sessions.refreshResidency();
    expect(residencyCalls(link)).toHaveLength(2);

    granted.delete("p1");
    granted.add("p2");
    sessions.refreshResidency();
    expect(residencyCalls(link).at(-1)).toEqual({
      endpoints: [
        { endpointId: "view-1", projectId: "p1", keepResident: false },
        { endpointId: "view-2", projectId: "p2", keepResident: true },
      ],
    });
  });

  it("answers again for a view that moved between two granted projects", () => {
    granted.add("p1");
    granted.add("p2");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, { endpointId: "view-1", projectId: "p2" });

    expect(residencyCalls(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p2", keepResident: true }],
    });
  });

  it("tells a resumed Shell every view's answer, including a grant made while it was away", () => {
    const first = fakeLink();
    fake.attach("s1", first);
    open(first, "view-1", "p1");
    first.drop();

    granted.add("p1");
    sessions.refreshResidency();

    const second = fakeLink();
    fake.attach("s1", second, true);
    expect(residencyCalls(second)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", keepResident: true }] },
    ]);
  });
});

describe("SessionHost MCP bindings (#14228)", () => {
  /** Projects an external MCP session here is bound to, live. */
  let bound: Set<string>;
  let sessions: SessionHost;
  let fake: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    bound = new Set();
    fake = fakeServer();
    sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: new EndpointRegistryImpl(),
      mcpBindingLive: (endpoint) => bound.has(endpoint.projectId ?? ""),
    });
  });

  afterEach(() => sessions.dispose());

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  const bindingCalls = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_MCP_BINDING)
      .map(([, payload]) => payload);

  it("answers a view that opens onto a bound project, and only changes after", () => {
    bound.add("p1");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    expect(bindingCalls(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: true }] },
      { endpoints: [{ endpointId: "view-2", projectId: "p2", liveBinding: false }] },
    ]);

    sessions.refreshMcpBindings();
    expect(bindingCalls(link)).toHaveLength(2);

    bound.delete("p1");
    bound.add("p2");
    sessions.refreshMcpBindings();
    expect(bindingCalls(link).at(-1)).toEqual({
      endpoints: [
        { endpointId: "view-1", projectId: "p1", liveBinding: false },
        { endpointId: "view-2", projectId: "p2", liveBinding: true },
      ],
    });
  });

  it("answers again for a view that moved between two bound projects", () => {
    bound.add("p1");
    bound.add("p2");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, { endpointId: "view-1", projectId: "p2" });

    expect(bindingCalls(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p2", liveBinding: true }],
    });
  });

  it("tells a resumed Shell every view's answer, including a session that bound while it was away", () => {
    const first = fakeLink();
    fake.attach("s1", first);
    open(first, "view-1", "p1");
    first.drop();

    bound.add("p1");
    sessions.refreshMcpBindings();

    const second = fakeLink();
    fake.attach("s1", second, true);
    expect(bindingCalls(second)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: true }] },
    ]);
  });

  it("asks an attached Shell again when it failed to take an answer, but not one from before the call", async () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    link.call.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "RATE_LIMITED" }));
    bound.add("p1");
    sessions.refreshMcpBindings();
    await flush();
    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    expect(bindingCalls(link)).toHaveLength(3);
    expect(bindingCalls(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: true }],
    });

    link.call.mockRejectedValueOnce(Object.assign(new Error("old"), { code: "UNSUPPORTED" }));
    bound.delete("p1");
    sessions.refreshMcpBindings();
    await flush();
    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    sessions.refreshMcpBindings();
    expect(bindingCalls(link)).toHaveLength(4);
  });
});

describe("SessionHost agent activity (#13359)", () => {
  /** Projects with an agent working, waiting or directing here. */
  let activeProjects: Set<string>;
  let sessions: SessionHost;
  let fake: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    activeProjects = new Set();
    fake = fakeServer();
    sessions = new SessionHost(fake, {
      dispatcher: { invokeForEndpoint: async () => wrapSuccess(null), sendForEndpoint: () => {} },
      registry: new EndpointRegistryImpl(),
      agentActive: (endpoint) => activeProjects.has(endpoint.projectId ?? ""),
    });
  });

  afterEach(() => sessions.dispose());

  // Every attempt, delivered or refused.
  const agentCalls = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_AGENT_ACTIVITY)
      .map(([, payload]) => payload);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it("answers a view that opens onto agents already working, and only changes after", () => {
    activeProjects.add("p1");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    open(link, "view-2", "p2");
    expect(agentCalls(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }] },
      { endpoints: [{ endpointId: "view-2", projectId: "p2", active: false }] },
    ]);

    sessions.refreshAgentActivity();
    expect(agentCalls(link)).toHaveLength(2);

    activeProjects.delete("p1");
    activeProjects.add("p2");
    sessions.refreshAgentActivity();
    expect(agentCalls(link).at(-1)).toEqual({
      endpoints: [
        { endpointId: "view-1", projectId: "p1", active: false },
        { endpointId: "view-2", projectId: "p2", active: true },
      ],
    });
  });

  it("answers again for a view that moved between two projects with active agents", () => {
    // The Shell drops a view's answer when it moves, so an unchanged boolean
    // still has to be said about the new binding.
    activeProjects.add("p1");
    activeProjects.add("p2");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");

    link.emit(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, { endpointId: "view-1", projectId: "p2" });

    expect(agentCalls(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p2", active: true }],
    });
  });

  it("tells a resumed Shell every view's answer, including what changed while it was away", () => {
    activeProjects.add("p1");
    const first = fakeLink();
    fake.attach("s1", first);
    open(first, "view-1", "p1");
    open(first, "view-2", "p2");
    first.drop();

    activeProjects.clear();
    activeProjects.add("p2");
    sessions.refreshAgentActivity();

    const second = fakeLink();
    fake.attach("s1", second, true);
    expect(agentCalls(second)).toEqual([
      {
        endpoints: [
          { endpointId: "view-1", projectId: "p1", active: false },
          { endpointId: "view-2", projectId: "p2", active: true },
        ],
      },
    ]);
  });

  it("asks an attached Shell again when it failed to take an answer, but not one from before the call", async () => {
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    link.call.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "RATE_LIMITED" }));
    activeProjects.add("p1");
    sessions.refreshAgentActivity();
    await flush();
    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    expect(agentCalls(link)).toHaveLength(3);
    expect(agentCalls(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }],
    });

    link.call.mockRejectedValueOnce(Object.assign(new Error("old"), { code: "UNSUPPORTED" }));
    activeProjects.delete("p1");
    sessions.refreshAgentActivity();
    await flush();
    vi.advanceTimersByTime(ANSWER_RETRY_MS);
    sessions.refreshAgentActivity();
    expect(agentCalls(link)).toHaveLength(4);
  });

  it("keeps the assistant answer to itself", () => {
    activeProjects.add("p1");
    const link = fakeLink();
    fake.attach("s1", link);
    open(link, "view-1", "p1");
    sessions.refreshAssistants();
    expect(link.call.mock.calls.map(([method]) => method)).toEqual([
      LinkMethod.ENDPOINT_AGENT_ACTIVITY,
    ]);
  });
});
