import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backends, ptyRef } = vi.hoisted(() => ({
  backends: new Map<string, Array<{ terminalId: string; webContentsId: number; slot: number }>>(),
  ptyRef: { current: null as unknown },
}));

vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getAssistantBackends: (projectId: string) => backends.get(projectId) ?? [],
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => ptyRef.current }));
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

/** PtyClient's spawn registry and the two events the host follows. */
class FakePty extends EventEmitter {
  readonly live = new Set<string>();
  hasTerminal(id: string): boolean {
    return this.live.has(id);
  }
}

type Listener = (body: unknown) => void;

function fakeLink() {
  const listeners = new Map<string, Set<Listener>>();
  return {
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
    onClose: () => () => {},
    registerCallHandler: () => () => {},
    setInvokeHandler: () => {},
    setSendHandler: () => {},
    open(endpointId: string, projectId: string) {
      for (const l of listeners.get(`${Lane.CONTROL}/${ControlKind.ENDPOINT_OPEN}`) ?? []) {
        l({ endpointId, projectId });
      }
    },
  };
}

function fakeServer() {
  const sessionListeners = new Set<(ctx: HostSessionContext) => void>();
  return {
    onSession: (l: (ctx: HostSessionContext) => void) => {
      sessionListeners.add(l);
      return () => sessionListeners.delete(l);
    },
    onSessionExpired: () => () => {},
    attach(link: ReturnType<typeof fakeLink>) {
      for (const l of sessionListeners) {
        l({
          sessionId: "s1",
          resumed: false,
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
    expect(pty.listenerCount("exit")).toBe(1);
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
    expect(vi.getTimerCount()).toBe(0);
  });
});
