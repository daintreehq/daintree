import type { ErrorRecord } from "@/store/errorStore";
import type { LogEntry } from "@shared/types/ipc/logs";
import type { EventRecord } from "@shared/types/ipc/events";
import type { SanitizedTelemetryEvent } from "@shared/types";
import type { WhySlowSnapshot } from "@shared/types/whySlow";
import type { PerfSummaryRow } from "@/store/perfMetricsStore";
import type { DiagnosticsTab } from "@/store/diagnosticsStore";

/**
 * Fixtures for the diagnostics preview. Everything here is data, not behaviour:
 * the preview entry pushes it through the same stores and bridge methods the
 * real tabs read, so what renders is the product's own code path.
 */

export interface DiagnosticsFixture {
  tab: DiagnosticsTab;
  what: string;
  errors?: ErrorRecord[];
  logs?: LogEntry[];
  logFilters?: { levels?: ("debug" | "info" | "warn" | "error")[]; search?: string };
  expandLogId?: string;
  events?: EventRecord[];
  selectedEventId?: string;
  telemetryActive?: boolean;
  telemetry?: SanitizedTelemetryEvent[];
  selectedTelemetryId?: string;
  perf?:
    | { kind: "rows"; rows: PerfSummaryRow[] }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "no-project" };
  live?: { fps: number | null; lafCount30s: number; cls30s: number };
  /** Why slow?: a snapshot, a failure, stale (one success then failures), or never-resolving. */
  whySlow?:
    | { kind: "ok"; snapshot: WhySlowSnapshot }
    | { kind: "fail" }
    | { kind: "stale"; snapshot: WhySlowSnapshot }
    | { kind: "pending" };
  expandProblemId?: string;
}

const NOW = Date.now();
const at = (secondsAgo: number) => NOW - secondsAgo * 1000;

function error(partial: Partial<ErrorRecord> & Pick<ErrorRecord, "id" | "message">): ErrorRecord {
  return {
    timestamp: at(60),
    type: "unknown",
    retryability: "none",
    dismissed: false,
    ...partial,
  };
}

export const PROBLEMS: ErrorRecord[] = [
  error({
    id: "e1",
    timestamp: at(12),
    type: "git",
    message: "git fetch failed: could not read Username for 'https://github.com'",
    details:
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n    at GitService.fetch (electron/services/GitService.ts:412:11)",
    source: "worktree-monitor",
    context: { worktreeId: "wt-feature-auth", command: "git fetch --prune origin" },
    retryability: "auto",
    retryAction: "git",
    recoveryHint: "Sign in to GitHub in Settings → Integrations, then retry",
    gitReason: "auth-failed",
  }),
  error({
    id: "e2",
    timestamp: at(45),
    type: "process",
    message: "Terminal exited unexpectedly (code 137)",
    details: "Process was killed by the OS (SIGKILL). The system may have run out of memory.",
    source: "pty-host",
    context: { terminalId: "term-3f2a", command: "npm run dev" },
    retryability: "auto",
    retryAction: "terminal",
    retryProgress: { attempt: 2, maxAttempts: 3 },
  }),
  error({
    id: "e3",
    timestamp: at(130),
    type: "filesystem",
    message:
      "Couldn't read .daintree/recipes/deploy-staging.json: Unexpected token } in JSON at position 1182 — the recipe was skipped and the remaining 6 recipes loaded normally",
    details: "SyntaxError: Unexpected token } in JSON at position 1182",
    source: "recipes",
    context: { filePath: "/Users/dev/acme/.daintree/recipes/deploy-staging.json" },
    retryability: "none",
  }),
  error({
    id: "e4",
    timestamp: at(300),
    type: "network",
    message: "Couldn't reach api.github.com",
    source: "forge:github",
    retryability: "exhausted",
    retryExhausted: true,
    occurrenceCount: 7,
  }),
  error({
    id: "e5",
    timestamp: at(900),
    type: "config",
    message: 'Unknown agent id "cursor-agent" in project settings',
    source: "agent-registry",
    retryability: "none",
    recoveryHint: "Remove it from .daintree/settings.json or install the Cursor agent plugin",
  }),
];

