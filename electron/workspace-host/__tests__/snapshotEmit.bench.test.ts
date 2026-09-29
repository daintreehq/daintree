/**
 * Worktree snapshot emit benchmark. Skipped unless DAINTREE_BENCH=1:
 *
 *   DAINTREE_BENCH=1 npx vitest run electron/workspace-host/__tests__/snapshotEmit.bench.test.ts
 *
 * Drives a real WorktreeMonitor (git, fs and the file watcher mocked) through
 * 60 s of fake time and pushes every event the host would emit through real
 * `MessageChannel` ports — one standing in for main's parentPort plus
 * RENDERER_PORTS renderer ports — measuring emit count, v8-serialized bytes
 * and the synchronous `postMessage` time the host pays per port (sender side
 * only — receivers are not drained, so clone cost on the receiving isolates is
 * not included). The gate's own comparison cost is reported separately.
 */
import { describe, it, vi, afterAll } from "vitest";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { serialize } from "node:v8";
import type { Worktree } from "../../../shared/types/worktree.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

const mockGetWorktreeChangesWithStats = vi.fn();

vi.mock("../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(() => ({
    raw: vi.fn().mockResolvedValue(""),
    log: vi.fn().mockResolvedValue({ latest: null }),
  })),
  createWslHardenedGit: vi.fn(() => ({
    raw: vi.fn().mockResolvedValue(""),
    log: vi.fn().mockResolvedValue({ latest: null }),
  })),
  validateCwd: vi.fn(),
}));

vi.mock("../../utils/git.js", () => ({
  getWorktreeChangesWithStats: (...args: unknown[]) => mockGetWorktreeChangesWithStats(...args),
  invalidateGitStatusCache: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(() => ({ raw: vi.fn(), log: vi.fn().mockResolvedValue({ latest: null }) })),
}));

vi.mock("../../services/issueExtractor.js", () => ({
  extractIssueNumberSync: vi.fn().mockReturnValue(null),
  extractIssueNumber: vi.fn().mockResolvedValue(null),
  deriveIssueTitleFromBranch: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../utils/gitUtils.js", () => ({
  getGitDir: vi.fn().mockResolvedValue("/bench/worktree/.git"),
  clearGitDirCache: vi.fn(),
  clearGitCommonDirCache: vi.fn(),
}));

vi.mock("../../utils/gitRepoOperationState.js", () => ({
  isRepoOperationInProgress: vi.fn().mockReturnValue(false),
  getRepoOperationStateSync: vi.fn().mockReturnValue(undefined),
  OPERATION_SENTINEL_NAMES: [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ],
}));

interface CapturedWatcher {
  watchWorktree: boolean;
  onChange: () => void;
  onWorktreeFilesChanged?: (dirs: readonly string[] | null) => void;
}
const watchers: CapturedWatcher[] = [];
let recursiveStarts = true;

vi.mock("../../utils/gitFileWatcher.js", () => ({
  GitFileWatcher: class {
    private readonly captured: CapturedWatcher;
    constructor(opts: {
      watchWorktree?: boolean;
      onChange: () => void;
      onWorktreeFilesChanged?: (dirs: readonly string[] | null) => void;
    }) {
      this.captured = {
        watchWorktree: opts.watchWorktree === true,
        onChange: opts.onChange,
        onWorktreeFilesChanged: opts.onWorktreeFilesChanged,
      };
      watchers.push(this.captured);
    }
    updateDebouncePolicy() {}
    start() {
      return Promise.resolve(this.captured.watchWorktree ? recursiveStarts : true);
    }
    dispose() {}
  },
}));

import { WorktreeMonitor } from "../WorktreeMonitor.js";
import type { WorktreeMonitorConfig } from "../WorktreeMonitor.js";
import { WorktreeEmitGate } from "../WorktreeEmitGate.js";

const RENDERER_PORTS = 2;
const CHANGE_COUNT = 200;
const DURATION_MS = 60_000;
const BURST_INTERVAL_MS = 300;

const WORKTREE: Worktree = {
  id: "/bench/worktree",
  path: "/bench/worktree",
  name: "feature/bench",
  branch: "feature/bench",
  isCurrent: true,
  isMainWorktree: false,
};

const CONFIG: WorktreeMonitorConfig = {
  basePollingInterval: 2000,
  adaptiveBackoff: false,
  pollIntervalMax: 10000,
  circuitBreakerThreshold: 5,
  gitWatchEnabled: true,
};

const COMMIT_BODY = "x".repeat(4096);

function makeRepo() {
  const now = Date.now();
  const mtimes = Array.from({ length: CHANGE_COUNT }, () => now - 60_000);
  return {
    touch(i: number) {
      mtimes[i % CHANGE_COUNT] = Date.now();
    },
    status() {
      const changes = mtimes.map((mtimeMs, i) => ({
        path: `/bench/worktree/src/module-${i % 17}/component-file-${i}.tsx`,
        status: "modified" as const,
        insertions: 12 + (i % 7),
        deletions: 3 + (i % 5),
        mtimeMs,
      }));
      return {
        worktreeId: WORKTREE.id,
        rootPath: WORKTREE.path,
        changes,
        changedFileCount: changes.length,
        totalInsertions: changes.reduce((n, c) => n + c.insertions, 0),
        totalDeletions: changes.reduce((n, c) => n + c.deletions, 0),
        latestFileMtime: Math.max(...mtimes),
        lastUpdated: Date.now(),
        headOid: "0123456789abcdef0123456789abcdef01234567",
        lastCommitMessage: "feat: bench commit",
        lastCommitBody: COMMIT_BODY,
        lastCommitTimestampMs: now - 3_600_000,
        lastCommitAuthor: { name: "Bench", email: "bench@example.com" },
      };
    },
  };
}

