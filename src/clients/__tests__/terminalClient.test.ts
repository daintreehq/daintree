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
  onBackendRecovering: vi.fn(() => () => {}),
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
      postMessage: vi.fn(),
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

  it("announces readiness after installing the MessagePort listener", () => {
    const windowMock = typedGlobal.window as { postMessage: ReturnType<typeof vi.fn> };

    expect(windowMock.postMessage).toHaveBeenCalledWith(
      { type: "terminal-port-ready" },
      "http://localhost"
    );
    expect(windowMessageListeners).toHaveLength(1);
  });

  it("dispatches MessagePort data to onData callbacks", () => {
    const port = acquirePort();
    const received: string[] = [];

    terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    });

    // Simulate pty-host sending data over the port
    port.postMessage({ type: "data", id: "term-1", data: "hello world", bytes: 11 });

    // MessageChannel is async — use a small delay
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toContain("hello world");
        resolve();
      }, 50);
    });
  });

  it("delivers IPC data even when MessagePort is connected (pty-host ensures single path via visualWritten)", () => {
    acquirePort();
    const received: string[] = [];

    terminalClient.onData("term-1", (data) => {
      received.push(typeof data === "string" ? data : "binary");
    });

    // Simulate IPC data delivery
    const handler = ipcOnDataHandlers.find((h) => h.id === "term-1");
    expect(handler).toBeDefined();
    handler!.cb("ipc-data");

    // IPC data is delivered because pty-host ensures each chunk is sent through exactly
    // ONE visual path (MessagePort, SAB, or IPC) via a visualWritten flag, preventing double delivery.
    // Previously IPC was suppressed here, but that caused data loss during project switch when
    // the pty-host routed through IPC instead of MessagePort due to windowProjectMap latency.
    expect(received).toEqual(["ipc-data"]);
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
    port.postMessage({ type: "data", id: "term-early", data: "chunk-1", bytes: 7 });
    port.postMessage({ type: "data", id: "term-early", data: "chunk-2", bytes: 7 });

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

  it("evicts the OLDEST early-buffered chunks when the byte cap is exceeded", () => {
    const port = acquirePort();

    // 3 × 200KB chunks exceed the 512KB early-buffer byte cap — the first
    // chunk must be evicted (the head is recoverable from the host snapshot;
    // the live tail is not).
    const big = "x".repeat(200 * 1024);
    port.postMessage({ type: "data", id: "term-early", data: `${big}1`, bytes: 1 });
    port.postMessage({ type: "data", id: "term-early", data: `${big}2`, bytes: 1 });
    port.postMessage({ type: "data", id: "term-early", data: `${big}3`, bytes: 1 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const received: string[] = [];
        terminalClient.onData("term-early", (data) => {
          received.push((data as string).slice(-1));
        });

        expect(received).toEqual(["2", "3"]);
        resolve();
      }, 50);
    });
  });

  it("keeps a single over-cap chunk rather than dropping everything", () => {
    const port = acquirePort();

    const huge = "y".repeat(600 * 1024);
    port.postMessage({ type: "data", id: "term-early", data: huge, bytes: 1 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const received: string[] = [];
        terminalClient.onData("term-early", (data) => {
          received.push(data as string);
        });

        expect(received).toEqual([huge]);
        resolve();
      }, 50);
    });
  });

  it("does NOT send immediate ack when live callbacks are registered", () => {
    const port = acquirePort();

    terminalClient.onData("term-1", () => {});

    port.postMessage({ type: "data", id: "term-1", data: "hello", bytes: 42 });

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack" && msg.id === "term-1") {
          acks.push(msg);
        }
      });
      port.start();

      // Wait and verify no ack arrived — ACK is deferred to xterm write callback
      setTimeout(() => {
        expect(acks).toEqual([]);
        resolve();
      }, 100);
    });
  });

  it("sends immediate ack for early-buffered data (no callbacks registered)", () => {
    const port = acquirePort();

    // No onData registered — data goes to early buffer with immediate ACK
    port.postMessage({ type: "data", id: "term-early", data: "hello", bytes: 42 });

    return new Promise<void>((resolve) => {
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack" && msg.id === "term-early") {
          expect(msg.bytes).toBe(42);
          resolve();
        }
      });
      port.start();
    });
  });

  it("falls back to 0 bytes for early-buffered ack when msg.bytes is missing", () => {
    const port = acquirePort();

    // No onData registered — early buffer path
    port.postMessage({ type: "data", id: "term-early", data: "hello" } as unknown);

    return new Promise<void>((resolve) => {
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack" && msg.id === "term-early") {
          expect(msg.bytes).toBe(0);
          resolve();
        }
      });
      port.start();
    });
  });

  it("acknowledgePortData sends deferred ack with original msg.bytes", () => {
    const port = acquirePort();

    // Register callback so data goes through the live path (queues byte count)
    terminalClient.onData("term-1", () => {});

    // Send data with bytes: 42 (original pty-host UTF-8 byte count)
    port.postMessage({ type: "data", id: "term-1", data: "hello", bytes: 42 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Now call acknowledgePortData — it should use the queued 42, not the passed 999
        terminalClient.acknowledgePortData("term-1", 999);

        port.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack" && msg.id === "term-1") {
            expect(msg.bytes).toBe(42);
            resolve();
          }
        });
        port.start();
      }, 50);
    });
  });

  it("acknowledgePortData settles chunkCount FIFO entries as one summed ack, leaving the rest", () => {
    const port = acquirePort();

    terminalClient.onData("term-1", () => {});
    // Three pending entries — a coalesced write of the first two must ack
    // 10 + 20 in ONE message and leave the 12-byte entry queued.
    port.postMessage({ type: "data", id: "term-1", data: "aaaaaaaaaa", bytes: 10 });
    port.postMessage({ type: "data", id: "term-1", data: "bbbbbbbbbbbbbbbbbbbb", bytes: 20 });
    port.postMessage({ type: "data", id: "term-1", data: "cccccccccccc", bytes: 12 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const acks: Record<string, unknown>[] = [];
        port.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack" && msg.id === "term-1") acks.push(msg);
        });
        port.start();

        terminalClient.acknowledgePortData("term-1", 999, 2);
        terminalClient.acknowledgePortData("term-1", 999);
        // FIFO is now empty — an over-counted request degrades to a no-op.
        terminalClient.acknowledgePortData("term-1", 999, 5);

        setTimeout(() => {
          expect(acks).toEqual([
            { type: "ack", id: "term-1", bytes: 30 },
            { type: "ack", id: "term-1", bytes: 12 },
          ]);
          resolve();
        }, 100);
      }, 50);
    });
  });

  it("acknowledgePortData is a no-op when no port is connected", () => {
    // No port acquired — should not throw
    expect(() => terminalClient.acknowledgePortData("term-1", 42)).not.toThrow();
  });

  it("acknowledgePortData is a no-op when byte queue is empty (IPC or early-flush data)", () => {
    const port = acquirePort();

    // Call acknowledgePortData without any prior port data dispatch (simulates
    // IPC data or early-buffer flush reaching writeToTerminal)
    terminalClient.acknowledgePortData("term-1", 100);

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack") acks.push(msg);
      });
      port.start();

      setTimeout(() => {
        expect(acks).toEqual([]);
        resolve();
      }, 100);
    });
  });

  it("discardPortAcks posts a single batched ack with the summed FIFO total and clears the queue", () => {
    const port = acquirePort();

    // Live path: queue three pending ack entries (10 + 20 + 12 bytes).
    terminalClient.onData("term-1", () => {});
    port.postMessage({ type: "data", id: "term-1", data: "aaaaaaaaaa", bytes: 10 });
    port.postMessage({ type: "data", id: "term-1", data: "bbbbbbbbbbbbbbbbbbbb", bytes: 20 });
    port.postMessage({ type: "data", id: "term-1", data: "cccccccccccc", bytes: 12 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const acks: Record<string, unknown>[] = [];
        port.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack" && msg.id === "term-1") acks.push(msg);
        });
        port.start();

        terminalClient.discardPortAcks("term-1");
        // The FIFO is now empty — a follow-up acknowledgePortData must not
        // double-ack the discarded bytes.
        terminalClient.acknowledgePortData("term-1", 999);

        setTimeout(() => {
          expect(acks).toEqual([{ type: "ack", id: "term-1", bytes: 42 }]);
          resolve();
        }, 100);
      }, 50);
    });
  });

  it("discardPortAcks sums the stored pty-host byte counts, not renderer string lengths", () => {
    const port = acquirePort();

    terminalClient.onData("term-1", () => {});
    // UTF-8 multi-byte content: msg.bytes (pty-host count) differs from
    // data.length (UTF-16 code units). The FIFO stores msg.bytes.
    port.postMessage({ type: "data", id: "term-1", data: "a", bytes: 300 });
    port.postMessage({ type: "data", id: "term-1", data: "b", bytes: 7 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const acks: Record<string, unknown>[] = [];
        port.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack" && msg.id === "term-1") acks.push(msg);
        });
        port.start();

        terminalClient.discardPortAcks("term-1");

        setTimeout(() => {
          expect(acks).toEqual([{ type: "ack", id: "term-1", bytes: 307 }]);
          resolve();
        }, 100);
      }, 50);
    });
  });

  it("discardPortAcks is a no-op when the FIFO is empty", () => {
    const port = acquirePort();

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack") acks.push(msg);
      });
      port.start();

      terminalClient.discardPortAcks("term-1");

      setTimeout(() => {
        expect(acks).toEqual([]);
        resolve();
      }, 100);
    });
  });

  it("discardPortAcks does not throw when no port is connected", () => {
    expect(() => terminalClient.discardPortAcks("term-1")).not.toThrow();
  });

  it("discardPortAcks does not leak the FIFO across terminals", () => {
    const port = acquirePort();

    terminalClient.onData("term-1", () => {});
    terminalClient.onData("term-2", () => {});
    port.postMessage({ type: "data", id: "term-1", data: "aaaa", bytes: 4 });
    port.postMessage({ type: "data", id: "term-2", data: "bbbbbb", bytes: 6 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const acks: Record<string, unknown>[] = [];
        port.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack") acks.push(msg);
        });
        port.start();

        terminalClient.discardPortAcks("term-1");
        // term-2's entry must survive and ack normally.
        terminalClient.acknowledgePortData("term-2", 999);

        setTimeout(() => {
          expect(acks).toEqual([
            { type: "ack", id: "term-1", bytes: 4 },
            { type: "ack", id: "term-2", bytes: 6 },
          ]);
          resolve();
        }, 100);
      }, 50);
    });
  });

  it("port replacement clears the pending-ack FIFO — stale entries never debit the fresh generation", () => {
    // Generation A: two chunks delivered live, FIFO holds [10, 20]. The host
    // side of this port (its PortQueueManager ledger) dies with the
    // replacement, so these entries describe bytes no live ledger holds.
    const portA = acquirePort();
    terminalClient.onData("term-1", () => {});
    portA.postMessage({ type: "data", id: "term-1", data: "aaaaaaaaaa", bytes: 10 });
    portA.postMessage({ type: "data", id: "term-1", data: "bbbbbbbbbbbbbbbbbbbb", bytes: 20 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Generation B replaces the port, then delivers one fresh chunk (7
        // bytes). Without the activation-time clear, the xterm write
        // completion for a NEW chunk would shift generation A's 10-byte entry
        // and post a wrong-sized ack against B's fresh ledger.
        const portB = acquirePort();
        portB.postMessage({ type: "data", id: "term-1", data: "ccccccc", bytes: 7 });

        setTimeout(() => {
          const acks: Record<string, unknown>[] = [];
          portB.addEventListener("message", (event: MessageEvent) => {
            const msg = event.data as Record<string, unknown>;
            if (msg?.type === "ack" && msg.id === "term-1") acks.push(msg);
          });
          portB.start();

          terminalClient.acknowledgePortData("term-1", 999);
          // FIFO now empty — generation A's entries are gone, not queued behind.
          terminalClient.acknowledgePortData("term-1", 999, 5);

          setTimeout(() => {
            expect(acks).toEqual([{ type: "ack", id: "term-1", bytes: 7 }]);
            resolve();
          }, 100);
        }, 50);
      }, 50);
    });
  });

  it("write completions that fire after a port replacement degrade to no-op acks", () => {
    const portA = acquirePort();
    terminalClient.onData("term-1", () => {});
    portA.postMessage({ type: "data", id: "term-1", data: "old-data", bytes: 42 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const portB = acquirePort();
        const acks: Record<string, unknown>[] = [];
        portB.addEventListener("message", (event: MessageEvent) => {
          const msg = event.data as Record<string, unknown>;
          if (msg?.type === "ack") acks.push(msg);
        });
        portB.start();

        // The stale chunk's write completion arrives AFTER the replacement:
        // its FIFO entry was cleared at activation, so nothing is posted.
        terminalClient.acknowledgePortData("term-1", 42);

        setTimeout(() => {
          expect(acks).toEqual([]);
          resolve();
        }, 100);
      }, 50);
    });
  });

  it("dispatches to correct terminal only", () => {
    const port = acquirePort();
    const received1: string[] = [];
    const received2: string[] = [];

    terminalClient.onData("term-1", (d) => received1.push(d as string));
    terminalClient.onData("term-2", (d) => received2.push(d as string));

    port.postMessage({ type: "data", id: "term-2", data: "for-term-2", bytes: 10 });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received1).toEqual([]);
        expect(received2).toContain("for-term-2");
        resolve();
      }, 50);
    });
  });

  it("dispatches MessagePort tier-changed messages to onTierChanged callbacks", () => {
    const port = acquirePort();
    const received: Array<{ id: string; tier: string }> = [];

    terminalClient.onTierChanged((id, tier) => received.push({ id, tier }));

    port.postMessage({ type: "tier-changed", id: "term-1", tier: "background" });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toEqual([{ id: "term-1", tier: "background" }]);
        resolve();
      }, 50);
    });
  });

  it("does NOT ack or buffer tier-changed messages (no byte accounting)", () => {
    const port = acquirePort();

    terminalClient.onTierChanged(() => {});

    // A tier-changed message carries no bytes — it must never enter the ACK loop
    // the way unconsumed data does (which would emit an immediate early-buffer ack).
    port.postMessage({ type: "tier-changed", id: "term-1", tier: "active" });

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack") acks.push(msg);
      });
      port.start();

      setTimeout(() => {
        expect(acks).toEqual([]);
        resolve();
      }, 100);
    });
  });

  it("stops dispatching tier-changed after unsubscribe", () => {
    const port = acquirePort();
    const received: string[] = [];

    const unsub = terminalClient.onTierChanged((id) => received.push(id));
    unsub();

    port.postMessage({ type: "tier-changed", id: "term-1", tier: "background" });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toEqual([]);
        resolve();
      }, 50);
    });
  });

  it("tolerates tier-changed for an unknown terminal and keeps dispatching", () => {
    const port = acquirePort();
    const received: Array<{ id: string; tier: string }> = [];
    terminalClient.onTierChanged((id, tier) => received.push({ id, tier }));

    // A tier-changed for a terminal the consumer doesn't track must not throw
    // or wedge the dispatcher — the consumer routes by id internally.
    port.postMessage({ type: "tier-changed", id: "no-such-terminal", tier: "background" });
    port.postMessage({ type: "tier-changed", id: "term-1", tier: "active" });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toEqual([
          { id: "no-such-terminal", tier: "background" },
          { id: "term-1", tier: "active" },
        ]);
        resolve();
      }, 50);
    });
  });

  it("dispatches MessagePort terminal-status (data-loss) to onStatus callbacks", () => {
    // Per-window data-loss pulse for a saturated fan-out window (#9891) rides the
    // port, not the IPC broadcast, so it reaches only the affected window.
    const port = acquirePort();
    const received: Array<Record<string, unknown>> = [];

    terminalClient.onStatus((data) => received.push(data as unknown as Record<string, unknown>));

    port.postMessage({
      type: "terminal-status",
      id: "term-1",
      status: "data-loss",
      droppedBytes: 40,
      timestamp: 123,
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          id: "term-1",
          status: "data-loss",
          droppedBytes: 40,
          timestamp: 123,
        });
        resolve();
      }, 50);
    });
  });

  it("onStatus subscribes to BOTH the IPC broadcast and the port, and cleanup detaches both", () => {
    const port = acquirePort();
    const received: Array<Record<string, unknown>> = [];

    const unsub = terminalClient.onStatus((data) =>
      received.push(data as unknown as Record<string, unknown>)
    );
    // Dual-registration: the IPC broadcast path is still wired up.
    expect(mockElectronTerminal.onStatus).toHaveBeenCalledTimes(1);

    unsub();
    // After unsubscribe the port path must no longer dispatch to the callback.
    port.postMessage({
      type: "terminal-status",
      id: "term-1",
      status: "data-loss",
      droppedBytes: 5,
      timestamp: 1,
    });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toEqual([]);
        resolve();
      }, 50);
    });
  });

  it("does NOT ack or buffer terminal-status messages (no byte accounting)", () => {
    const port = acquirePort();

    terminalClient.onStatus(() => {});

    // Like tier-changed, a terminal-status pulse carries no consumable bytes and
    // must never enter the ACK loop (which would emit a spurious early-buffer ack).
    port.postMessage({
      type: "terminal-status",
      id: "term-1",
      status: "data-loss",
      droppedBytes: 9,
      timestamp: 2,
    });

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack") acks.push(msg);
      });
      port.start();

      setTimeout(() => {
        expect(acks).toEqual([]);
        resolve();
      }, 100);
    });
  });

  it("ignores unknown message types without throwing or emitting acks", () => {
    const port = acquirePort();
    const tierReceived: string[] = [];
    terminalClient.onTierChanged((id) => tierReceived.push(id));

    port.postMessage({ type: "totally-unknown", id: "term-1" } as unknown);

    return new Promise<void>((resolve) => {
      const acks: Record<string, unknown>[] = [];
      port.addEventListener("message", (event: MessageEvent) => {
        const msg = event.data as Record<string, unknown>;
        if (msg?.type === "ack") acks.push(msg);
      });
      port.start();

      setTimeout(() => {
        expect(acks).toEqual([]);
        expect(tierReceived).toEqual([]);
        resolve();
      }, 100);
    });
  });
});
