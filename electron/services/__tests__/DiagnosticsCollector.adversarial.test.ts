import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  execFileHandler: vi.fn(),
  logEntries: [] as Array<{
    level: string;
    message: string;
    timestamp: number;
    context?: unknown;
  }>,
  terminals: [] as Array<{
    id: string;
    worktreeId?: string;
    kind: string;
    agentState?: string;
    cwd?: string;
    hasPty?: boolean;
  }>,
  storeValues: new Map<string, unknown>(),
}));

// Renderer/resource state surfaced by the #10500 diagnostics sections. Mocked at
// module scope so the dynamically-imported singletons return controllable data
// instead of touching real services.
const renderer = vi.hoisted(() => ({
  blink: new Map<number, { allocated: number; total?: number; timestamp: number }>(),
  elu: new Map<
    number,
    { blockingDurationMs: number; sampleWindowMs: number; ratio: number; timestamp: number }
  >(),
  hibernationSnapshot: {} as unknown,
  resourceProfileSnapshot: null as unknown,
}));

vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => "1.0.0"),
    getName: vi.fn(() => "Daintree"),
    getPath: vi.fn((name: string) => `/paths/${name}`),
    getAppPath: vi.fn(() => "/app"),
    getGPUFeatureStatus: vi.fn(() => ({ webgl: "enabled" })),
    getGPUInfo: vi.fn(() => Promise.resolve({ auxAttributes: { renderer: "mock" } })),
    getAppMetrics: vi.fn(() => []),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 860 },
        scaleFactor: 2,
        rotation: 0,
        internal: true,
      },
    ]),
  },
}));

vi.mock("os", () => ({
  default: {
    type: vi.fn(() => "Darwin"),
    platform: vi.fn(() => "darwin"),
    release: vi.fn(() => "24.0.0"),
    version: vi.fn(() => "Darwin Kernel Version"),
    arch: vi.fn(() => "arm64"),
    homedir: vi.fn(() => "/Users/alice"),
    cpus: vi.fn(() => [{ model: "CPU", speed: 3200 }]),
    totalmem: vi.fn(() => 16_000),
    freemem: vi.fn(() => 8_000),
    loadavg: vi.fn(() => [0.1, 0.2, 0.3]),
  },
}));

vi.mock("child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => shared.execFileHandler(file, args, options, callback),
}));

vi.mock("../TelemetryService.js", () => ({
  sanitizePath: vi.fn((value: string) => value.replace(/\/Users\/[^/]+/g, "/Users/<redacted>")),
}));

