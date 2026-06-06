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