export const PROBLEMS_CROWDED: ErrorRecord[] = Array.from({ length: 24 }, (_, i) =>
  error({
    id: `c${i}`,
    timestamp: at(20 + i * 37),
    type: (["git", "process", "filesystem", "network", "config", "unknown"] as const)[i % 6]!,
    message: [
      "git status timed out after 10s in worktree feature/payments-v2",
      "Terminal exited unexpectedly (code 1)",
      "EACCES: permission denied, open '/Users/dev/acme/node_modules/.cache/x.json'",
      "Couldn't reach api.github.com",
      'Invalid keybinding "cmd+shift+" in user keybindings',
      "Renderer reported an unhandled promise rejection",
    ][i % 6]!,
    source: [
      "worktree-monitor",
      "pty-host",
      "file-watcher",
      "forge:github",
      "keybindings",
      "renderer",
    ][i % 6],
    retryability: i % 3 === 0 ? "auto" : "none",
    retryAction: i % 3 === 0 ? "git" : undefined,
    details: "Stack trace unavailable",
  })
);

const SOURCES = ["main", "pty-host", "workspace-host", "git", "mcp-server", "renderer", "plugins"];
const LOG_MESSAGES: Array<[LogEntry["level"], string, string, Record<string, unknown>?]> = [
  ["info", "main", "Project view created for acme-web (3 worktrees)"],
  ["debug", "workspace-host", "Polling worktree status every 5000ms"],
  ["info", "pty-host", "Spawned terminal term-3f2a (zsh) in /Users/dev/acme"],
  [
    "warn",
    "git",
    "git status took 2318ms in feature/payments-v2",
    { durationMs: 2318, worktree: "feature/payments-v2" },
  ],
  ["debug", "renderer", "Hydrated 14 panels from state.json"],
  ["info", "mcp-server", "MCP listener started on 127.0.0.1:47219"],
  [
    "error",
    "git",
    "git fetch failed: could not read Username for 'https://github.com'",
    {
      exitCode: 128,
      command: "git fetch --prune origin",
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    },
  ],
  [
    "warn",
    "pty-host",
    "Backpressure: paused term-9c1e (1.2 MB queued)",
    { terminalId: "term-9c1e", queuedBytes: 1258291 },
  ],
  ["info", "plugins", "Activated plugin github (builtin) in 42ms"],
  ["debug", "workspace-host", "Polling worktree status every 5000ms"],
];

export const LOGS: LogEntry[] = (() => {
  const out: LogEntry[] = [
    {
      id: "previous-session-separator",
      timestamp: at(4000),
      level: "info",
      message: "Previous session",
      context: {
        tail: "[14:02:11] [ERROR] [pty-host] Host exited with code 139 (SIGSEGV)\n[14:02:11] [WARN] [main] Restarting pty-host (attempt 1/3)\n[14:02:12] [INFO] [main] pty-host restarted; 6 terminals reattached",
      },
    },
  ];
  let n = 0;
  for (let round = 0; round < 6; round++) {
    for (const [level, source, message, context] of LOG_MESSAGES) {
      out.push({
        id: `log-${n}`,
        timestamp: at(600 - n * 7),
        level,
        source,
        message,
        context,
      });
      n++;
    }
  }
  // A burst of identical lines — the collapse path.
  for (let i = 0; i < 12; i++) {
    out.push({
      id: `log-burst-${i}`,
      timestamp: at(30 - i),
      level: "warn",
      source: "renderer",
      message: "ResizeObserver loop completed with undelivered notifications",
    });
  }
  return out;
})();

export const LOG_SOURCES = SOURCES;

