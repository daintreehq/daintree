import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backends, ptyRef, mcpRef } = vi.hoisted(() => ({
  backends: new Map<string, Array<{ terminalId: string; webContentsId: number; slot: number }>>(),
  ptyRef: { current: null as unknown },
  mcpRef: { current: null as unknown },
}));

vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getAssistantBackends: (projectId: string) => backends.get(projectId) ?? [],
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => ptyRef.current,
  getMcpServerServiceRef: () => mcpRef.current,
}));
vi.mock("../../../ipc/dispatcher.js", () => ({ getIpcDispatcher: () => ({}) }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: {} }));
vi.mock("../../../services/ScratchStore.js", () => ({ scratchStore: {} }));
vi.mock("../../../services/PowerSaveBlockerService.js", () => ({
  setAttachedFrontendCount: () => {},
}));

import { EndpointRegistryImpl } from "../../../ipc/endpointRegistry.js";
import { _resetRemoteServicesForTest } from "../../runtime.js";
import { Lane } from "../../link/frames.js";
import { ControlKind } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import type { HostSessionContext } from "../HostServer.js";
import { ASSISTANT_SWEEP_MS, initRemoteHostsHost } from "../initHost.js";
import { LinkMethod } from "../linkMethods.js";
import { events } from "../../../services/events.js";

/** PtyClient's spawn registry, its inventory, and the events the host follows. */
class FakePty extends EventEmitter {
  readonly live = new Set<string>();
  readonly owners = new Map<string, string>();
  inventory: Array<{ id: string; projectId: string; agentState?: "working" | "idle" }> = [];
  inventoryReads = 0;
  hasTerminal(id: string): boolean {
    return this.live.has(id);
  }
  getTerminalProjectId(id: string): string | null {
    return this.owners.get(id) ?? null;
  }
  async getAllTerminalsWithCompletenessAsync() {
    this.inventoryReads++;
    return { terminals: [...this.inventory], degraded: false };
  }
}

type Listener = (body: unknown) => void;

