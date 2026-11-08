// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreeDiskUsageService, type DirectoryMeasurer } from "../WorktreeDiskUsageService.js";

interface Call {
  root: string;
  exclude: readonly string[];
  signal: AbortSignal;
  settle: (bytes: number | null) => void;
  fail: (error: unknown) => void;
}

/** A measurer whose scans finish only when the test says so. */
function controllableMeasurer() {
  const calls: Call[] = [];
  const measure = vi.fn<DirectoryMeasurer>(
    (root, { exclude, signal }) =>
      new Promise<number | null>((resolve, reject) => {
        calls.push({ root, exclude, signal, settle: resolve, fail: reject });
      })
  );
  return { calls, measure };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("WorktreeDiskUsageService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers measured bytes, and keeps a genuine zero distinct from unknown", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure });
    const signal = service.begin("view-1", "s1");

    const sized = service.measure(signal, "/repo/a", ["/repo/a/b"]);
    const empty = service.measure(signal, "/repo/c", []);
    await flush();
    expect(calls.map((c) => [c.root, c.exclude])).toEqual([
      ["/repo/a", ["/repo/a/b"]],
      ["/repo/c", []],
    ]);
    calls[0].settle(4096);
    calls[1].settle(0);

    expect(await sized).toEqual({ status: "measured", bytes: 4096 });
    expect(await empty).toEqual({ status: "measured", bytes: 0 });
  });

  it("answers unknown when the scan can't finish or throws", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure });
    const signal = service.begin("view-1", "s1");
    const failed = service.measure(signal, "/a", []);
    const thrown = service.measure(signal, "/b", []);
    await flush();
    calls[0].settle(null);
    calls[1].fail(new Error("EIO"));
    expect(await failed).toEqual({ status: "unknown" });
    expect(await thrown).toEqual({ status: "unknown" });
  });

  it("runs at most the concurrency limit at once and starts the next as one finishes", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure, concurrency: 2 });
    const a = service.begin("view-1", "s1");
    const b = service.begin("view-2", "s9");

    const results = [
      service.measure(a, "/1", []),
      service.measure(b, "/2", []),
      service.measure(a, "/3", []),
    ];
    await flush();
    expect(calls.map((c) => c.root)).toEqual(["/1", "/2"]);

    calls[1].settle(10);
    await results[1];
    await flush();
    expect(calls.map((c) => c.root)).toEqual(["/1", "/2", "/3"]);
  });

  it("cancelling a session answers its queued requests at once and aborts its running scans", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure, concurrency: 1 });
    const signal = service.begin("view-1", "s1");
    const running = service.measure(signal, "/1", []);
    const queued = service.measure(signal, "/2", []);
    await flush();

    service.cancel("view-1", "s1");
    expect(await queued).toEqual({ status: "unknown" });
    expect(calls[0].signal.aborted).toBe(true);
    // The slot stays held until the scan has actually stopped.
    const other = service.measure(service.begin("view-2", "s2"), "/3", []);
    await flush();
    expect(calls).toHaveLength(1);

    calls[0].settle(123);
    expect(await running).toEqual({ status: "unknown" });
    await flush();
    expect(calls.map((c) => c.root)).toEqual(["/1", "/3"]);
    calls[1].settle(1);
    expect(await other).toEqual({ status: "measured", bytes: 1 });
  });

  it("a new session from the same view replaces the old; other views are untouched", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure });
    const first = service.begin("view-1", "s1");
    const neighbour = service.begin("view-2", "s1");
    expect(service.begin("view-1", "s1")).toBe(first);

    service.measure(first, "/1", []);
    service.measure(neighbour, "/2", []);
    await flush();
    service.begin("view-1", "s2");

    expect(first.aborted).toBe(true);
    expect(calls[0].signal.aborted).toBe(true);
    expect(neighbour.aborted).toBe(false);
    expect(calls[1].signal.aborted).toBe(false);
  });

  it("ignores a cancel naming a session the view no longer has", () => {
    const service = new WorktreeDiskUsageService({ measure: vi.fn() });
    const current = service.begin("view-1", "s2");
    service.cancel("view-1", "s1");
    service.cancel("view-2");
    expect(current.aborted).toBe(false);
    service.cancel("view-1");
    expect(current.aborted).toBe(true);
  });

  it("abandons a scan past its deadline as unknown, even when it later reports bytes", async () => {
    vi.useFakeTimers();
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure, timeoutMs: 1_000 });
    const pending = service.measure(service.begin("view-1", "s1"), "/1", []);
    await flush();

    vi.advanceTimersByTime(1_000);
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].settle(999);
    expect(await pending).toEqual({ status: "unknown" });
  });

  it("answers unknown without scanning for an already-cancelled session", async () => {
    const measure = vi.fn<DirectoryMeasurer>();
    const service = new WorktreeDiskUsageService({ measure });
    const signal = service.begin("view-1", "s1");
    service.cancel("view-1");
    expect(await service.measure(signal, "/1", [])).toEqual({ status: "unknown" });
    expect(measure).not.toHaveBeenCalled();
  });

  it("dispose stops every session and refuses new ones", async () => {
    const { calls, measure } = controllableMeasurer();
    const service = new WorktreeDiskUsageService({ measure, concurrency: 1 });
    const signal = service.begin("view-1", "s1");
    service.measure(signal, "/1", []);
    const queued = service.measure(signal, "/2", []);
    await flush();

    service.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    expect(await queued).toEqual({ status: "unknown" });

    const late = service.begin("view-1", "s2");
    expect(late.aborted).toBe(true);
    expect(await service.measure(late, "/3", [])).toEqual({ status: "unknown" });
  });
});
