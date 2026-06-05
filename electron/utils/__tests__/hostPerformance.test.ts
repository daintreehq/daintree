import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  now: 0,
  timeOrigin: 1_000_000,
  appendCalls: [] as string[],
  readdirImpl: (() => ["a.bin", "b.bin", "c.bin"]) as (dir: string) => string[],
  getCompileCacheDirImpl: (() => "/tmp/compile-cache") as () => string | null,
}));

vi.mock("node:perf_hooks", () => ({
  performance: {
    now: () => state.now,
    get timeOrigin() {
      return state.timeOrigin;
    },
  },
}));

vi.mock("node:fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn((_file: string, line: string) => {
      state.appendCalls.push(line);
    }),
    readdirSync: vi.fn((dir: string) => state.readdirImpl(dir)),
  },
}));

vi.mock("node:module", () => ({
  getCompileCacheDir: vi.fn(() => state.getCompileCacheDirImpl()),
}));

const ORIGINAL_ENV = { ...process.env };

async function loadModule(envOverride: Record<string, string | undefined>) {
  // Reset and apply env overrides before re-importing — the module reads
  // process.env at module load.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("DAINTREE_PERF_") || key === "DAINTREE_UTILITY_PROCESS_KIND") {
      delete process.env[key];
    }
  }
  for (const [k, v] of Object.entries(envOverride)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return await import("../hostPerformance.js");
}

beforeEach(() => {
  state.now = 0;
  state.timeOrigin = 1_000_000;
  state.appendCalls = [];
  state.readdirImpl = () => ["a.bin", "b.bin", "c.bin"];
  state.getCompileCacheDirImpl = () => "/tmp/compile-cache";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
});

describe("markHostPerformance", () => {
  it("no-ops when DAINTREE_PERF_CAPTURE is unset", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: undefined,
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });
    expect(mod.isHostPerformanceCaptureEnabled()).toBe(false);
    mod.markHostPerformance("pty_host_ready_posted");
    expect(state.appendCalls).toHaveLength(0);
  });

  it("no-ops when DAINTREE_PERF_METRICS_FILE is unset", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: undefined,
    });
    expect(mod.isHostPerformanceCaptureEnabled()).toBe(false);
    mod.markHostPerformance("pty_host_ready_posted");
    expect(state.appendCalls).toHaveLength(0);
  });

  it("rebases elapsedMs onto main-process boot timeline when MAIN_BOOT_ABS_MS is set", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "1000050",
      DAINTREE_PERF_MAIN_BOOT_ABS_MS: "1000000",
      DAINTREE_UTILITY_PROCESS_KIND: "pty-host",
    });
    expect(mod.isHostPerformanceCaptureEnabled()).toBe(true);

    state.now = 200;
    mod.markHostPerformance("pty_host_ready_posted");

    expect(state.appendCalls).toHaveLength(1);
    const parsed = JSON.parse(state.appendCalls[0].trim());
    expect(parsed.mark).toBe("pty_host_ready_posted");
    // now() = timeOrigin (1_000_000) + perf.now (200) = 1_000_200
    // elapsedMs = 1_000_200 - 1_000_000 = 200 (ms since main boot)
    // sinceForkMs = 1_000_200 - 1_000_050 = 150 (ms since fork)
    expect(parsed.elapsedMs).toBe(200);
    expect(parsed.meta.processKind).toBe("pty-host");
    expect(parsed.meta.sinceForkMs).toBe(150);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("falls back to fork-relative elapsedMs when MAIN_BOOT_ABS_MS is missing", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "1000050",
    });

    state.now = 200;
    mod.markHostPerformance("pty_host_ready_posted");
    const parsed = JSON.parse(state.appendCalls[0].trim());
    // No main boot anchor → elapsedMs = absNow - FORK_ABS_MS = 150
    expect(parsed.elapsedMs).toBe(150);
    expect(parsed.meta.sinceForkMs).toBe(150);
  });

  it("base meta wins over caller-provided meta (processKind, sinceForkMs)", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "1000050",
      DAINTREE_PERF_MAIN_BOOT_ABS_MS: "1000000",
      DAINTREE_UTILITY_PROCESS_KIND: "pty-host",
    });
    state.now = 200;
    mod.markHostPerformance("pty_host_ready_posted", {
      processKind: "attacker",
      sinceForkMs: 9999,
      otherKey: "preserved",
    });
    const parsed = JSON.parse(state.appendCalls[0].trim());
    expect(parsed.meta.processKind).toBe("pty-host"); // env wins
    expect(parsed.meta.sinceForkMs).toBe(150); // computed value wins
    expect(parsed.meta.otherKey).toBe("preserved"); // non-conflicting key kept
  });

  it("propagates DAINTREE_WORKSPACE_SERVICE_NAME into meta", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "1000050",
      DAINTREE_PERF_MAIN_BOOT_ABS_MS: "1000000",
      DAINTREE_UTILITY_PROCESS_KIND: "workspace-host",
      DAINTREE_WORKSPACE_SERVICE_NAME: "daintree-workspace-host:repo-abc12345",
    });
    state.now = 300;
    mod.markHostPerformance("workspace_host_module_eval_complete", {
      compileCacheEnabled: true,
      cacheFileCount: 5,
    });
    const parsed = JSON.parse(state.appendCalls[0].trim());
    expect(parsed.meta.processKind).toBe("workspace-host");
    expect(parsed.meta.workspaceServiceName).toBe("daintree-workspace-host:repo-abc12345");
    expect(parsed.meta.compileCacheEnabled).toBe(true);
    expect(parsed.meta.cacheFileCount).toBe(5);
  });

  it("falls back to performance.now when both anchors are missing", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: undefined,
      DAINTREE_PERF_MAIN_BOOT_ABS_MS: undefined,
    });
    state.now = 42;
    mod.markHostPerformance("pty_host_native_module_ready");
    const parsed = JSON.parse(state.appendCalls[0].trim());
    expect(parsed.elapsedMs).toBe(42);
    expect(parsed.meta?.sinceForkMs).toBeUndefined();
  });

  it("rejects negative DAINTREE_PERF_FORK_ABS_MS (no anchor)", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "-100",
    });
    state.now = 50;
    mod.markHostPerformance("pty_host_ready_posted");
    const parsed = JSON.parse(state.appendCalls[0].trim());
    // Negative anchor rejected → falls back to performance.now()
    expect(parsed.elapsedMs).toBe(50);
    expect(parsed.meta?.sinceForkMs).toBeUndefined();
  });

  it("rejects non-finite DAINTREE_PERF_FORK_ABS_MS (no anchor)", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
      DAINTREE_PERF_FORK_ABS_MS: "not-a-number",
    });
    state.now = 75;
    mod.markHostPerformance("pty_host_ready_posted");
    const parsed = JSON.parse(state.appendCalls[0].trim());
    expect(parsed.elapsedMs).toBe(75);
    expect(parsed.meta?.sinceForkMs).toBeUndefined();
  });
});