vi.mock("../LogBuffer.js", () => ({
  logBuffer: {
    getAll: vi.fn(() => shared.logEntries),
  },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => shared.storeValues.get(key)),
  },
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

// getBlinkSamples/getEluSamples resolve through these closures. getTrendSnapshot
// is intentionally a no-op here: under vitest's dynamic-import mock the real
// module-level getTrendSnapshot still runs for collectMemoryTrends (returning an
// empty trendState in-test), so the diagnostics test asserts that section's
// wiring/shape only — its EMA content is covered by ProcessMemoryMonitor.test.ts.
vi.mock("../ProcessMemoryMonitor.js", () => ({
  getBlinkSamples: () => renderer.blink,
  getEluSamples: () => renderer.elu,
  getTrendSnapshot: () => [],
}));

vi.mock("../HibernationService.js", () => ({
  getHibernationService: () => ({ getSnapshot: () => renderer.hibernationSnapshot }),
}));

vi.mock("../../window/serviceRefs.js", () => ({
  getResourceProfileService: () =>
    renderer.resourceProfileSnapshot === null
      ? null
      : { getSnapshot: () => renderer.resourceProfileSnapshot },
}));

type DiagnosticsCollectorModule = typeof import("../DiagnosticsCollector.js");

function createDeps(eventBuffer?: { getAll: () => unknown[] }) {
  return {
    eventBuffer,
    ptyClient: {
      getAllTerminalsAsync: async () => shared.terminals,
    },
  } as unknown as import("../../ipc/types.js").HandlerDependencies;
}

function setDefaultExecFile(): void {
  shared.execFileHandler.mockImplementation(
    (
      file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      if (file === "which") {
        callback(null, `/usr/bin/${file}`, "");
        return;
      }
      callback(null, `${file} version\n`, "");
    }
  );
}

describe("DiagnosticsCollector adversarial", () => {
  let diagnostics: DiagnosticsCollectorModule;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    shared.logEntries = [];
    shared.terminals = [];
    shared.storeValues.clear();
    shared.storeValues.set("appState", { recentProject: "/Users/alice/project" });
    renderer.blink = new Map();
    renderer.elu = new Map();
    renderer.hibernationSnapshot = {
      config: { enabled: false, inactiveThresholdHours: 24 },
      isRunning: false,
      memoryPressureThresholdMs: 1_800_000,
    };
    renderer.resourceProfileSnapshot = {
      profile: "balanced",
      thermalState: "unknown",
      isOnBattery: false,
      speedLimit: 100,
      lagPressureActive: false,
    };
    setDefaultExecFile();
    diagnostics = await import("../DiagnosticsCollector.js");
  });

  it("TERMINALS_POPULATED_FROM_PTY_CLIENT (#10054)", async () => {
    // Regression: the bundle read the never-populated main-process PtyManager
    // singleton, so terminals was always []. It must now reflect the pty-host
    // registry surfaced via ptyClient.getAllTerminalsAsync().
    shared.terminals = [
      { id: "t1", kind: "agent", agentState: "working", cwd: "/Users/alice/p", hasPty: true },
      { id: "t2", kind: "terminal", cwd: "/Users/alice/p", hasPty: false },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      terminals: Array<{ id: string; agentState?: string; isExited: boolean; cwd: string | null }>;
    };

    expect(payload.terminals).toHaveLength(2);
    expect(payload.terminals[0]).toMatchObject({
      id: "t1",
      agentState: "working",
      isExited: false,
    });
    // hasPty:false maps to isExited:true.
    expect(payload.terminals[1]).toMatchObject({ id: "t2", isExited: true });
    // Path sanitized via the TelemetryService mock.
    expect(payload.terminals[0].cwd).toBe("/Users/<redacted>/p");
  });

  it("TERMINALS_EMPTY_WHEN_PTY_CLIENT_ABSENT (#10054)", async () => {
    const payload = (await diagnostics.collectDiagnostics({
      eventBuffer: undefined,
    } as unknown as import("../../ipc/types.js").HandlerDependencies)) as {
      terminals: unknown[];
    };
    expect(payload.terminals).toEqual([]);
  });

  it("LOG_HISTORY_BOUNDED_TO_100", async () => {
    shared.logEntries = Array.from({ length: 1000 }, (_, index) => ({
      level: "info",
      message: `entry-${index}`,
      timestamp: index,
    }));

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: { totalEntries: number; recentEntries: Array<unknown> };
    };

    expect(payload.logs.totalEntries).toBe(1000);
    expect(payload.logs.recentEntries).toHaveLength(100);
  });

  it("OVERSIZED_LOG_MESSAGE_TRUNCATED", async () => {
    const huge = "x".repeat(2_000_000);
    shared.logEntries = [
      {
        level: "error",
        message: huge,
        timestamp: 1,
        context: {
          details: huge,
        },
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: {
        recentEntries: Array<{
          message: string;
          context?: { details?: string };
        }>;
      };
    };

    const entry = payload.logs.recentEntries[0];
    expect(entry.message.length).toBeLessThan(50_000);
    expect(entry.message).not.toBe(huge);
    expect((entry.context?.details ?? "").length).toBeLessThan(50_000);
  });

  it("CONCURRENT_COLLECTORS_NO_SHARED_STATE", async () => {
    shared.logEntries = [
      {
        level: "info",
        message: "first",
        timestamp: 1,
      },
    ];
    shared.storeValues.set("appState", { project: "one" });

    const firstPromise = diagnostics.collectDiagnostics(createDeps());

    shared.logEntries = [
      {
        level: "info",
        message: "second",
        timestamp: 2,
      },
    ];
    shared.storeValues.set("appState", { project: "two" });

    const secondPromise = diagnostics.collectDiagnostics(createDeps());

    const [first, second] = (await Promise.all([firstPromise, secondPromise])) as Array<{
      logs: { recentEntries: Array<{ message: string }> };
      config: { appState: { project: string } };
    }>;

    expect(first.logs.recentEntries[0]?.message).toBe("first");
    expect(first.config.appState.project).toBe("one");
    expect(second.logs.recentEntries[0]?.message).toBe("second");
    expect(second.config.appState.project).toBe("two");
  });

  it("NO_STALE_REFERENCES_IN_PAYLOAD", async () => {
    shared.logEntries = [
      {
        level: "info",
        message: "stable",
        timestamp: 1,
        context: { nested: ["initial"] },
      },
    ];
    shared.storeValues.set("appState", { items: ["initial"] });

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: {
        recentEntries: Array<{ context?: { nested?: string[] } }>;
      };
      config: { appState: { items: string[] } };
    };

    shared.logEntries[0]!.message = "mutated";
    (shared.logEntries[0]!.context as { nested: string[] }).nested[0] = "mutated";
    (shared.storeValues.get("appState") as { items: string[] }).items[0] = "mutated";

    expect(payload.logs.recentEntries[0]?.context?.nested).toEqual(["initial"]);
    expect(payload.config.appState.items).toEqual(["initial"]);
  });

  it("HUNG_SECTION_TIMES_OUT_WITHOUT_FAILING_OTHERS", async () => {
    shared.execFileHandler.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        _callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {}
    );

    const promise = diagnostics.collectDiagnostics(createDeps());
    await vi.advanceTimersByTimeAsync(5_000);
    const payload = (await promise) as {
      tools: { error: string };
      metadata: { appName: string };
    };

    expect(payload.tools).toEqual({ error: "timed out" });
    expect(payload.metadata.appName).toBe("Daintree");
  });

  it("EVENT_BUFFER_THROW_CONTAINED", async () => {
    const payload = (await diagnostics.collectDiagnostics(
      createDeps({
        getAll: () => {
          throw new Error("buffer offline");
        },
      })
    )) as {
      events: { error: string };
      logs: { totalEntries: number };
    };

    expect(payload.events).toEqual({ error: "Failed to get events" });
    expect(payload.logs.totalEntries).toBe(0);
  });

  it("REDACTION_COVERS_NESTED_AND_URLS", async () => {
    shared.storeValues.set("appState", {
      authorization: "secret",
      nested: {
        token: "abc123",
      },
    });
    shared.logEntries = [
      {
        level: "info",
        message: "https://user:pass@example.com/repo",
        timestamp: 1,
        context: [{ apiKey: "s3cr3t" }, { url: "https://token@example.com/private" }],
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      config: {
        appState: {
          authorization: string;
          nested: { token: string };
        };
      };
      logs: {
        recentEntries: Array<{
          message: string;
          context?: Array<{ apiKey?: string; url?: string }>;
        }>;
      };
    };

    expect(payload.config.appState.authorization).toBe("<redacted>");
    expect(payload.config.appState.nested.token).toBe("<redacted>");
    expect(payload.logs.recentEntries[0]?.message).toBe("https://<redacted>@example.com/repo");
    expect(payload.logs.recentEntries[0]?.context?.[0]?.apiKey).toBe("<redacted>");
    expect(payload.logs.recentEntries[0]?.context?.[1]?.url).toBe(
      "https://<redacted>@example.com/private"
    );
  });

  it("FREE_TEXT_GITHUB_PAT_SCRUBBED_IN_LOG_MESSAGE", async () => {
    shared.logEntries = [
      {
        level: "error",
        message: "git clone failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
        timestamp: 1,
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: { recentEntries: Array<{ message: string }> };
    };

    const msg = payload.logs.recentEntries[0]?.message ?? "";
    expect(msg).not.toContain("ghp_");
    expect(msg).toContain("[REDACTED]");
  });

  it("FREE_TEXT_JWT_AND_BEARER_SCRUBBED_IN_NESTED_CONTEXT", async () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(40)}`;
    shared.logEntries = [
      {
        level: "warn",
        message: "auth failure",
        timestamp: 2,
        context: {
          // `authorization` key name is caught by SENSITIVE_KEY_PATTERN — the
          // whole value becomes `<redacted>` via key-based redaction.
          requestHeaders: {
            authorization: "Bearer abcdefghij.klmnop-qr_st=",
          },
          // `responseBody` is a safe key name, so its value is a free-text
          // string that only the new scrubber can catch. Also embed a Bearer
          // header shape here so the scrubber's Bearer pattern is exercised.
          responseBody: `{"token":"${jwt}","echo":"Authorization: Bearer abcdefghij.klmnop-qr_st="}`,
        },
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: {
        recentEntries: Array<{
          context?: {
            requestHeaders?: { authorization?: string };
            responseBody?: string;
          };
        }>;
      };
    };

    expect(payload.logs.recentEntries[0]?.context?.requestHeaders?.authorization).toBe(
      "<redacted>"
    );
    const body = payload.logs.recentEntries[0]?.context?.responseBody ?? "";
    expect(body).not.toContain(jwt);
    expect(body).not.toContain("eyJ");
    expect(body).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(body).toContain("[REDACTED]");
  });

  it("FREE_TEXT_AWS_KEY_SCRUBBED_IN_LOG_MESSAGE", async () => {
    shared.logEntries = [
      {
        level: "info",
        message: "envrc loaded: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        timestamp: 3,
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: { recentEntries: Array<{ message: string }> };
    };

    const msg = payload.logs.recentEntries[0]?.message ?? "";
    expect(msg).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(msg).toContain("[REDACTED]");
  });

  it("PROCESS_REPORT_HEADER_PII_REDACTED", async () => {
    const reportSpy = vi.spyOn(process, "report", "get").mockReturnValue({
      getReport: () =>
        ({
          header: {
            reportVersion: 5,
            event: "JavaScript API",
            trigger: "GetReport",
            nodejsVersion: "v20.0.0",
            arch: "arm64",
            platform: "darwin",
            host: "Joes-MacBook.local",
            cwd: "/Users/joe/project",
            filename: "/Users/joe/report.json",
            commandLine: [
              "node",
              "/Users/joe/app.js",
              "--token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
            ],
            networkInterfaces: [{ mac: "aa:bb:cc:dd:ee:ff", address: "192.168.1.10" }],
          },
          resourceUsage: {},
          libuv: [],
        }) as unknown as ReturnType<NonNullable<typeof process.report>["getReport"]>,
    } as unknown as typeof process.report);

    try {
      const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
        process: {
          nodeReport: {
            header: {
              host?: string;
              cwd?: string;
              filename?: string;
              commandLine?: string[];
              networkInterfaces?: unknown;
              nodejsVersion?: string;
              arch?: string;
            };
          };
        };
      };

      const header = payload.process.nodeReport.header;
      expect(header.host).toBe("<hostname>");
      expect(header.cwd).not.toContain("/Users/joe");
      expect(header.filename).not.toContain("/Users/joe");
      expect(header.commandLine?.join(" ")).not.toContain("ghp_");
      expect(header.commandLine?.join(" ")).not.toContain(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456"
      );
      expect(header.commandLine?.join(" ")).not.toContain("/Users/joe");
      expect(header.networkInterfaces).toBeUndefined();
      // Safe metadata preserved.
      expect(header.nodejsVersion).toBe("v20.0.0");
      expect(header.arch).toBe("arm64");
    } finally {
      reportSpy.mockRestore();
    }
  });

  it("PROCESS_REPORT_HEADER_TOLERATES_MISSING_FIELDS", async () => {
    const reportSpy = vi.spyOn(process, "report", "get").mockReturnValue({
      getReport: () =>
        ({
          header: {
            reportVersion: 5,
            nodejsVersion: "v20.0.0",
          },
          resourceUsage: {},
          libuv: [],
        }) as unknown as ReturnType<NonNullable<typeof process.report>["getReport"]>,
    } as unknown as typeof process.report);

    try {
      const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
        process: {
          nodeReport: { header: { host?: string; cwd?: string } };
        };
      };

      // No throw, host overlay still applied, omitted fields absent.
      expect(payload.process.nodeReport.header.host).toBe("<hostname>");
      expect(payload.process.nodeReport.header.cwd).toBeUndefined();
    } finally {
      reportSpy.mockRestore();
    }
  });

  it("ARGV_SECRET_SCRUBBED_AT_CAPTURE_SITE", async () => {
    const argvSpy = vi
      .spyOn(process, "argv", "get")
      .mockReturnValue([
        "node",
        "/Users/alice/app.js",
        "--token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456",
      ]);

    try {
      const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
        runtime: { argv: string[] };
      };

      const joined = payload.runtime.argv.join(" ");
      expect(joined).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456");
      expect(joined).not.toContain("/Users/alice");
      expect(joined).toContain("[REDACTED]");
    } finally {
      argvSpy.mockRestore();
    }
  });

  it("PER_RENDERER_AND_HIBERNATION_SECTIONS_POPULATED (#10500)", async () => {
    renderer.blink = new Map([[101, { allocated: 51_200, total: 102_400, timestamp: 1 }]]);
    renderer.elu = new Map([
      [101, { blockingDurationMs: 12.4, sampleWindowMs: 30_000, ratio: 0.87, timestamp: 2 }],
    ]);
    renderer.hibernationSnapshot = {
      config: { enabled: true, inactiveThresholdHours: 24 },
      isRunning: true,
      memoryPressureThresholdMs: 1_800_000,
    };

    shared.terminals = [
      { id: "t1", kind: "agent", agentState: "working", hasPty: true },
      { id: "t2", kind: "agent", agentState: "working", hasPty: true },
      { id: "t3", kind: "terminal", hasPty: true },
    ];

    const pvm = {
      getViewInventory: () => [
        {
          projectId: "p-active",
          projectPath: "/Users/alice/active",
          webContentsId: 101,
          state: "active",
          lastUsed: 10,
        },
        {
          projectId: "p-cached",
          projectPath: "/Users/alice/cached",
          webContentsId: 102,
          state: "cached",
          lastUsed: 5,
          evictedAt: 7,
        },
      ],
      getCacheConfig: () => ({ maxCachedViews: 3, activeProjectId: "p-active" }),
    };
    const deps = {
      ptyClient: { getAllTerminalsAsync: async () => shared.terminals },
      windowRegistry: { all: () => [{ windowId: 1, services: { projectViewManager: pvm } }] },
    } as unknown as import("../../ipc/types.js").HandlerDependencies;

    const payload = (await diagnostics.collectDiagnostics(deps)) as {
      projectViews: Array<{
        windowId: number;
        maxCachedViews: number;
        activeProjectId: string;
        views: Array<{
          projectId: string;
          projectPath: string;
          webContentsId: number;
          state: string;
        }>;
      }>;
      rendererMemory: {
        blink: Array<{ webContentsId: number; allocatedKb: number; totalKb?: number }>;
        elu: Array<{ webContentsId: number; ratio: number }>;
      };
      memoryTrends: { processes: unknown };
      resourceState: {
        hibernation: { isRunning: boolean };
        resourceProfile: { profile: string };
      };
      counts: {
        windows: number;
        openProjects: number;
        views: { total: number; active: number; cached: number; loading: number };
        terminals: { total: number; byAgentState: Record<string, number> };
      };
    };

    // projectViews — per-window inventory; projectPath sanitized by redactDeep.
    expect(payload.projectViews[0].windowId).toBe(1);
    expect(payload.projectViews[0].activeProjectId).toBe("p-active");
    const activeView = payload.projectViews[0].views.find((v) => v.projectId === "p-active")!;
    expect(activeView.webContentsId).toBe(101);
    expect(activeView.projectPath).toBe("/Users/<redacted>/active");

    // rendererMemory — keyed by webContentsId (the join key to projectViews).
    expect(payload.rendererMemory.blink[0]).toMatchObject({
      webContentsId: 101,
      allocatedKb: 51_200,
    });
    expect(payload.rendererMemory.elu[0]).toMatchObject({ webContentsId: 101, ratio: 0.87 });

    // memoryTrends — wiring/shape only; EMA content is covered by the
    // ProcessMemoryMonitor unit tests (the real getTrendSnapshot runs here).
    expect(Array.isArray(payload.memoryTrends.processes)).toBe(true);

    // resourceState — both singletons surfaced.
    expect(payload.resourceState.hibernation.isRunning).toBe(true);
    expect(payload.resourceState.resourceProfile.profile).toBe("balanced");

    // counts — derived from the same PVM inventory + terminal list.
    expect(payload.counts.windows).toBe(1);
    expect(payload.counts.openProjects).toBe(2);
    expect(payload.counts.views).toMatchObject({ total: 2, active: 1, cached: 1, loading: 0 });
    expect(payload.counts.terminals.total).toBe(3);
    expect(payload.counts.terminals.byAgentState).toMatchObject({ working: 2, none: 1 });
  });

  it("WHY_SLOW_SECTION_DEGRADES_GRACEFULLY (#10910)", async () => {
    // The why-slow section aggregates six cross-process signals; when a source is
    // unavailable in this harness (no getWhySlowResourceSnapshot / flow-control /
    // workspace getter) each degrades to null instead of failing the snapshot.
    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      whySlow: {
        timestamp: number;
        resource: unknown;
        focusThrottle: { throttled: boolean; pollMultiplier: number };
        rendererTerminals: unknown[];
        pty: unknown;
        worktrees: unknown;
      };
    };

    expect(payload.whySlow).toBeDefined();
    // Focus throttle reads a synchronous leaf module — always populated.
    expect(payload.whySlow.focusThrottle).toEqual({ throttled: false, pollMultiplier: 1 });
    expect(Array.isArray(payload.whySlow.rendererTerminals)).toBe(true);
    expect(payload.whySlow.resource).toBeNull();
    expect(payload.whySlow.pty).toBeNull();
    expect(payload.whySlow.worktrees).toBeNull();
  });

  it("WHY_SLOW_LIVE_SNAPSHOT_TIMES_OUT_HUNG_SECTION (#10910)", async () => {
    // The live dock pull calls collectWhySlowSnapshot directly (no outer section
    // timeout). A hung pty-host must degrade to pty:null, not wedge the snapshot.
    const deps = {
      ptyClient: {
        getAllTerminalsAsync: async () => [],
        getFlowControlSnapshotAsync: () => new Promise(() => {}),
      },
    } as unknown as import("../../ipc/types.js").HandlerDependencies;

    const pending = diagnostics.collectWhySlowSnapshot(deps);
    await vi.advanceTimersByTimeAsync(4_000);
    const snap = (await pending) as {
      pty: unknown;
      focusThrottle: { throttled: boolean; pollMultiplier: number };
    };

    expect(snap.pty).toBeNull();
    expect(snap.focusThrottle).toEqual({ throttled: false, pollMultiplier: 1 });
  });

  it("WHY_SLOW_MEMORY_ATTRIBUTION_LEAKS_NO_COMMAND_LINES_OR_PATHS", async () => {
    // Terminal workload memory must reach both the whySlow snapshot and the
    // memoryAttribution export as process BASENAMES only — a command line or
    // cwd here would leak paths, tokens, and branch names into support bundles.
    const deps = {
      ptyClient: {
        getAllTerminalsAsync: async () => [],
        getMemoryRollup: async () => ({
          byProject: [
            {
              projectId: "proj-1",
              terminalCount: 2,
              processCount: 3,
              memoryKb: 2_048_000,
              topProcesses: [
                { pid: 101, comm: "node", cpuPercent: 12, memoryKb: 1_024_000 },
                { pid: 102, comm: "vite", cpuPercent: 3, memoryKb: 512_000 },
              ],
            },
          ],
          totalMemoryKb: 2_048_000,
          totalProcessCount: 3,
          terminalCount: 2,
          available: true,
          sampledAt: Date.now() - 4_000,
        }),
      },
    } as unknown as import("../../ipc/types.js").HandlerDependencies;

    const payload = (await diagnostics.collectDiagnostics(deps)) as {
      whySlow: {
        memory: {
          terminalWorkloads: {
            available: boolean;
            stale: boolean;
            totalMemoryMb: number;
            topProjects: Array<Record<string, unknown>>;
          };
        } | null;
      };
      memoryAttribution: {
        terminalWorkloads: {
          byProject: Array<{ topProcesses: Array<Record<string, unknown>> }>;
        };
      };
    };

    const workloads = payload.whySlow.memory!.terminalWorkloads;
    expect(workloads.available).toBe(true);
    expect(workloads.stale).toBe(false);
    expect(workloads.totalMemoryMb).toBe(2000);
    expect(workloads.topProjects[0].topProcessNames).toEqual(["node", "vite"]);
    // Structural no-leak contract: exactly these keys, nothing carrying a
    // command line or path can ride along unnoticed.
    expect(Object.keys(workloads.topProjects[0]).sort()).toEqual([
      "memoryMb",
      "processCount",
      "projectId",
      "terminalCount",
      "topProcessNames",
    ]);
    const topProcess = payload.memoryAttribution.terminalWorkloads.byProject[0].topProcesses[0];
    expect(Object.keys(topProcess).sort()).toEqual(["comm", "cpuPercent", "memoryKb", "pid"]);
    const serialized =
      JSON.stringify(payload.memoryAttribution) + JSON.stringify(payload.whySlow.memory);
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("cwd");
  });

  it("PROJECT_VIEWS_ISOLATE_PER_WINDOW_FAILURE (#10500)", async () => {
    const goodPvm = {
      getViewInventory: () => [
        {
          projectId: "p-ok",
          projectPath: "/Users/alice/ok",
          webContentsId: 201,
          state: "active",
          lastUsed: 1,
        },
      ],
      getCacheConfig: () => ({ maxCachedViews: 2, activeProjectId: "p-ok" }),
    };
    const badPvm = {
      getViewInventory: () => {
        throw new Error("PVM mid-teardown");
      },
      getCacheConfig: () => ({ maxCachedViews: 1, activeProjectId: null }),
    };
    const deps = {
      ptyClient: { getAllTerminalsAsync: async () => [] },
      windowRegistry: {
        all: () => [
          { windowId: 1, services: { projectViewManager: goodPvm } },
          { windowId: 2, services: { projectViewManager: badPvm } },
        ],
      },
    } as unknown as import("../../ipc/types.js").HandlerDependencies;

    const payload = (await diagnostics.collectDiagnostics(deps)) as {
      projectViews: Array<{ windowId: number; views?: unknown[]; error?: string }>;
      counts: { openProjects: number; views: { total: number } };
    };

    const good = payload.projectViews.find((w) => w.windowId === 1)!;
    const bad = payload.projectViews.find((w) => w.windowId === 2)!;
    // The healthy window's inventory survives even though window 2 threw.
    expect(good.views).toHaveLength(1);
    expect(bad.error).toBeDefined();
    // Counts skip the throwing PVM but still count the healthy one.
    expect(payload.counts.openProjects).toBe(1);
    expect(payload.counts.views.total).toBe(1);
  });

  it("NEW_SECTIONS_DEGRADE_GRACEFULLY_WITHOUT_SERVICES (#10500)", async () => {
    // No windowRegistry, no projectViewManager, resource-profile singleton absent.
    renderer.resourceProfileSnapshot = null;

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      projectViews: unknown[];
      memoryTrends: { processes: unknown };
      resourceState: { resourceProfile: unknown; hibernation: { isRunning: boolean } };
      counts: { windows: number; openProjects: number; terminals: { total: number } };
    };

    expect(payload.projectViews).toEqual([]);
    expect(Array.isArray(payload.memoryTrends.processes)).toBe(true);
    expect(payload.resourceState.resourceProfile).toBeNull();
    expect(payload.resourceState.hibernation.isRunning).toBe(false);
    expect(payload.counts.windows).toBe(0);
    expect(payload.counts.openProjects).toBe(0);
    expect(payload.counts.terminals.total).toBe(0);
  });

  it("FREE_TEXT_PEM_BLOCK_SCRUBBED", async () => {
    shared.logEntries = [
      {
        level: "error",
        message:
          "config dump: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY----- end",
        timestamp: 4,
      },
    ];

    const payload = (await diagnostics.collectDiagnostics(createDeps())) as {
      logs: { recentEntries: Array<{ message: string }> };
    };

    const msg = payload.logs.recentEntries[0]?.message ?? "";
    expect(msg).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(msg).not.toContain("MIIEpAIBAAKCAQEA");
    expect(msg).toContain("[REDACTED]");
  });
});