const EVENT_TYPES: Array<[string, EventRecord["category"], Record<string, unknown>]> = [
  [
    "agent:state-changed",
    "agent",
    {
      agentId: "claude-7f3a91c2",
      terminalId: "term-3f2a",
      worktreeId: "wt-feature-auth",
      state: "working",
      previousState: "idle",
    },
  ],
  [
    "sys:worktree:update",
    "system",
    { worktreeId: "wt-feature-auth", branch: "feature/auth", ahead: 2, behind: 0 },
  ],
  [
    "server:status",
    "server",
    { terminalId: "term-9c1e", url: "http://localhost:5173", status: "running" },
  ],
  ["file:changed", "file", { worktreeId: "wt-main", path: "src/App.tsx" }],
  ["ui:notify", "ui", { type: "error", title: "Push failed" }],
  ["watcher:fired", "watcher", { worktreeId: "wt-main", count: 3 }],
  [
    "agent:completed",
    "agent",
    {
      agentId: "codex-19ab77e0",
      terminalId: "term-77aa",
      worktreeId: "wt-main",
      exitCode: 0,
      traceId: "tr-5c1d9e",
    },
  ],
];

export const EVENTS: EventRecord[] = Array.from({ length: 42 }, (_, i) => {
  const [type, category, payload] = EVENT_TYPES[i % EVENT_TYPES.length]!;
  return {
    id: `ev-${i}`,
    timestamp: at(420 - i * 9) + ((i * 137) % 1000),
    type,
    category,
    payload,
    source: i % 4 === 0 ? "renderer" : "main",
  };
});

export const TELEMETRY: SanitizedTelemetryEvent[] = [
  {
    id: "t1a2b3c4d5",
    kind: "analytics",
    timestamp: at(80),
    label: "onboarding.completed",
    payload: {
      event: "onboarding.completed",
      properties: { agentCount: 2, durationBucket: "1-5m" },
      platform: "darwin",
      appVersion: "0.9.2",
    },
  },
  {
    id: "t2b3c4d5e6",
    kind: "sentry",
    timestamp: at(40),
    label: "TypeError: Cannot read properties of undefined (reading 'id')",
    payload: {
      exception: {
        values: [
          { type: "TypeError", value: "Cannot read properties of undefined (reading 'id')" },
        ],
      },
      tags: { process: "renderer" },
      user: "[redacted]",
    },
  },
  {
    id: "t3c4d5e6f7",
    kind: "analytics",
    timestamp: at(10),
    label: "agent.launched",
    payload: { event: "agent.launched", properties: { agent: "claude", surface: "toolbar" } },
  },
];

export const PERF_ROWS: PerfSummaryRow[] = [
  {
    scenarioId: "boot",
    name: "Cold boot to first paint",
    mode: "ci",
    p95Ms: 1840.2,
    outsideReference: true,
    referenceNotes: "reference 1500ms; drift +23% since 0.9.0",
    generatedAt: new Date(at(3600)).toISOString(),
  },
  {
    scenarioId: "tab",
    name: "Project switch (warm)",
    mode: "ci",
    p95Ms: 182.4,
    outsideReference: false,
    generatedAt: new Date(at(3600)).toISOString(),
  },
  {
    scenarioId: "grid",
    name: "Grid reflow, 12 panes",
    mode: "ci",
    p95Ms: 38.9,
    outsideReference: false,
    generatedAt: new Date(at(3600)).toISOString(),
  },
  {
    scenarioId: "pty",
    name: "PTY throughput 50 MB",
    mode: "nightly",
    p95Ms: 4211.0,
    outsideReference: true,
    referenceNotes: "reference 3800ms",
    generatedAt: new Date(at(3600)).toISOString(),
  },
  {
    scenarioId: "palette",
    name: "Command palette open",
    mode: "smoke",
    p95Ms: 24.1,
    outsideReference: false,
    generatedAt: new Date(at(3600)).toISOString(),
  },
  {
    scenarioId: "soak",
    name: "8h soak — heap growth",
    mode: "soak",
    p95Ms: 0.4,
    outsideReference: false,
    generatedAt: new Date(at(3600)).toISOString(),
  },
];

