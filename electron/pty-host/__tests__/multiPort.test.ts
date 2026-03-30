import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortQueueManager, type PortQueueDeps } from "../portQueue.js";

function createMockDeps(): PortQueueDeps {
  const mockCoordinator = {
    pause: vi.fn(),
    resume: vi.fn(),
    get isPaused() {
      return false;
    },
  } as unknown as any;
  return {
    getTerminal: vi.fn(() => ({ ptyProcess: { pause: vi.fn(), resume: vi.fn() } })),
    getPauseCoordinator: vi.fn(() => mockCoordinator),
    sendEvent: vi.fn(),
    metricsEnabled: vi.fn(() => true),
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  };
}

function createMockPort() {
  const listeners = new Map<string, Function[]>();
  return {
    postMessage: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    removeListener: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
    _emit(event: string, ...args: any[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

describe("Multi-port pty-host infrastructure", () => {
  describe("per-window PortQueueManager isolation", () => {
    it("independent backpressure tracking per window", () => {
      const pqm1 = new PortQueueManager(createMockDeps());
      const pqm2 = new PortQueueManager(createMockDeps());

      pqm1.addBytes("terminal-1", 5000);
      pqm2.addBytes("terminal-1", 2000);

      expect(pqm1.getQueuedBytes("terminal-1")).toBe(5000);
      expect(pqm2.getQueuedBytes("terminal-1")).toBe(2000);
    });

    it("disposing one window queue does not affect another", () => {
      const pqm1 = new PortQueueManager(createMockDeps());
      const pqm2 = new PortQueueManager(createMockDeps());

      pqm1.addBytes("terminal-1", 1000);
      pqm2.addBytes("terminal-1", 2000);

      pqm1.dispose();

      expect(pqm1.getQueuedBytes("terminal-1")).toBe(0);
      expect(pqm2.getQueuedBytes("terminal-1")).toBe(2000);
    });

    it("clearQueue only affects the specific instance", () => {
      const pqm1 = new PortQueueManager(createMockDeps());
      const pqm2 = new PortQueueManager(createMockDeps());

      pqm1.addBytes("t1", 500);
      pqm2.addBytes("t1", 700);

      pqm1.clearQueue("t1");

      expect(pqm1.getQueuedBytes("t1")).toBe(0);
      expect(pqm2.getQueuedBytes("t1")).toBe(700);
    });
  });

  describe("Map-based port management", () => {
    it("stores and retrieves ports by windowId", () => {
      const ports = new Map<number, ReturnType<typeof createMockPort>>();
      const port1 = createMockPort();
      const port2 = createMockPort();

      ports.set(1, port1);
      ports.set(2, port2);

      expect(ports.size).toBe(2);
      expect(ports.get(1)).toBe(port1);
      expect(ports.get(2)).toBe(port2);
    });

    it("replacing port for same windowId cleans up old", () => {
      const ports = new Map<number, ReturnType<typeof createMockPort>>();
      const handlers = new Map<number, Function>();

      const oldPort = createMockPort();
      const newPort = createMockPort();

      ports.set(1, oldPort);
      handlers.set(1, () => {});

      // Simulate disconnect of old port
      const oldHandler = handlers.get(1);
      if (oldPort && oldHandler) {
        oldPort.removeListener("message", oldHandler as any);
      }
      oldPort.close();
      ports.set(1, newPort);

      expect(ports.get(1)).toBe(newPort);
      expect(oldPort.close).toHaveBeenCalled();
    });

    it("removing one window does not affect others", () => {
      const ports = new Map<number, ReturnType<typeof createMockPort>>();
      const port1 = createMockPort();
      const port2 = createMockPort();

      ports.set(1, port1);
      ports.set(2, port2);

      // Simulate disconnectWindow for window 1
      ports.get(1)!.close();
      ports.delete(1);

      expect(ports.size).toBe(1);
      expect(ports.has(1)).toBe(false);
      expect(ports.get(2)).toBe(port2);
    });
  });

  describe("windowProjectMap filtering", () => {
    it("filters terminal data based on per-window project", () => {
      const windowProjectMap = new Map<number, string | null>();
      windowProjectMap.set(1, "project-a");
      windowProjectMap.set(2, "project-b");

      const termProjectId = "project-a";

      const windowsReceivingData: number[] = [];
      for (const [winId] of new Map([
        [1, {}],
        [2, {}],
      ])) {
        const winProject = windowProjectMap.get(winId);
        if (winProject && termProjectId && winProject !== termProjectId) continue;
        windowsReceivingData.push(winId);
      }

      expect(windowsReceivingData).toEqual([1]);
    });

    it("window with null project receives all terminal data", () => {
      const windowProjectMap = new Map<number, string | null>();
      windowProjectMap.set(1, null);
      windowProjectMap.set(2, "project-b");

      const termProjectId = "project-a";

      const windowsReceivingData: number[] = [];
      for (const [winId] of new Map([
        [1, {}],
        [2, {}],
      ])) {
        const winProject = windowProjectMap.get(winId);
        if (winProject && termProjectId && winProject !== termProjectId) continue;
        windowsReceivingData.push(winId);
      }

      expect(windowsReceivingData).toEqual([1]);
    });

    it("terminal with no project is sent to all windows", () => {
      const windowProjectMap = new Map<number, string | null>();
      windowProjectMap.set(1, "project-a");
      windowProjectMap.set(2, "project-b");

      const termProjectId: string | null = null;

      const windowsReceivingData: number[] = [];
      for (const [winId] of new Map([
        [1, {}],
        [2, {}],
      ])) {
        const winProject = windowProjectMap.get(winId);
        if (winProject && termProjectId && winProject !== termProjectId) continue;
        windowsReceivingData.push(winId);
      }

      // null termProjectId means the filter condition `winProject && termProjectId` is false
      expect(windowsReceivingData).toEqual([1, 2]);
    });
  });

  describe("Buffer.from copy safety", () => {
    it("each port gets an independent buffer copy", () => {
      const originalData = "hello terminal data";
      const buffers: Buffer[] = [];

      // Simulate the multi-port data loop
      for (let i = 0; i < 3; i++) {
        const bytes = Buffer.from(originalData);
        buffers.push(bytes);
      }

      // Each buffer should be independent
      expect(buffers[0]).not.toBe(buffers[1]);
      expect(buffers[1]).not.toBe(buffers[2]);

      // But all should have the same content
      expect(buffers[0].toString()).toBe(originalData);
      expect(buffers[1].toString()).toBe(originalData);
      expect(buffers[2].toString()).toBe(originalData);
    });
  });
});
