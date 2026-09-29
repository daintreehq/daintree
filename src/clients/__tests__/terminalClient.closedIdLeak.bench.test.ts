import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node-level benchmark for the early-data buffer retained for closed ids.
// Run: node --expose-gc node_modules/vitest/vitest.mjs run --pool=forks \
//   --poolOptions.forks.execArgv=--expose-gc src/clients/__tests__/terminalClient.closedIdLeak.bench.test.ts
const mockTerminal = new Proxy(
  { onData: vi.fn(() => () => {}), kill: vi.fn(async () => {}), spawn: vi.fn(async () => "x") },
  { get: (t, k) => (k in t ? (t as never)[k] : vi.fn(() => () => {})) }
);
const g = globalThis as unknown as Record<string, unknown>;
let windowMessageListeners: Array<(e: MessageEvent) => void> = [];

describe("closed-id early buffer", () => {
  let client: typeof import("../terminalClient").terminalClient;
  beforeEach(async () => {
    vi.resetModules();
    windowMessageListeners = [];
    const w: Record<string, unknown> = {
      electron: { terminal: mockTerminal },
      location: { origin: "http://localhost", protocol: "http:" },
      postMessage: vi.fn(),
      addEventListener: (t: string, h: (e: MessageEvent) => void) => {
        if (t === "message") windowMessageListeners.push(h);
      },
    };
    w.top = w;
    g.window = w;
    client = (await import("../terminalClient")).terminalClient;
  });
  afterEach(() => {
    delete g.window;
  });

  it("does not retain late chunks for killed ids", async () => {
    const N = Number(process.env.BENCH_N ?? 300);
    const mc = new MessageChannel();
    const token = "t";
    const fire = (data: Record<string, unknown>, ports: MessagePort[] = []) =>
      windowMessageListeners.forEach((l) =>
        l({ data, ports, source: g.window, origin: "http://localhost" } as unknown as MessageEvent)
      );
    fire({ type: "terminal-port-token", token });
    fire({ type: "terminal-port", token }, [mc.port2]);
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const heap0 = process.memoryUsage().heapUsed;
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < N; i++) {
      const id = `t-${i}`;
      client.onData(id, () => {})(); // live, then unsubscribed
      await client.kill(id);
      for (let c = 0; c < 8; c++) mc.port1.postMessage({ type: "data", id, data: chunk, bytes: 1 });
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await new Promise((r) => setTimeout(r, 100));
    gc?.();
    const heapDelta = process.memoryUsage().heapUsed - heap0;
    let retained = 0;
    for (let i = 0; i < N; i++) {
      client.onData(`t-${i}`, (d) => {
        retained += typeof d === "string" ? d.length : d.byteLength;
      });
    }
    if (process.env.BENCH_OUT) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        process.env.BENCH_OUT,
        `N=${N} retainedBytes=${retained} heapDeltaMB=${(heapDelta / 1048576).toFixed(1)}
`
      );
    }
    expect(retained).toBe(0);
  });
});