describe("getCompileCacheMeta", () => {
  it("reports cacheFileCount when getCompileCacheDir returns a directory", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });
    state.readdirImpl = () => ["a.bin", "b.bin", "c.bin"];
    state.getCompileCacheDirImpl = () => "/tmp/compile-cache";

    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheEnabled).toBe(true);
    expect(meta.compileCacheDir).toBe("/tmp/compile-cache");
    expect(meta.cacheFileCount).toBe(3);
  });

  it("returns count of 0 when readdirSync throws", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });
    state.readdirImpl = () => {
      throw new Error("ENOENT");
    };

    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheEnabled).toBe(true);
    expect(meta.cacheFileCount).toBe(0);
  });

  it("reports compileCacheEnabled=false when getCompileCacheDir returns null", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });
    state.getCompileCacheDirImpl = () => null;

    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheEnabled).toBe(false);
    expect(meta.cacheFileCount).toBeUndefined();
  });

  it("omits status fields until setCompileCacheEnableStatus is called", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });

    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheStatus).toBeUndefined();
    expect(meta.compileCacheStatusName).toBeUndefined();
  });

  it("maps the captured enableCompileCache status to its human-readable name", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });

    // ALREADY_ENABLED (2) is the normal production path (API dir arg was used).
    mod.setCompileCacheEnableStatus(2);
    const enabled = mod.getCompileCacheMeta();
    expect(enabled.compileCacheStatus).toBe(2);
    expect(enabled.compileCacheStatusName).toBe("ALREADY_ENABLED");
  });

  it("surfaces FAILED status so a silently-disabled cache is detectable", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });

    mod.setCompileCacheEnableStatus(0);
    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheStatus).toBe(0);
    expect(meta.compileCacheStatusName).toBe("FAILED");
  });

  it("labels an out-of-range status as UNKNOWN rather than dropping it", async () => {
    const mod = await loadModule({
      DAINTREE_PERF_CAPTURE: "1",
      DAINTREE_PERF_METRICS_FILE: "/tmp/marks.ndjson",
    });

    mod.setCompileCacheEnableStatus(99);
    const meta = mod.getCompileCacheMeta();
    expect(meta.compileCacheStatus).toBe(99);
    expect(meta.compileCacheStatusName).toBe("UNKNOWN");
  });
});