function snapshot(overrides: Partial<WhySlowSnapshot> = {}): WhySlowSnapshot {
  return {
    timestamp: NOW,
    resource: {
      currentProfile: "performance",
      targetProfile: "performance",
      pressureScore: 0,
      reasons: [],
      lagPressureActive: false,
      lagEscalatedActive: false,
      thermalState: "nominal",
      isOnBattery: false,
      speedLimit: 100,
    },
    focusThrottle: { throttled: false, pollMultiplier: 1 },
    rendererTerminals: [
      {
        webContentsId: 3,
        webglMode: "webgl",
        wantsWebgl: 4,
        terminalCount: 6,
        countsByTier: { FOCUSED: 1, VISIBLE: 3, BACKGROUND: 2 },
        timestamp: NOW,
        ageMs: 1200,
        stale: false,
      },
    ],
    pty: {
      totalPendingBytes: 0,
      terminalCount: 6,
      pausedCount: 0,
      suspendedCount: 0,
      maxPausedDurationMs: 0,
      eventLoopP99Ms: 12,
      eventLoopMaxMs: 18,
      eventLoopUtilization: 0.08,
    },
    worktrees: { monitorCount: 4, fetchInFlightCount: 0 },
    workers: { subsystemCount: 3, aliveWorkerCount: 3, totalQueueDepth: 0, degraded: [] },
    memory: {
      appMemoryMb: 612,
      terminalWorkloads: {
        available: true,
        stale: false,
        ageMs: 4000,
        totalMemoryMb: 1840,
        processCount: 23,
        terminalCount: 6,
        topProjects: [],
      },
    },
    ...overrides,
  };
}

export const WHY_SLOW_CLEAR = snapshot();

export const WHY_SLOW_PRESSURE = snapshot({
  resource: {
    currentProfile: "efficiency",
    targetProfile: "balanced",
    pressureScore: 4,
    reasons: [
      { signal: "fleetSize", contribution: 1, detail: "12 active agents" },
      { signal: "memory", contribution: 2, detail: "Daintree using 3.1 GB (limit 2.5 GB)" },
      { signal: "battery", contribution: 1, detail: "on battery, 34%" },
    ],
    lagPressureActive: true,
    lagEscalatedActive: false,
    thermalState: "serious",
    isOnBattery: true,
    speedLimit: 70,
  },
  focusThrottle: { throttled: true, pollMultiplier: 4 },
  rendererTerminals: [
    {
      webContentsId: 3,
      webglMode: "dom",
      wantsWebgl: 14,
      terminalCount: 14,
      countsByTier: { BURST: 2, FOCUSED: 1, VISIBLE: 5, BACKGROUND: 6 },
      timestamp: NOW,
      ageMs: 900,
      stale: false,
    },
    {
      webContentsId: 5,
      webglMode: "webgl",
      wantsWebgl: 3,
      terminalCount: 3,
      countsByTier: { VISIBLE: 3 },
      timestamp: NOW,
      ageMs: 2100,
      stale: false,
    },
  ],
  pty: {
    totalPendingBytes: 3_400_000,
    terminalCount: 17,
    pausedCount: 3,
    suspendedCount: 0,
    maxPausedDurationMs: 8200,
    eventLoopP99Ms: 186,
    eventLoopMaxMs: 420,
    eventLoopUtilization: 0.91,
  },
  worktrees: { monitorCount: 11, fetchInFlightCount: 2 },
  workers: {
    subsystemCount: 3,
    aliveWorkerCount: 2,
    totalQueueDepth: 41,
    degraded: ["file-search"],
  },
  memory: {
    appMemoryMb: 3120,
    terminalWorkloads: {
      available: true,
      stale: true,
      ageMs: 95_000,
      totalMemoryMb: 9310,
      processCount: 142,
      terminalCount: 17,
      topProjects: [],
    },
  },
});

