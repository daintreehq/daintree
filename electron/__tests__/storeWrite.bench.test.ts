/**
 * electron-store write + crash-backup benchmark. Skipped unless DAINTREE_BENCH=1:
 *
 *   DAINTREE_BENCH=1 npx vitest run electron/__tests__/storeWrite.bench.test.ts
 *
 * Drives the real `store` proxy (conf-backed, as in production) against a
 * ~200 KB config.json in a temp dir, and the real CrashRecoveryService against
 * the same store plus 10 live workspace layouts (~50 panels). Counts the sync
 * file operations that touch config.json / the backup files and times the
 * main-thread block per APP_SET_STATE-shaped write and per takeBackup.
 */
import { afterAll, describe, it, vi } from "vitest";

const io = vi.hoisted(() => {
  const counts = { reads: 0, writes: 0, renames: 0, fsyncs: 0 };
  const state = { match: (_p: string) => false };
  const reset = () => {
    counts.reads = counts.writes = counts.renames = counts.fsyncs = 0;
  };
  // Patching fs is process-wide for this file's worker; only do it when the
  // bench actually runs.
  if (!process.env.DAINTREE_BENCH) return { counts, state, reset };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeModule = require("node:module") as typeof import("node:module");
  const wrap = <K extends "readFileSync" | "writeFileSync" | "renameSync">(
    name: K,
    onCall: (p: string) => void
  ) => {
    const original = fs[name] as (...args: unknown[]) => unknown;
    (fs as unknown as Record<string, unknown>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      const target = name === "renameSync" ? args[1] : args[0];
      if (typeof target === "string" && state.match(target)) onCall(target);
      return original.apply(this, args);
    };
  };
  wrap("readFileSync", () => counts.reads++);
  wrap("writeFileSync", () => counts.writes++);
  wrap("renameSync", () => counts.renames++);
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (fd: number) => {
    counts.fsyncs++;
    return originalFsync(fd);
  };
  nodeModule.syncBuiltinESMExports();
  return { counts, state, reset };
});

const tmpRoot = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return process.env.DAINTREE_BENCH
    ? fs.mkdtempSync(path.join(os.tmpdir(), "daintree-store-bench-"))
    : path.join(os.tmpdir(), "daintree-store-bench-unused");
});

vi.mock("electron-store", async () => {
  const conf = await import("conf");
  return { default: conf.default };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpRoot,
    getVersion: () => "1.0.0",
    isPackaged: false,
    on: () => {},
    removeListener: () => {},
  },
  BrowserWindow: { getAllWindows: () => [{}], getFocusedWindow: () => null },
}));

vi.mock("../services/GpuCrashMonitorService.js", () => ({ isGpuDisabledByFlag: () => false }));
vi.mock("../services/ActionBreadcrumbService.js", () => ({
  getActionBreadcrumbService: () => ({ getRecentActions: () => [] }),
}));
vi.mock("../services/SystemSleepService.js", () => ({
  getSystemSleepService: () => ({ onSuspend: () => () => {}, onWake: () => () => {} }),
}));

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { store, windowStatesStore, initializeStore, _resetStoreInstance } from "../store.js";
import { CrashRecoveryService } from "../services/CrashRecoveryService.js";
import { stateFilePath } from "../services/projectStorePaths.js";

const RUNS = Number(process.env.BENCH_RUNS) || 5;
const WORKSPACES = 10;
const PANELS_PER_WORKSPACE = 5;
const SETS_PER_SECOND = 5;
const SIM_SECONDS = 60;

const results: string[] = [];

function panel(ws: number, i: number) {
  return {
    id: `panel-${ws}-${i}`,
    kind: "terminal",
    type: "claude",
    title: `Agent ${ws}.${i} — working on something moderately descriptive`,
    cwd: `/Users/dev/Projects/repo-${ws}-worktrees/feature-branch-${i}`,
    worktreeId: `/Users/dev/Projects/repo-${ws}-worktrees/feature-branch-${i}`,
    location: i % 2 ? "grid" : "dock",
    agentId: "claude",
    command: "claude --dangerously-skip-permissions",
    launchAgentId: "claude",
    agentSessionId: `sess-${ws}-${i}-${"x".repeat(24)}`,
    createdAt: 1_700_000_000_000 + i,
  };
}