function fakeLink() {
  const listeners = new Map<string, Set<Listener>>();
  const closeListeners = new Set<() => void>();
  const link = {
    isOpen: true,
    isClosed: false,
    call: vi.fn(async (_method: string, _payload: unknown): Promise<unknown> => null),
    on(lane: number, kind: number, listener: Listener) {
      const key = `${lane}/${kind}`;
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
    onWritable: () => () => {},
    onClose(cb: () => void) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    registerCallHandler: () => () => {},
    setInvokeHandler: () => {},
    setSendHandler: () => {},
    open(endpointId: string, projectId: string) {
      for (const l of listeners.get(`${Lane.CONTROL}/${ControlKind.ENDPOINT_OPEN}`) ?? []) {
        l({ endpointId, projectId });
      }
    },
    close(endpointId: string) {
      for (const l of listeners.get(`${Lane.CONTROL}/${ControlKind.ENDPOINT_CLOSE}`) ?? []) {
        l({ endpointId });
      }
    },
    drop() {
      link.isOpen = false;
      link.isClosed = true;
      for (const cb of [...closeListeners]) cb();
    },
  };
  return link;
}

function fakeServer() {
  const sessionListeners = new Set<(ctx: HostSessionContext) => void>();
  return {
    onSession: (l: (ctx: HostSessionContext) => void) => {
      sessionListeners.add(l);
      return () => sessionListeners.delete(l);
    },
    onSessionExpired: () => () => {},
    attach(link: ReturnType<typeof fakeLink>, resumed = false) {
      for (const l of sessionListeners) {
        l({
          sessionId: "s1",
          resumed,
          client: { clientId: "c1", clientName: "greg-mbp", platform: "darwin" },
          session: link as unknown as LinkSession,
        });
      }
    },
  };
}

let registry: EndpointRegistryImpl;
let server: ReturnType<typeof fakeServer>;
let host: ReturnType<typeof initRemoteHostsHost> | null;

beforeEach(() => {
  vi.useFakeTimers();
  backends.clear();
  ptyRef.current = null;
  mcpRef.current = null;
  registry = new EndpointRegistryImpl();
  server = fakeServer();
  host = null;
});

afterEach(() => {
  host?.dispose();
  _resetRemoteServicesForTest();
  vi.useRealTimers();
});

function start() {
  host = initRemoteHostsHost(server, { registry });
  return host;
}

const assistantAnswers = (link: ReturnType<typeof fakeLink>) =>
  link.call.mock.calls
    .filter(([method]) => method === LinkMethod.ENDPOINT_ASSISTANT)
    .map(([, payload]) => payload);

describe("initRemoteHostsHost assistant liveness (#13349)", () => {
  it("tells the Shell when a view's assistant PTY spawns and when it exits", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    const handle = registry.getRemote()[0]!.handle;

    // The binding is made before the PTY spawns, so it alone says nothing.
    backends.set("p1", [{ terminalId: "t-help", webContentsId: handle, slot: 0 }]);
    pty.live.add("t-help");
    pty.emit("spawn-result", "t-help", { success: true });
    expect(assistantAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", live: true }] },
    ]);

    pty.live.delete("t-help");
    pty.emit("exit", "t-help", 0);
    expect(assistantAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", live: false }],
    });
  });

  it("counts a lane only when it is pinned to this view and its own PTY is alive (#12108)", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    const handle = registry.getRemote()[0]!.handle;

    // A dead lane pinned here, and a live lane pinned to another view.
    backends.set("p1", [
      { terminalId: "t-dead", webContentsId: handle, slot: 0 },
      { terminalId: "t-elsewhere", webContentsId: handle - 1, slot: 1 },
    ]);
    pty.live.add("t-elsewhere");
    pty.emit("spawn-result", "t-elsewhere", { success: true });
    expect(assistantAnswers(link)).toEqual([]);

    backends.get("p1")!.push({ terminalId: "t-live", webContentsId: handle, slot: 2 });
    pty.live.add("t-live");
    pty.emit("spawn-result", "t-live", { success: true });
    expect(assistantAnswers(link)).toHaveLength(1);
  });

  it("starts following the PTY client once it exists, when a view opens", () => {
    start();
    const pty = new FakePty();
    ptyRef.current = pty;
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    link.open("view-2", "p1");

    expect(pty.listenerCount("spawn-result")).toBe(1);
    // One for the assistant answers, one for the agent activity cache.
    expect(pty.listenerCount("exit")).toBe(2);
    expect(pty.listenerCount("host-crash")).toBe(1);
  });

  it("catches an end that no exit reported, on its sweep", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    backends.set("p1", [
      { terminalId: "t-help", webContentsId: registry.getRemote()[0]!.handle, slot: 0 },
    ]);
    pty.live.add("t-help");
    pty.emit("spawn-result", "t-help", { success: true });

    // Revoked with no exit to follow: the binding is simply gone.
    backends.clear();
    vi.advanceTimersByTime(ASSISTANT_SWEEP_MS);
    expect(assistantAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", live: false }],
    });
  });

  it("stops following the PTY client and the sweep on dispose", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    const { dispose } = start();
    dispose();
    host = null;

    expect(pty.listenerCount("spawn-result")).toBe(0);
    expect(pty.listenerCount("exit")).toBe(0);
    expect(pty.listenerCount("host-crash")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("initRemoteHostsHost agent activity (#13359)", () => {
  const agentAnswers = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_AGENT_ACTIVITY)
      .map(([, payload]) => payload);
  const stateChanged = (terminalId: string, state: "working" | "idle") =>
    events.emit("agent:state-changed", {
      terminalId,
      state,
      previousState: state === "working" ? "idle" : "working",
      timestamp: Date.now(),
      trigger: "output",
      confidence: 1,
    } as never);

  it("tells the Shell when an agent in a view's project starts and stops working", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    expect(agentAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", active: false }] },
    ]);

    pty.owners.set("t-agent", "p1");
    stateChanged("t-agent", "working");
    expect(agentAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }],
    });

    stateChanged("t-agent", "idle");
    expect(agentAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: false }],
    });

    // Another project's agent says nothing about this view.
    pty.owners.set("t-other", "p2");
    stateChanged("t-other", "working");
    expect(agentAnswers(link)).toHaveLength(3);
  });

  it("reads the inventory again on its sweep, for agents no event told it about", async () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    await vi.advanceTimersByTimeAsync(0);

    pty.inventory = [{ id: "t-agent", projectId: "p1", agentState: "working" }];
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS);
    expect(agentAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }],
    });
  });

  it("stops following agent state on dispose", () => {
    const listeners = () =>
      (events as unknown as { bus: { listenerCount(e: string): number } }).bus.listenerCount(
        "agent:state-changed"
      );
    const before = listeners();
    const pty = new FakePty();
    ptyRef.current = pty;
    const { dispose } = start();
    expect(listeners()).toBe(before + 1);
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    dispose();
    host = null;

    expect(listeners()).toBe(before);
    pty.owners.set("t-agent", "p1");
    stateChanged("t-agent", "working");
    expect(agentAnswers(link)).toHaveLength(1);
  });
});

