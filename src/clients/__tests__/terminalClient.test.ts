import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track IPC onData subscriptions so we can simulate IPC data delivery
const ipcOnDataHandlers: Array<{ id: string; cb: (data: string | Uint8Array) => void }> = [];
const ipcOnDataCleanups: Array<() => void> = [];

const mockElectronTerminal = {
  onData: vi.fn((id: string, cb: (data: string | Uint8Array) => void) => {
    const entry = { id, cb };
    ipcOnDataHandlers.push(entry);
    const cleanup = () => {
      const idx = ipcOnDataHandlers.indexOf(entry);
      if (idx >= 0) ipcOnDataHandlers.splice(idx, 1);
    };
    ipcOnDataCleanups.push(cleanup);
    return cleanup;
  }),
  spawn: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  submit: vi.fn(),
  sendKey: vi.fn(),
  kill: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  onExit: vi.fn(() => () => {}),
  onAgentStateChanged: vi.fn(() => () => {}),
  onAgentDetected: vi.fn(() => () => {}),
  onAgentExited: vi.fn(() => () => {}),
  onActivity: vi.fn(() => () => {}),
  onTrashed: vi.fn(() => () => {}),
  onRestored: vi.fn(() => () => {}),
  setActivityTier: vi.fn(),
  wake: vi.fn(),
  acknowledgeData: vi.fn(),
  getForProject: vi.fn(),
  reconnect: vi.fn(),
  replayHistory: vi.fn(),
  getSerializedState: vi.fn(),
  getSerializedStates: vi.fn(),
  getSharedBuffers: vi.fn(),
  forceResume: vi.fn(),
  onStatus: vi.fn(() => () => {}),
  onBackendCrashed: vi.fn(() => () => {}),
  onBackendReady: vi.fn(() => () => {}),
  onSpawnResult: vi.fn(() => () => {}),
  onReduceScrollback: vi.fn(() => () => {}),
  onRestoreScrollback: vi.fn(() => () => {}),
  restartService: vi.fn(),
};

// Each test re-imports terminalClient fresh via vi.resetModules()
let terminalClient: typeof import("../terminalClient").terminalClient;

// Store window.addEventListener calls so we can fire them
let windowMessageListeners: Array<(e: MessageEvent) => void> = [];

const typedGlobal = globalThis as unknown as Record<string, unknown>;

describe("terminalClient MessagePort data routing", () => {
  beforeEach(async () => {
    vi.resetModules();
    ipcOnDataHandlers.length = 0;
    ipcOnDataCleanups.length = 0;
    windowMessageListeners = [];

    // Set up minimal window mock
    const windowMock = {
      top: null as unknown,
      electron: { terminal: mockElectronTerminal },
      location: { origin: "http://localhost", protocol: "http:" },
      addEventListener: vi.fn((type: string, handler: (e: MessageEvent) => void) => {
        if (type === "message") windowMessageListeners.push(handler);
      }),
    };
    // window.top must === window for the guard
    windowMock.top = windowMock;
    typedGlobal.window = windowMock;

    vi.clearAllMocks();

    const mod = await import("../terminalClient");
    terminalClient = mod.terminalClient;
  });

  afterEach(() => {
    delete typedGlobal.window;
  });

  function acquirePort(): MessagePort {
    const mc = new MessageChannel();
    const port = mc.port1;

    // Simulate token then port delivery (normal order)
    const token = "test-token-" + Math.random();
    fireWindowMessage({ type: "terminal-port-token", token });
    fireWindowMessage({ type: "terminal-port", token }, [mc.port2]);

    return port;
  }

  function fireWindowMessage(data: Record<string, unknown>, ports?: MessagePort[]) {
    const event = {
      data,
      ports: ports || [],
      source: typedGlobal.window,
      origin: "http://localhost",
    } as unknown as MessageEvent;
    for (const listener of windowMessageListeners) {
      listener(event);
    }
  }

  it("dispatches MessagePort data to onData callbacks", () => {
    const port = acquirePort();
    const received: string[] = [];

    terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    });

    // Simulate pty-host sending data over the port
    port.postMessage({ type: "data", id: "term-1", data: "hello world" });

    // MessageChannel is async — use a small delay
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toContain("hello world");
        resolve();
      }, 50);
    });
  });

  it("suppresses IPC data when MessagePort is connected", () => {
    acquirePort();
    const received: string[] = [];

    terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : "binary");
    });

    // Simulate IPC data delivery
    const handler = ipcOnDataHandlers.find((h) => h.id === "term-1");
    expect(handler).toBeDefined();
    handler!.cb("ipc-data");

    // IPC data should be suppressed
    expect(received).toEqual([]);
  });

  it("delivers IPC data when no MessagePort is connected", () => {
    const received: string[] = [];

    terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : "binary");
    });

    // Simulate IPC data delivery (no port acquired)
    const handler = ipcOnDataHandlers.find((h) => h.id === "term-1");
    expect(handler).toBeDefined();
    handler!.cb("ipc-data");

    expect(received).toEqual(["ipc-data"]);
  });

  it("cleans up callback registry on unsubscribe", () => {
    acquirePort();
    const received: string[] = [];

    const unsub = terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : "binary");
    });

    unsub();

    // IPC handler should also be cleaned up
    const handler = ipcOnDataHandlers.find((h) => h.id === "term-1");
    expect(handler).toBeUndefined();
  });

  it("buffers early MessagePort data and flushes on onData registration", () => {
    const port = acquirePort();

    // Send data BEFORE any onData callback is registered
    port.postMessage({ type: "data", id: "term-early", data: "chunk-1" });
    port.postMessage({ type: "data", id: "term-early", data: "chunk-2" });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Now register a callback — buffered data should flush immediately
        const received: string[] = [];
        terminalClient.onData("term-early", (data) => {
          received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
        });

        expect(received).toEqual(["chunk-1", "chunk-2"]);
        resolve();
      }, 50);
    });
  });

  it("dispatches to correct terminal only", () => {
    const port = acquirePort();
    const received1: string[] = [];
    const received2: string[] = [];

    terminalClient.onData("term-1", (d) => received1.push(d as string));
    terminalClient.onData("term-2", (d) => received2.push(d as string));

    port.postMessage({ type: "data", id: "term-2", data: "for-term-2" });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received1).toEqual([]);
        expect(received2).toContain("for-term-2");
        resolve();
      }, 50);
    });
  });
});