export const WHY_SLOW_STALE = snapshot({ timestamp: NOW - 40_000 });

export const DIAGNOSTICS_FIXTURES: Record<string, DiagnosticsFixture> = {
  "problems-empty": { tab: "problems", what: "no problems ever", errors: [] },
  "problems-cleared": {
    tab: "problems",
    what: "all dismissed",
    errors: PROBLEMS.map((e) => ({ ...e, dismissed: true })),
  },
  "problems-populated": { tab: "problems", what: "five mixed problems", errors: PROBLEMS },
  "problems-expanded": {
    tab: "problems",
    what: "first problem expanded",
    errors: PROBLEMS,
    expandProblemId: "e1",
  },
  "problems-crowded": { tab: "problems", what: "24 problems", errors: PROBLEMS_CROWDED },
  "logs-empty": { tab: "logs", what: "no logs", logs: [] },
  "logs-populated": { tab: "logs", what: "live tail with previous session", logs: LOGS },
  "logs-filtered": {
    tab: "logs",
    what: "error-only filter",
    logs: LOGS,
    logFilters: { levels: ["error"] },
    expandLogId: "log-6",
  },
  "logs-filtered-empty": {
    tab: "logs",
    what: "filter matches nothing",
    logs: LOGS,
    logFilters: { search: "kubernetes" },
  },
  "events-empty": { tab: "events", what: "no events", events: [] },
  "events-populated": {
    tab: "events",
    what: "42 events, one selected",
    events: EVENTS,
    selectedEventId: "ev-35",
  },
  "events-unselected": { tab: "events", what: "42 events, none selected", events: EVENTS },
  "telemetry-off": { tab: "telemetry", what: "preview off", telemetryActive: false, telemetry: [] },
  "telemetry-populated": {
    tab: "telemetry",
    what: "three payloads, one selected",
    telemetryActive: true,
    telemetry: TELEMETRY,
    selectedTelemetryId: "t2b3c4d5e6",
  },
  "perf-populated": {
    tab: "perf",
    what: "live + six results, two outside reference",
    perf: { kind: "rows", rows: PERF_ROWS },
    live: { fps: 41, lafCount30s: 3, cls30s: 0.004 },
  },
  "perf-empty": {
    tab: "perf",
    what: "no result files",
    perf: { kind: "empty" },
    live: { fps: 60, lafCount30s: 0, cls30s: 0 },
  },
  "perf-error": {
    tab: "perf",
    what: "result files unreadable",
    perf: {
      kind: "error",
      message: "EACCES: permission denied, scandir '/Users/dev/acme/.tmp/perf-results'",
    },
    live: { fps: 60, lafCount30s: 0, cls30s: 0 },
  },
  "perf-no-project": {
    tab: "perf",
    what: "no project open",
    perf: { kind: "no-project" },
    live: { fps: 60, lafCount30s: 0, cls30s: 0 },
  },
  "whyslow-clear": {
    tab: "whySlow",
    what: "nothing slowing down",
    whySlow: { kind: "ok", snapshot: WHY_SLOW_CLEAR },
  },
  "whyslow-pressure": {
    tab: "whySlow",
    what: "heavy pressure",
    whySlow: { kind: "ok", snapshot: WHY_SLOW_PRESSURE },
  },
  "whyslow-failed": { tab: "whySlow", what: "snapshot never loaded", whySlow: { kind: "fail" } },
  "whyslow-stale": {
    tab: "whySlow",
    what: "refresh failing, 40s-old data",
    whySlow: { kind: "stale", snapshot: WHY_SLOW_STALE },
  },
  "whyslow-loading": {
    tab: "whySlow",
    what: "first snapshot pending",
    whySlow: { kind: "pending" },
  },
};

export const FIXTURE_NAMES = Object.keys(DIAGNOSTICS_FIXTURES);