function realisticConfig(): Record<string, unknown> {
  const terminals = Array.from({ length: 50 }, (_, i) => panel(Math.floor(i / 5), i % 5));
  const recipes = Array.from({ length: 20 }, (_, i) => ({
    id: `recipe-${i}`,
    name: `Recipe ${i}`,
    terminals: Array.from({ length: 4 }, (_, j) => ({ type: "claude", title: `r${i}.${j}` })),
    createdAt: 1_700_000_000_000 + i,
  }));
  const pendingErrors = Array.from({ length: 150 }, (_, i) => ({
    id: `err-${i}`,
    message: `Something went wrong while doing operation ${i}: ${"detail ".repeat(12)}`,
    stack: `Error: boom\n    at fn${i} (file:///app/dist/main.js:1:${i})\n`.repeat(4),
    timestamp: 1_700_000_000_000 + i,
  }));
  const agentSessionHistory = {
    sessions: Array.from({ length: 200 }, (_, i) => ({
      sessionId: `s-${i}-${"y".repeat(20)}`,
      agentId: "claude",
      worktreeId: `/Users/dev/Projects/repo-${i % 10}-worktrees/b-${i}`,
      title: `Session ${i} about a moderately long task description`,
      savedAt: 1_700_000_000_000 + i,
    })),
  };
  return {
    _schemaVersion: 42,
    windowState: { width: 1600, height: 1000, isMaximized: false },
    terminalConfig: { scrollbackLines: 1000, performanceMode: false },
    appState: {
      sidebarWidth: 350,
      focusMode: false,
      terminals,
      recipes,
      hasSeenWelcome: true,
      panelGridConfig: { strategy: "automatic", value: 3 },
      mruList: Array.from({ length: 30 }, (_, i) => `/Users/dev/Projects/repo-${i}`),
      actionMruList: Array.from({ length: 40 }, (_, i) => `action.id.${i}`),
    },
    pendingErrors,
    agentSessionHistory,
    worktreeIssueMap: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`/wt/${i}`, { issueNumber: i, title: `Issue ${i}` }])
    ),
    runHistory: Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `run-${i}`,
        { startedAt: i, finishedAt: i + 1, exitCode: 0, command: "npm test" },
      ])
    ),
  };
}

function setupUserData(): string {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "config.json"),
    JSON.stringify(realisticConfig(), null, "\t")
  );
  _resetStoreInstance();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initializeStore({ defaults: { _schemaVersion: 0 }, cwd: tmpRoot } as any);
  windowStatesStore.set("windowStates", {
    "1": { x: 0, y: 0, width: 1600, height: 1000, isMaximized: false },
  } as never);
  return path.join(tmpRoot, "config.json");
}

