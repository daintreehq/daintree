// @vitest-environment jsdom
//
// Benchmark for per-terminal event fan-out in the renderer terminal service.
// Prints metrics with EXIT_FANOUT_BENCH=1; the assertions pin the O(1)-per-event shape.
//
// 1. Exit fan-out: N terminals, each PTY exits once (kill-by-project / project
//    close). The preload event bus calls every `terminal:exit` subscriber across
//    the contextBridge per event, so the metric is bus subscriber invocations.
// 2. Echo release: one keystroke, then a 50-chunk output burst for the echoing
//    terminal inside one frame. Measures frame callbacks queued and run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalBurstController } from "../TerminalBurstController";
import type { ManagedTerminal } from "../types";

type ExitCb = (id: string, exitCode: number) => void;

// Mirrors the preload bus: one Set of subscribers, every one called per event.
const exitBus = {
  subscribers: new Set<ExitCb>(),
  invocations: 0,
  emit(id: string, exitCode: number) {
    for (const cb of [...this.subscribers]) {
      this.invocations++;
      cb(id, exitCode);
    }
  },
};

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn((cb: ExitCb) => {
      exitBus.subscribers.add(cb);
      return () => exitBus.subscribers.delete(cb);
    }),
    onTierChanged: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

const PRINT = process.env.EXIT_FANOUT_BENCH === "1";
const ECHO_CHUNKS = 50;
const TIMING_ROUNDS = 200;

type BenchService = {
  instances: Map<string, ManagedTerminal>;
  prewarmTerminal: (id: string, type: string, options: Record<string, unknown>) => Promise<unknown>;
  addExitListener: (id: string, cb: (exitCode: number) => void) => () => void;
  destroy: (id: string) => void;
  dispose: () => void;
};

describe("terminal event fan-out benchmark", () => {
  let service: BenchService;

  beforeEach(async () => {
    vi.resetModules();
    exitBus.subscribers.clear();
    exitBus.invocations = 0;
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BenchService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.dispose();
    expect(exitBus.subscribers.size).toBe(0);
  });

  it("drops a destroyed terminal's exit route and routes a recreated id to its new instance only", async () => {
    await service.prewarmTerminal("t1", "terminal", {});
    await service.prewarmTerminal("t2", "terminal", {});
    const stale = vi.fn();
    service.addExitListener("t1", stale);

    service.destroy("t1");
    exitBus.emit("t1", 1);
    expect(stale).not.toHaveBeenCalled();

    await service.prewarmTerminal("t1", "terminal", {});
    const fresh = vi.fn();
    service.addExitListener("t1", fresh);
    exitBus.emit("t1", 2);

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledExactlyOnceWith(2);
    expect(exitBus.subscribers.size).toBe(1);
  });

  for (const n of [20, 50]) {
    it(`dispatches each of ${n} PTY exits to its own terminal only`, async () => {
      const ids = Array.from({ length: n }, (_, i) => `t${i}`);
      for (const id of ids) await service.prewarmTerminal(id, "terminal", {});
      const delivered = new Map<string, number[]>();
      for (const id of ids) {
        service.addExitListener(id, (code) => {
          delivered.set(id, [...(delivered.get(id) ?? []), code]);
        });
      }
      const busSubscribers = exitBus.subscribers.size;

      ids.forEach((id, i) => exitBus.emit(id, i));
      const invocations = exitBus.invocations;
      ids.forEach((id, i) => expect(delivered.get(id)).toEqual([i]));

      // Wall time of the routing alone (ids no terminal owns), amortised over rounds.
      const start = performance.now();
      for (let round = 0; round < TIMING_ROUNDS; round++) {
        for (const id of ids) exitBus.emit(`other-${id}`, 0);
      }
      const perRoundUs = ((performance.now() - start) / TIMING_ROUNDS) * 1000;

      if (PRINT) {
        process.stdout.write(
          `[exit-fanout] N=${n} busSubscribers=${busSubscribers} busInvocations=${invocations} ` +
            `routeUsPerRound=${perRoundUs.toFixed(1)}\n`
        );
      }

      expect(busSubscribers).toBe(1);
      expect(invocations).toBe(n);
    });
  }
});

describe("echo release benchmark", () => {
  let queued: FrameRequestCallback[];
  let scheduled: number;
  let ran: number;

  beforeEach(() => {
    queued = [];
    scheduled = 0;
    ran = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      scheduled++;
      queued.push(cb);
      return scheduled;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushFrame(): void {
    const frame = queued;
    queued = [];
    for (const cb of frame) {
      ran++;
      cb(performance.now());
    }
  }

  it(`queues one frame callback for a ${ECHO_CHUNKS}-chunk echo burst`, () => {
    const controller = new TerminalBurstController({
      getInstance: () => undefined,
      applyRendererPolicy: vi.fn(),
      holdWebGLForScroll: vi.fn(),
    });

    controller.onEchoPendingInput("t1");
    for (let i = 0; i < ECHO_CHUNKS; i++) controller.onEchoData("t1");
    expect(controller.getEchoPendingHoldId()).toBe("t1");
    flushFrame();

    if (PRINT) {
      process.stdout.write(
        `[echo-release] chunks=${ECHO_CHUNKS} rafScheduled=${scheduled} rafRan=${ran}\n`
      );
    }

    expect(controller.getEchoPendingHoldId()).toBeNull();
    expect(scheduled).toBe(1);
    expect(ran).toBe(1);
  });
});