type WireEvent = { type: string };

/**
 * What the host puts on the wire for one monitor snapshot — the same gate
 * `WorkspaceService.handleMonitorUpdate` uses. DAINTREE_BENCH_BASELINE=1
 * bypasses it to reproduce the pre-gate behaviour (every snapshot sent whole).
 */
let gateMs = 0;

function makeToWire() {
  const gate = new WorktreeEmitGate();
  const baseline = process.env.DAINTREE_BENCH_BASELINE === "1";
  return (monitor: WorktreeMonitor, snapshot: WorktreeSnapshot, seq: number): WireEvent => {
    const t0 = performance.now();
    const tick = baseline ? null : gate.next(monitor, snapshot);
    gateMs += performance.now() - t0;
    return tick
      ? ({ type: "worktree-tick", tick, epoch: "bench", seq } as WireEvent)
      : ({ type: "worktree-update", worktree: snapshot, epoch: "bench", seq } as WireEvent);
  };
}

interface Result {
  scenario: string;
  monitorEmits: number;
  fullEvents: number;
  tickEvents: number;
  bytesPerPort: number;
  totalBytes: number;
  postMs: number;
  postMsPerPort: number;
  gateMs: number;
}

const results: Result[] = [];

async function runScenario(
  scenario: string,
  opts: {
    recursive: boolean;
    drive: (w: CapturedWatcher, repo: ReturnType<typeof makeRepo>, tick: number) => void;
  }
): Promise<Result> {
  // Leave `performance` real so the postMessage timing below is wall-clock.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.spyOn(Math, "random").mockReturnValue(0);
  watchers.length = 0;
  recursiveStarts = opts.recursive;
  const repo = makeRepo();
  mockGetWorktreeChangesWithStats.mockImplementation(async () => repo.status());

  const channels = Array.from({ length: 1 + RENDERER_PORTS }, () => new MessageChannel());
  const ports: MessagePort[] = channels.map((c) => c.port1);
  for (const c of channels) c.port2.unref();

  let monitorEmits = 0;
  let fullEvents = 0;
  let tickEvents = 0;
  let bytesPerPort = 0;
  let postMs = 0;
  let seq = 0;
  let measuring = false;
  const toWire = makeToWire();
  gateMs = 0;

  const monitor: WorktreeMonitor = new WorktreeMonitor(
    WORKTREE,
    CONFIG,
    {
      onUpdate: (snapshot) => {
        if (!measuring) return;
        monitorEmits++;
        const event = toWire(monitor, snapshot, ++seq);
        if (event.type === "worktree-update") fullEvents++;
        else tickEvents++;
        bytesPerPort += serialize(event).byteLength;
        const t0 = performance.now();
        for (const port of ports) port.postMessage(event);
        postMs += performance.now() - t0;
      },
      onRemoved: () => {},
      onError: () => {},
    },
    "main"
  );

  await monitor.start();
  await vi.advanceTimersByTimeAsync(5_000);
  const watcher = watchers.at(-1)!;
  measuring = true;

  const bursts = DURATION_MS / BURST_INTERVAL_MS;
  for (let i = 0; i < bursts; i++) {
    opts.drive(watcher, repo, i);
    await vi.advanceTimersByTimeAsync(BURST_INTERVAL_MS);
  }
  measuring = false;
  monitor.stop();
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();

  const portCount = ports.length;
  return {
    scenario,
    monitorEmits,
    fullEvents,
    tickEvents,
    bytesPerPort,
    totalBytes: bytesPerPort * portCount,
    postMs,
    postMsPerPort: postMs / portCount,
    gateMs,
  };
}

describe.runIf(process.env.DAINTREE_BENCH === "1")("worktree snapshot emit benchmark", () => {
  afterAll(() => {
    process.stdout.write(
      `\nports: 1 main + ${RENDERER_PORTS} renderer, ${CHANGE_COUNT} changes, 60 s\n`
    );
    const rows = results.map((r) => ({
      scenario: r.scenario,
      "monitor emits": r.monitorEmits,
      "full events": r.fullEvents,
      "tick events": r.tickEvents,
      "KB per port": +(r.bytesPerPort / 1024).toFixed(1),
      "KB total": +(r.totalBytes / 1024).toFixed(1),
      "post ms total": +r.postMs.toFixed(2),
      "post ms per port": +r.postMsPerPort.toFixed(2),
      "gate ms": +r.gateMs.toFixed(2),
    }));
    process.stdout.write(JSON.stringify(rows, null, 1) + "\n");
  });

  it("tracked-file edits in 300 ms bursts (focused, recursive watcher)", async () => {
    results.push(
      await runScenario("tracked edits", {
        recursive: true,
        drive: (w, repo, i) => {
          repo.touch(i);
          w.onWorktreeFilesChanged?.([`src/module-${i % 17}`]);
          w.onChange();
        },
      })
    );
  }, 120_000);

  it("gitignored build-output writes in 300 ms bursts (focused, recursive watcher)", async () => {
    results.push(
      await runScenario("ignored writes", {
        recursive: true,
        drive: (w) => {
          w.onWorktreeFilesChanged?.(["dist/assets"]);
        },
      })
    );
  }, 120_000);
});