// The APP_SET_STATE handler's persistence core (electron/ipc/handlers/app/state.ts).
function appSetState(updates: Record<string, unknown>): void {
  const current = (store.get("appState") ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current, ...updates };
  store.set("appState", merged as never);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

describe.skipIf(!process.env.DAINTREE_BENCH)("store write bench", () => {
  afterAll(() => {
    _resetStoreInstance();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.stdout.write("\n" + results.join("\n") + "\n");
  });

  it("APP_SET_STATE: 300 sets (60 s of traffic at 5/s, run back to back)", () => {
    for (let run = 0; run < RUNS; run++) {
      const configPath = setupUserData();
      const size = fs.statSync(configPath).size;
      // Warm the read cache the way boot does.
      store.get("appState");
      io.state.match = (p) => p.startsWith(configPath);
      io.reset();
      const perSet: number[] = [];
      let commits = 0;
      let ino = fs.statSync(configPath).ino;
      const total = SETS_PER_SECOND * SIM_SECONDS;
      for (let i = 0; i < total; i++) {
        const t0 = performance.now();
        appSetState(i % 3 === 0 ? { sidebarWidth: 300 + (i % 50) } : { mruList: [`/r/${i}`] });
        // A typical reader between writes (e.g. a boot/IPC get).
        store.get("appState");
        perSet.push(performance.now() - t0);
        const nextIno = fs.statSync(configPath).ino;
        if (nextIno !== ino) commits++;
        ino = nextIno;
      }
      const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        appState: { mruList: string[] };
      };
      io.state.match = () => false;
      if (onDisk.appState.mruList[0] !== `/r/${total - 1}`) {
        throw new Error("final write did not reach disk");
      }
      results.push(
        `set run ${run}: config=${(size / 1024).toFixed(0)}KB sets=${total} ` +
          `config.json reads=${io.counts.reads} file replacements=${commits} ` +
          `fsync=${io.counts.fsyncs} ms/(set+get) median=${median(perSet).toFixed(3)} p95=${p95(perSet).toFixed(3)} ` +
          `total=${perSet.reduce((a, b) => a + b, 0).toFixed(1)}ms`
      );
    }
  }, 120_000);

  it("crash backups: 1 h steady state, 10 workspaces / 50 panels", () => {
    for (let run = 0; run < RUNS; run++) {
      setupUserData();
      const ids = Array.from({ length: WORKSPACES }, (_, i) => i.toString(16).padStart(64, "a"));
      for (let w = 0; w < WORKSPACES; w++) {
        const file = stateFilePath(path.join(tmpRoot, "projects"), ids[w])!;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify({
            _schemaVersion: 1,
            terminals: Array.from({ length: PANELS_PER_WORKSPACE }, (_, i) => panel(w, i)),
          })
        );
      }
      const backupDir = path.join(tmpRoot, "backups");
      // Everything under userData except the two electron-store files.
      io.state.match = (p) =>
        p.startsWith(tmpRoot) && !/(config|window-states)\.json/.test(path.basename(p));

      vi.useFakeTimers();
      try {
        const service = new CrashRecoveryService();
        service.initialize();
        service.setLiveWorkspaceIdsProvider(() => ids);
        io.reset();
        const backupMs: number[] = [];
        const proto = CrashRecoveryService.prototype as unknown as { takeBackup(): void };
        const takeBackup = proto.takeBackup;
        (service as unknown as { takeBackup(): void }).takeBackup = function () {
          const t0 = performance.now();
          takeBackup.call(this);
          backupMs.push(performance.now() - t0);
        };
        const backupPath = path.join(backupDir, "session-state.json");
        let backupCommits = 0;
        service.startBackupTimer();
        // Steady state: timer ticks every 60 s; a crash-critical APP_SET_STATE
        // whose value did not change (MRU re-sent, focus toggled back) every
        // 20 s; a real change every 5 min.
        let lastIno = fs.existsSync(backupPath) ? fs.statSync(backupPath).ino : 0;
        const pollCommit = () => {
          const ino = fs.existsSync(backupPath) ? fs.statSync(backupPath).ino : 0;
          if (ino !== lastIno) {
            backupCommits++;
            lastIno = ino;
          }
        };
        for (let s = 1; s <= 3600; s++) {
          if (s % 20 === 0) {
            const changed = s % 300 === 0;
            appSetState({
              mruList: changed
                ? [`/r/${s}`]
                : (store.get("appState") as { mruList: string[] }).mruList,
            });
            service.scheduleBackup();
          }
          vi.advanceTimersByTime(1000);
          pollCommit();
        }
        service.stopBackupTimer();
        results.push(
          `backup run ${run}: backup file replacements/h=${backupCommits} takeBackup calls=${backupMs.length} ` +
            `renames(backup+marker)=${io.counts.renames} readFileSync=${io.counts.reads} ` +
            `ms/takeBackup median=${median(backupMs).toFixed(3)} p95=${p95(backupMs).toFixed(3)} ` +
            `total=${backupMs.reduce((a, b) => a + b, 0).toFixed(1)}ms`
        );
      } finally {
        vi.useRealTimers();
        io.state.match = () => false;
      }
    }
  }, 120_000);
});
