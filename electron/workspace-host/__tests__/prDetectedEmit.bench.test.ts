/**
 * PR detection re-announce benchmark. Skipped unless DAINTREE_BENCH=1:
 *
 *   DAINTREE_BENCH=1 npx vitest run electron/workspace-host/__tests__/prDetectedEmit.bench.test.ts
 *
 * Wires the real PullRequestService, PRIntegrationService and
 * WorkspaceService.onPRDetected/onPRCleared over real WorktreeMonitors (git,
 * fs and the forge bridge mocked) and counts what reaches the host → main →
 * renderer pipe:
 *
 * - "focused hour": 20 worktrees (16 with a PR, 4 without) over 60 min of fake
 *   time, with the app-focus refresh every 2 min on top of the normal poll and
 *   revalidation timers. Nothing on the forge changes except one title edit and
 *   one CI flip at minute 30, which must still reach the wire.
 * - "identical events": 1000 identical `sys:pr:detected` events for one worktree.
 *
 * Bytes are v8-serialized sizes of every PR-originated host event (what
 * `postMessage` structured-clones once per port).
 */
import { describe, it, vi, afterAll, afterEach, expect } from "vitest";
import { serialize } from "node:v8";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { WorkspaceHostEvent } from "../../../shared/types/workspace-host.js";
import type { CIStatus, PR as ForgePR, RepoRef } from "../../../shared/types/forge.js";

const infoLog = vi.hoisted(() => ({ prDetected: 0 }));
vi.mock("../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/logger.js")>();
  return {
    ...actual,
    logInfo: (message: string) => {
      if (message === "PR detected for worktree") infoLog.prDetected++;
    },
    logDebug: () => {},
    logWarn: () => {},
  };
});

const git = {
  raw: vi.fn().mockResolvedValue(""),
  log: vi.fn().mockResolvedValue({ latest: null }),
  getConfig: vi.fn().mockResolvedValue({ value: "https://github.com/bench/repo.git" }),
  checkIsRepo: vi.fn().mockResolvedValue(true),
  branch: vi.fn().mockResolvedValue({ current: "main" }),
};

vi.mock("simple-git", () => ({ simpleGit: vi.fn(() => git) }));
vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => git),
  createWslHardenedGit: vi.fn(() => git),
  createAuthenticatedGit: vi.fn(() => git),
  validateBranchName: vi.fn(),
  validateCwd: vi.fn(),
}));
vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: vi.fn().mockResolvedValue(null),
  invalidateGitStatusCache: vi.fn(),
}));
vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockResolvedValue("/bench/repo/.git"),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));
vi.mock("../../utils/fs.js", () => ({ waitForPathExists: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));
vi.mock("fs/promises", () => ({
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
}));
vi.mock("fs", () => ({ existsSync: vi.fn().mockReturnValue(true) }));
vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    updateDebouncePolicy() {}
    start() {
      return Promise.resolve(true);
    }
    dispose() {}
  },
}));

const WORKTREES = 20;
const WITH_PR = 16;
const REPO: RepoRef = { host: "github.com", owner: "bench", repo: "repo", rawData: null };

const forge = vi.hoisted(() => ({
  prs: new Map<string, unknown>(),
  ci: new Map<number, unknown>(),
}));

function makePR(n: number): ForgePR {
  return {
    number: n,
    title: `feat: bench change ${n}`,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: `https://github.com/bench/repo/pull/${n}`,
    baseRef: "develop",
    headRef: `feature/bench-${n}`,
    createdAt: 0,
    updatedAt: 0,
    rawData: null,
  };
}

function makeCI(state: "success" | "failure"): CIStatus {
  return {
    state,
    total: 12,
    passed: state === "success" ? 12 : 10,
    failed: state === "success" ? 0 : 2,
    pending: 0,
    requiredChecksPassing: state === "success",
    rawData: null,
  };
}

vi.mock("../forgeBridge.js", () => {
  const bridge = {
    resolveProvider: vi.fn(async () => ({
      status: "resolved",
      namespacedId: "daintree.github.github",
      repo: { host: "github.com", owner: "bench", repo: "repo", rawData: null },
    })),
    findPRByBranch: vi.fn(async (_id: string, _repo: unknown, branch: string) =>
      structuredClone(forge.prs.get(branch) ?? null)
    ),
    findPRsByBranches: vi.fn(async (_id: string, _repo: unknown, branches: string[]) => {
      return new Map(branches.map((b) => [b, structuredClone(forge.prs.get(b) ?? null)]));
    }),
    findPRsByNumbers: vi.fn(async (_id: string, _repo: unknown, numbers: number[]) => {
      const all = [...forge.prs.values()] as Array<{ number: number }>;
      return new Map(
        numbers.map((n) => [n, structuredClone(all.find((p) => p.number === n) ?? null)])
      );
    }),
    getPR: vi.fn(async () => null),
    getIssue: vi.fn(async () => null),
    getCIStatus: vi.fn(async (_id: string, _repo: unknown, n: number) =>
      structuredClone(forge.ci.get(n) ?? null)
    ),
    getCIStatuses: vi.fn(async (_id: string, _repo: unknown, numbers: number[]) => {
      return new Map(numbers.map((n) => [n, structuredClone(forge.ci.get(n) ?? null)]));
    }),
    probeOpenPRList: vi.fn(async () => ({ kind: "fallback" })),
    getRateLimit: vi.fn(async () => null),
    clearPullRequestCaches: vi.fn(async () => {}),
    handleResult: vi.fn(),
    dispose: vi.fn(),
  };
  return { getForgeBridge: () => bridge, initForgeBridge: vi.fn(() => bridge) };
});