describe("initRemoteHostsHost MCP bindings (#14228)", () => {
  /** Workspaces an external MCP session here is bound to, live. */
  let bound: Set<string>;
  let reads: Array<[string, number]>;

  beforeEach(() => {
    bound = new Set();
    reads = [];
    mcpRef.current = {
      getWorkspaceViewActivity: (workspaceId: string, webContentsId: number) => {
        reads.push([workspaceId, webContentsId]);
        return { liveBinding: bound.has(workspaceId), dispatchLease: true };
      },
    };
  });

  const bindingAnswers = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_MCP_BINDING)
      .map(([, payload]) => payload);

  it("answers a view that opens onto a project a session is already bound to", () => {
    bound.add("p1");
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");

    expect(bindingAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: true }] },
    ]);
    expect(reads).toContainEqual(["p1", registry.getRemote()[0]!.handle]);
  });

  it("catches a session binding and dropping against an open view on its sweep", () => {
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    expect(bindingAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: false }] },
    ]);

    bound.add("p1");
    vi.advanceTimersByTime(ASSISTANT_SWEEP_MS);
    expect(bindingAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: true }],
    });

    bound.clear();
    vi.advanceTimersByTime(ASSISTANT_SWEEP_MS);
    expect(bindingAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: false }],
    });
  });

  it("reads no binding before the MCP service has loaded", () => {
    mcpRef.current = null;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");

    expect(bindingAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", liveBinding: false }] },
    ]);
  });
});

describe("initRemoteHostsHost inventory reads (#15907)", () => {
  const agentAnswers = (link: ReturnType<typeof fakeLink>) =>
    link.call.mock.calls
      .filter(([method]) => method === LinkMethod.ENDPOINT_AGENT_ACTIVITY)
      .map(([, payload]) => payload);
  const stateChanged = (terminalId: string, state: "working" | "idle") =>
    events.emit("agent:state-changed", {
      terminalId,
      state,
      previousState: state === "working" ? "idle" : "working",
      timestamp: Date.now(),
      trigger: "output",
      confidence: 1,
    } as never);

  it("reads no inventory while no Shell has a view open here", async () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 4);
    expect(pty.inventoryReads).toBe(0);

    // A Shell attached for summaries and listings reads no view's answers.
    server.attach(fakeLink());
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 4);
    expect(pty.inventoryReads).toBe(0);
  });

  it("takes a fresh reading when a view opens, and tells the Shell what it found", async () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 3);
    // An agent whose start no event reported while nobody was attached.
    pty.inventory = [{ id: "t-agent", projectId: "p1", agentState: "working" }];

    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    expect(pty.inventoryReads).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(agentAnswers(link).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }],
    });
  });

  it("stops reading when the last view closes, and reads fresh when one opens again", async () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    link.open("view-2", "p2");
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS);
    // One read per opening, then one on the sweep.
    expect(pty.inventoryReads).toBe(3);

    link.close("view-1");
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS);
    expect(pty.inventoryReads).toBe(4);

    link.close("view-2");
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 3);
    expect(pty.inventoryReads).toBe(4);

    link.open("view-3", "p1");
    expect(pty.inventoryReads).toBe(5);
  });

  it("reads nothing while a Shell is away, and reads fresh when it comes back to its views", async () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.inventoryReads).toBe(1);

    link.drop();
    pty.inventory = [{ id: "t-agent", projectId: "p1", agentState: "working" }];
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 3);
    expect(pty.inventoryReads).toBe(1);

    const resumed = fakeLink();
    server.attach(resumed, true);
    expect(pty.inventoryReads).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(agentAnswers(resumed).at(-1)).toEqual({
      endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }],
    });
  });

  it("seeds a PTY client that appears only when a view opens with one reading", async () => {
    start();
    const pty = new FakePty();
    ptyRef.current = pty;
    await vi.advanceTimersByTimeAsync(ASSISTANT_SWEEP_MS * 2);
    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.inventoryReads).toBe(1);
  });

  it("follows agent state while nobody reads it, for the first view to open", () => {
    const pty = new FakePty();
    ptyRef.current = pty;
    start();
    pty.owners.set("t-agent", "p1");
    stateChanged("t-agent", "working");

    const link = fakeLink();
    server.attach(link);
    link.open("view-1", "p1");
    expect(agentAnswers(link)).toEqual([
      { endpoints: [{ endpointId: "view-1", projectId: "p1", active: true }] },
    ]);
  });
});
