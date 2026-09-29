import { bench, describe, vi } from "vitest";
import path from "path";
import { appendFileSync } from "fs";
import { serialize } from "v8";

// The builtin GitHub plugin's worktree subscription under multi-agent churn:
// 500 `worktree-update` events at 20 ms spacing (10 s simulated) against an
// unbound host whose worktree read is modelled on WorkspaceClient — a 5 ms
// round trip to the workspace host, the reply structured-cloned into main, and
// the 150 ms post-settle in-flight coalescing window. One worktree's PR is
// renumbered halfway through so the run also proves the invalidation lands.
//
//   npx vitest bench --run plugins/builtin/github/main/__bench__/worktreeSubscription.bench.ts

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-bench"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../../../electron/ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../../../electron/window/serviceRefs.js", () => ({
  getPtyClient: vi.fn(() => null),
}));
vi.mock("../../../../../electron/services/forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../../../../electron/services/fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn(() => true),
}));
vi.mock("../../../../../electron/services/PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../../../../electron/services/plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
}));
vi.mock("../../../../../electron/services/forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));
vi.mock("../GitHubPRs.js", () => ({
  getPRReviewThreads: vi.fn(async () => []),
}));

import {
  createHost,
  type PluginHostFactoryDeps,
  type PluginWorktreeSnapshotFetchResult,
} from "../../../../../electron/services/plugin/PluginHostFactory.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../../shared/types/plugin.js";
import type { PluginHostApi, PluginWorktreeSnapshot } from "../../../../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../../../../shared/types/workspace-host.js";
import type { ForgeProviderImpl } from "../../../../../shared/types/forge.js";
import type { LoadedPlugin } from "../../../../../electron/services/plugin/PluginServiceTypes.js";
import { registerReviewDecorationProvider } from "../reviewDecorationProvider.js";

const PLUGIN_ID = "daintree.github";
const ROOT = path.join(path.sep, "repos", "alpha");
const WORKTREES = 10;
const CHANGES_PER_WORKTREE = 2_000;
const EVENTS = 500;
const SPACING_MS = 20;
const RPC_LATENCY_MS = 5;
const COALESCE_WINDOW_MS = 150;
const RENUMBER_AT_EVENT = 250;

function makeSnapshots(renumbered: boolean): WorktreeSnapshot[] {
  return Array.from({ length: WORKTREES }, (_, w) => {
    const wtPath = path.join(ROOT, `wt-${w}`);
    const prNumber = w === 4 && renumbered ? 9_999 : 100 + w;
    return {
      id: wtPath,
      worktreeId: wtPath,
      path: wtPath,
      name: `wt-${w}`,
      branch: `feature/wt-${w}`,
      isCurrent: w === 0,
      isMainWorktree: w === 0,
      aheadCount: 2,
      behindCount: 0,
      linked:
        w % 2 === 0 ? { pr: { ref: { number: prNumber, owner: "acme", repo: "app" } } } : null,
      worktreeChanges: {
        worktreeId: wtPath,
        rootPath: wtPath,
        changedFileCount: CHANGES_PER_WORKTREE,
        changes: Array.from({ length: CHANGES_PER_WORKTREE }, (_, c) => ({
          path: `src/module-${Math.floor(c / 50)}/file-${c}.ts`,
          status: "modified",
          insertions: c % 17,
          deletions: c % 5,
          mtimeMs: 1_830_000_000_000 + c,
        })),
      },
    } as unknown as WorktreeSnapshot;
  });
}

const FIXTURES = { before: makeSnapshots(false), after: makeSnapshots(true) };
const REPLY_BYTES = serialize(FIXTURES.before).length;

interface Metrics {
  handlerCalls: number;
  fetchCalls: number;
  hostRpcs: number;
  bytesCloned: number;
  callbackRuns: number;
  invalidations: number;
  ms: number;
}

async function runScenario(): Promise<Metrics> {
  // Read before faking timers: Vitest fakes `performance` too.
  const started = performance.now();
  vi.useFakeTimers();
  let renumbered = false;
  const m: Metrics = {
    handlerCalls: 0,
    fetchCalls: 0,
    hostRpcs: 0,
    bytesCloned: 0,
    callbackRuns: 0,
    invalidations: 0,
    ms: 0,
  };

  let inflight: Promise<PluginWorktreeSnapshotFetchResult> | null = null;
  const fetchWorktreeSnapshotsResult = (): Promise<PluginWorktreeSnapshotFetchResult> => {
    m.fetchCalls++;
    if (inflight) return inflight;
    const promise = new Promise<void>((resolve) => setTimeout(resolve, RPC_LATENCY_MS)).then(() => {
      m.hostRpcs++;
      m.bytesCloned += REPLY_BYTES;
      const snapshots = structuredClone(renumbered ? FIXTURES.after : FIXTURES.before);
      setTimeout(() => {
        if (inflight === promise) inflight = null;
      }, COALESCE_WINDOW_MS);
      return { status: "ok" as const, projectId: "project-a", snapshots };
    });
    inflight = promise;
    return promise;
  };

  const handlers: Array<(payload?: { projectPath?: string }) => void> = [];
  const deps = {
    plugins: new Map<string, LoadedPlugin>([
      [
        PLUGIN_ID,
        {
          isBuiltin: true,
          manifest: {
            name: PLUGIN_ID,
            displayName: "GitHub",
            capabilities: [],
            contributes: {
              forgeProviders: [],
              fileDecorationProviders: [
                { id: "worktree-diff-review", scopes: ["worktree-diff:*"] },
              ],
            },
          },
        } as unknown as LoadedPlugin,
      ],
    ]),
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { schedulePluginActionsBroadcast: () => {} },
    panelLifecycleBroker: { subscribe: () => () => {} },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: () => undefined,
    recordPluginLog: () => {},
    serializePluginBadges: () => ({}),
    pluginDisplayName: (id: string) => id,
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    declaredCapabilities: () => new Set<string>(),
    fetchWorktreeSnapshotsResult,
    fetchWorktreeSnapshotsForProjectResult: fetchWorktreeSnapshotsResult,
    subscribeWorktreeEvent: (
      _pluginId: string,
      event: string,
      handler: (payload?: { projectPath?: string }) => void
    ) => {
      if (event === "worktree-update") handlers.push(handler);
      return () => {};
    },
  } as unknown as PluginHostFactoryDeps;

  const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
  let lastDelivered: PluginWorktreeSnapshot[] = [];
  const invalidatedAfterRenumber = new Set<string>();
  const counted = {
    ...host,
    onDidChangeWorktrees: (
      cb: (snapshots: PluginWorktreeSnapshot[]) => void,
      options?: { debounceMs?: number }
    ) =>
      host.onDidChangeWorktrees((snapshots) => {
        m.callbackRuns++;
        lastDelivered = snapshots;
        cb(snapshots);
      }, options),
    invalidateFileDecorations: (scope: string) => {
      m.invalidations++;
      if (renumbered) invalidatedAfterRenumber.add(scope);
      return Promise.resolve();
    },
  } as unknown as PluginHostApi;

  const dispose = await registerReviewDecorationProvider(counted, {} as ForgeProviderImpl);

  for (let i = 0; i < EVENTS; i++) {
    if (i === RENUMBER_AT_EVENT) renumbered = true;
    for (const handler of handlers) {
      m.handlerCalls++;
      handler({ projectPath: ROOT });
    }
    await vi.advanceTimersByTimeAsync(SPACING_MS);
  }
  await vi.advanceTimersByTimeAsync(2_000);
  dispose();
  vi.useRealTimers();
  m.ms = performance.now() - started;

  const renumberedScope = `worktree-diff:${path.join(ROOT, "wt-4")}`;
  const finalPr = lastDelivered.find((s) => s.path === path.join(ROOT, "wt-4"))?.linked?.pr?.ref;
  if (finalPr?.number !== 9_999 || !invalidatedAfterRenumber.has(renumberedScope)) {
    throw new Error("renumbered PR never reached the plugin");
  }
  return m;
}

// Counts are deterministic. Wall time grows across in-process repeats (the
// clones pile up for GC), so time is the first run of a fresh process: repeat
// the command rather than raising `iterations`. BENCH_OUT=<file> appends the
// metrics as one JSON line per process.
let first: Metrics | null = null;

describe("github plugin onDidChangeWorktrees under worktree-update churn", () => {
  bench(
    `${EVENTS} events @ ${SPACING_MS} ms, ${WORKTREES} worktrees x ${CHANGES_PER_WORKTREE} changes`,
    async () => {
      const m = await runScenario();
      if (first) return;
      first = m;
      const line = JSON.stringify({
        handlerCalls: m.handlerCalls,
        fetchCalls: m.fetchCalls,
        hostRpcs: m.hostRpcs,
        callbackRuns: m.callbackRuns,
        invalidations: m.invalidations,
        mbCloned: +(m.bytesCloned / 1_048_576).toFixed(1),
        ms: Math.round(m.ms),
      });
      console.log(line);
      if (process.env.BENCH_OUT) appendFileSync(process.env.BENCH_OUT, `${line}\n`);
    },
    { iterations: 1, warmupIterations: 0, time: 0 }
  );
});