import { events } from "../../services/events.js";
import { pullRequestService } from "../../services/PullRequestService.js";
import { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { WorkspaceService } from "../WorkspaceService.js";

const PR_EVENT_TYPES = new Set(["pr-detected", "pr-cleared", "worktree-update", "worktree-tick"]);

interface Counters {
  busDetected: number;
  busCleared: number;
  prDetectedLogs: number;
  sent: Record<string, number>;
  bytes: number;
  harnessMs: number;
}

function newCounters(): Counters {
  return { busDetected: 0, busCleared: 0, prDetectedLogs: 0, sent: {}, bytes: 0, harnessMs: 0 };
}

interface Harness {
  service: WorkspaceService;
  counters: Counters;
  sentLog: WorkspaceHostEvent[];
  dispose(): void;
}

async function makeHarness(): Promise<Harness> {
  const counters = newCounters();
  const sentLog: WorkspaceHostEvent[] = [];
  const { WorkspaceService: WS } = await import("../WorkspaceService.js");
  const service = new WS((event: WorkspaceHostEvent) => {
    if (!PR_EVENT_TYPES.has(event.type)) return true;
    counters.sent[event.type] = (counters.sent[event.type] ?? 0) + 1;
    counters.bytes += serialize(event).byteLength;
    sentLog.push(event);
    return true;
  });

  const monitors = (service as unknown as { monitors: Map<string, WorktreeMonitor> }).monitors;
  const candidates: Array<{ worktreeId: string; branch: string }> = [];
  for (let i = 0; i < WORKTREES; i++) {
    const branch = `feature/bench-${100 + i}`;
    const wt: Worktree = {
      id: `/bench/wt-${i}`,
      path: `/bench/wt-${i}`,
      name: branch,
      branch,
      isCurrent: i === 0,
      isMainWorktree: false,
    };
    const monitor = new WorktreeMonitor(
      wt,
      {
        basePollingInterval: 2000,
        adaptiveBackoff: false,
        pollIntervalMax: 10000,
        circuitBreakerThreshold: 5,
        gitWatchEnabled: false,
      },
      { onUpdate: () => {}, onRemoved: () => {}, onError: () => {} },
      "main"
    );
    (monitor as unknown as { _hasInitialStatus: boolean })._hasInitialStatus = true;
    monitors.set(wt.id, monitor);
    candidates.push({ worktreeId: wt.id, branch });
  }

  const offDetected = events.on("sys:pr:detected", () => counters.busDetected++);
  const offCleared = events.on("sys:pr:cleared", () => counters.busCleared++);

  const prService = (
    service as unknown as {
      prService: {
        initialize(
          root: string,
          projectId: string,
          get: () => Array<{ worktreeId: string; branch: string }>
        ): Promise<void>;
        cleanup(): void;
      };
    }
  ).prService;
  void prService.initialize("/bench/repo", "bench-project", () => candidates);

  return {
    service,
    counters,
    sentLog,
    dispose() {
      offDetected();
      offCleared();
      // Unsubscribes this harness's PR listeners and resets the singleton.
      prService.cleanup();
      for (const m of monitors.values()) m.stop();
      monitors.clear();
    },
  };
}

function seedForge() {
  forge.prs.clear();
  forge.ci.clear();
  for (let i = 0; i < WITH_PR; i++) {
    const n = 100 + i;
    forge.prs.set(`feature/bench-${n}`, makePR(n));
    forge.ci.set(n, makeCI(i % 8 === 7 ? "failure" : "success"));
  }
}

interface Row {
  scenario: string;
  busDetected: number;
  busCleared: number;
  prDetectedInfoLogs: number;
  prDetectedSent: number;
  prClearedSent: number;
  worktreeUpdateSent: number;
  worktreeTickSent: number;
  totalSent: number;
  kbSerialized: number;
  harnessMs: number;
}

const rows: Row[] = [];

function toRow(scenario: string, c: Counters): Row {
  const sent = c.sent;
  return {
    scenario,
    busDetected: c.busDetected,
    busCleared: c.busCleared,
    prDetectedInfoLogs: c.prDetectedLogs,
    prDetectedSent: sent["pr-detected"] ?? 0,
    prClearedSent: sent["pr-cleared"] ?? 0,
    worktreeUpdateSent: sent["worktree-update"] ?? 0,
    worktreeTickSent: sent["worktree-tick"] ?? 0,
    totalSent: Object.values(sent).reduce((a, b) => a + b, 0),
    kbSerialized: +(c.bytes / 1024).toFixed(1),
    harnessMs: +c.harnessMs.toFixed(1),
  };
}

function resetCounters(c: Counters) {
  Object.assign(c, newCounters());
  infoLog.prDetected = 0;
}

describe.runIf(process.env.DAINTREE_BENCH === "1")("PR detected re-announce benchmark", () => {
  let harness: Harness | null = null;

  afterEach(() => {
    harness?.dispose();
    harness = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // harnessMs is whole-harness elapsed time (fake-timer advance and mock
    // forge included) — indicative only; counts and bytes are the comparison.
    process.stdout.write("\n" + JSON.stringify(rows, null, 1) + "\n");
  });

  it("focused hour: 20 worktrees, focus refresh every 2 min", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    seedForge();
    const h = (harness = await makeHarness());

    // Warm-up: startup jitter, first detection and CI enrichment land.
    await vi.advanceTimersByTimeAsync(20_000);
    const warm = { ...h.counters, sent: { ...h.counters.sent } };
    expect(warm.sent["pr-detected"] ?? 0).toBeGreaterThanOrEqual(WITH_PR);
    expect(warm.sent["pr-cleared"] ?? 0).toBeGreaterThanOrEqual(WORKTREES - WITH_PR);
    resetCounters(h.counters);
    h.sentLog.length = 0;

    const t0 = performance.now();
    for (let minute = 0; minute < 60; minute += 2) {
      if (minute === 30) {
        // Real changes must still propagate.
        (forge.prs.get("feature/bench-100") as ForgePR).title = "feat: retitled";
        forge.ci.set(101, makeCI("failure"));
      }
      if (minute === 40) {
        // A PR opening on a branch that had none must still be picked up.
        forge.prs.set("feature/bench-119", makePR(119));
        forge.ci.set(119, makeCI("success"));
      }
      void pullRequestService.refresh();
      await vi.advanceTimersByTimeAsync(120_000);
    }
    h.counters.harnessMs = performance.now() - t0;
    h.counters.prDetectedLogs = infoLog.prDetected;
    rows.push(toRow("focused hour (20 wt, refresh/2min)", h.counters));

    const retitled = h.sentLog.filter(
      (e) =>
        e.type === "pr-detected" &&
        (e as { worktreeId: string; prTitle?: string }).worktreeId === "/bench/wt-0" &&
        (e as { prTitle?: string }).prTitle === "feat: retitled"
    );
    const reddened = h.sentLog.filter(
      (e) =>
        e.type === "pr-detected" &&
        (e as { worktreeId: string }).worktreeId === "/bench/wt-1" &&
        (e as { prCiStatus?: string }).prCiStatus === "failure"
    );
    expect(retitled.length).toBeGreaterThanOrEqual(1);
    expect(reddened.length).toBeGreaterThanOrEqual(1);
    const monitors = (h.service as unknown as { monitors: Map<string, WorktreeMonitor> }).monitors;
    expect(monitors.get("/bench/wt-0")!.getSnapshot().prTitle).toBe("feat: retitled");
    expect(monitors.get("/bench/wt-1")!.getSnapshot().prCiStatus).toBe("failure");
    expect(monitors.get("/bench/wt-18")!.getSnapshot().linked).toBeNull();
    expect(monitors.get("/bench/wt-19")!.getSnapshot().prNumber).toBe(119);
    expect(monitors.get("/bench/wt-19")!.getSnapshot().linked?.pr?.ciStatus?.state).toBe("success");
    expect(monitors.get("/bench/wt-2")!.getSnapshot().linked?.pr?.baseRef).toBe("develop");
  }, 120_000);

  it("1000 identical sys:pr:detected events for one worktree", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    seedForge();
    const h = (harness = await makeHarness());
    pullRequestService.stop();
    const payload = {
      worktreeId: "/bench/wt-3",
      prNumber: 103,
      prUrl: "https://github.com/bench/repo/pull/103",
      prState: "open" as const,
      prCiStatus: "success" as const,
      ciStatus: makeCI("success"),
      prTitle: "feat: bench change 103",
      branchName: "feature/bench-103",
      providerId: "daintree.github.github",
      owner: REPO.owner,
      repo: REPO.repo,
      baseRef: "develop",
    };
    events.emit("sys:pr:detected", { ...payload, timestamp: Date.now() });
    resetCounters(h.counters);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      events.emit("sys:pr:detected", { ...payload, timestamp: Date.now() });
    }
    h.counters.harnessMs = performance.now() - t0;
    h.counters.prDetectedLogs = infoLog.prDetected;
    rows.push(toRow("1000 identical detected events", h.counters));
  }, 60_000);
});
