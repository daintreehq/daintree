/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => {
  const forkMock = vi.fn();
  const appMock = {
    getPath: vi.fn(() => "/tmp/userData"),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { forkMock, appMock };
});

vi.mock("electron", () => ({
  utilityProcess: { fork: shared.forkMock },
  UtilityProcess: class {},
  MessagePortMain: class {},
  app: shared.appMock,
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => ({
    removeTrashed: vi.fn(),
    persistTrashed: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

// Try to load the helpers — if worker_threads isn't available in this
// runtime, skip the suite cleanly (matches PtyManager.integration precedent).
let helpers: typeof import("./helpers/ipcContractTestUtils.js") | undefined;
try {
  helpers = await import("./helpers/ipcContractTestUtils.js");
} catch (_err) {
  console.warn("worker_threads helpers unavailable, skipping IPC contract tests");
}

const shouldSkip = !helpers;
const stubWorkerPath = helpers ? helpers.helperPath("stubPtyHost.worker.mjs") : "";

describe.skipIf(shouldSkip)("PtyClient IPC contract (real worker_threads boundary)", () => {
  let handle: import("./helpers/ipcContractTestUtils.js").StubHostHandle;
  let PtyClientCtor: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    handle = helpers!.spawnStubHost(stubWorkerPath);
    shared.forkMock.mockReset();
    shared.forkMock.mockReturnValue(handle.fakeChild);
    shared.appMock.getPath.mockClear();
    shared.appMock.on.mockClear();
    shared.appMock.off.mockClear();

    // Re-evaluate PtyClient against fresh mock state per test.
    vi.resetModules();
    const mod = await import("../PtyClient.js");
    PtyClientCtor = mod.PtyClient;
  });

  afterEach(async () => {
    await handle.dispose();
    vi.clearAllMocks();
  });

  it("completes the ready handshake when the host posts `ready` over a real MessagePort", async () => {
    const client = new PtyClientCtor({ healthCheckIntervalMs: 60_000 });
    try {
      await client.waitForReady();
      // Child wired to our fakeChild — proves the mock substitution worked
      // and the real handshake message traversed the worker port.
      expect((client as any).child).toBe(handle.fakeChild);
    } finally {
      client.dispose();
    }
  });

  it("roundtrips Map/Date/Buffer/Set payloads through real V8 structured-clone (both directions)", async () => {
    const client = new PtyClientCtor({ healthCheckIntervalMs: 60_000 });
    try {
      await client.waitForReady();

      const payload = {
        map: new Map<string, number>([
          ["a", 1],
          ["b", 2],
        ]),
        date: new Date("2026-01-15T12:00:00.000Z"),
        buf: Buffer.from("hello world", "utf8"),
        nested: {
          items: [
            { id: "x", count: 42 },
            { id: "y", count: -7 },
          ],
          tags: new Set(["alpha", "beta"]),
        },
      };

      // Send through the fakeChild → real port → worker. The worker echoes
      // it back unchanged. Asserting on the echoed value proves both
      // serialization and deserialization preserve the types — a one-way
      // assertion would only catch half the contract.
      const resultPromise = helpers!.waitForChildMessage<{
        type: string;
        requestId: string;
        payload: typeof payload;
      }>(
        handle.fakeChild,
        (m: any) => m?.type === "ipc-test:roundtrip-result" && m?.requestId === "rt-1",
        5000
      );

      handle.fakeChild.postMessage({
        type: "ipc-test:roundtrip",
        requestId: "rt-1",
        payload,
      });

      const result = await resultPromise;

      expect(result.payload.map).toBeInstanceOf(Map);
      expect(result.payload.map.get("a")).toBe(1);
      expect(result.payload.map.get("b")).toBe(2);

      expect(result.payload.date).toBeInstanceOf(Date);
      expect(result.payload.date.getTime()).toBe(payload.date.getTime());

      // Buffers traverse worker_threads as Uint8Array; rewrap to Buffer
      // for comparison.
      const echoed = Buffer.from(result.payload.buf);
      expect(echoed.toString("utf8")).toBe("hello world");

      expect(result.payload.nested.items).toEqual(payload.nested.items);
      expect(result.payload.nested.tags).toBeInstanceOf(Set);
      expect(result.payload.nested.tags.has("alpha")).toBe(true);
      expect(result.payload.nested.tags.has("beta")).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("emits host-crash-details when the worker exits abruptly via real process.exit", async () => {
    const client = new PtyClientCtor({ healthCheckIntervalMs: 60_000 });
    try {
      await client.waitForReady();

      const crashPromise = new Promise<{
        code: number | null;
        crashType: string;
        timestamp: number;
      }>((resolve, reject) => {
        client.on("host-crash-details", (payload) => resolve(payload));
        // Local timeout — fail fast if `ipc-test:die` is dropped or the
        // event wire-up regresses, instead of hanging until the 60s global.
        setTimeout(() => reject(new Error("host-crash-details not emitted within 5s")), 5000);
      });

      // Trigger a real process.exit(1) inside the worker — surfaces a real
      // OS-level worker exit signal back to the parent test process.
      handle.fakeChild.postMessage({ type: "ipc-test:die" });

      const crash = await crashPromise;
      expect(crash.crashType).toBeDefined();
      expect(crash.crashType).not.toBe("CLEAN_EXIT");
    } finally {
      client.dispose();
    }
  });

  it("connectMessagePort sends `connect-port` with the port in the transferList second arg", async () => {
    // Regression guard for the bug class motivating #5912: a refactor that
    // moves the port into the message body or drops the transferList would
    // silently break renderer ↔ pty-host port wiring. Asserting the call
    // shape catches that even though worker_threads can't fully reproduce
    // Electron's `event.ports` receipt semantics on the worker side.
    const client = new PtyClientCtor({ healthCheckIntervalMs: 60_000 });
    try {
      await client.waitForReady();

      // Spy after ready so startup chatter (set-log-level-overrides) doesn't
      // pollute the captured calls. The spy still forwards to the original
      // by default.
      const postSpy = vi.spyOn(handle.fakeChild, "postMessage");

      const { MessageChannel } = await import("node:worker_threads");
      const channel = new MessageChannel();
      try {
        client.connectMessagePort(42, channel.port2 as any);

        const connectCall = postSpy.mock.calls.find((c) => (c[0] as any)?.type === "connect-port");
        expect(connectCall).toBeDefined();
        expect(connectCall![0]).toEqual({ type: "connect-port", windowId: 42 });
        expect(connectCall![1]).toBeDefined();
        expect(Array.isArray(connectCall![1])).toBe(true);
        expect((connectCall![1] as unknown[]).length).toBe(1);
        expect((connectCall![1] as unknown[])[0]).toBe(channel.port2);
      } finally {
        try {
          channel.port1.close();
        } catch {
          /* ignore */
        }
      }
    } finally {
      client.dispose();
    }
  });

  it("responds to health-check pings with real pong messages over the worker port", async () => {
    const client = new PtyClientCtor({ healthCheckIntervalMs: 60_000 });
    try {
      await client.waitForReady();

      // Send a health-check directly through the fakeChild — the worker
      // stub echoes pong via the real port, so this exercises the full
      // health-check round-trip across the V8 boundary.
      const pongPromise = helpers!.waitForChildMessage(
        handle.fakeChild,
        (m: any) => m?.type === "pong",
        5000
      );
      handle.fakeChild.postMessage({ type: "health-check" });
      const pong: any = await pongPromise;
      expect(pong.type).toBe("pong");
    } finally {
      client.dispose();
    }
  });
});
