import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "1.0.0"), getPath: vi.fn(() => "/tmp"), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
}));

// Mutable so a test can vary the legacy global app state without replacing the
// `store.get` implementation, which `clearAllMocks` would not restore.
const { globalAppStateRef, legacyOwnerRef, defaultStoreGet, defaultStoreSet } = vi.hoisted(() => {
  const globalAppStateRef = {
    current: { terminals: [], sidebarWidth: 350 } as Record<string, unknown>,
  };
  // Which workspace, if any, has already claimed the legacy global record.
  // `undefined` is the unclaimed state a fresh store reads back (#11651).
  const legacyOwnerRef = { current: undefined as string | undefined };
  // Named so `beforeEach` can reinstate it. Several tests below still swap in
  // their own `store.get` implementation; without a reset every test declared
  // after them would silently read that hard-coded state instead of the ref,
  // which is exactly the trap the comment above warns about.
  const defaultStoreGet = (key: string): unknown => {
    if (key === "appState") return globalAppStateRef.current;
    if (key === "legacyWorkspaceStateOwnerId") return legacyOwnerRef.current;
    if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
    if (key === "agentSettings") return {};
    return undefined;
  };
  // Stateful on purpose: the whole concurrency argument is that a claim written
  // during one hydrate is visible to the next read with no await in between. A
  // `set` that only records the call would let a two-hydrate test pass while
  // the claim never actually took.
  const defaultStoreSet = (key: string, value: unknown): void => {
    if (key === "legacyWorkspaceStateOwnerId") {
      legacyOwnerRef.current = typeof value === "string" ? value : undefined;
    }
  };
  return { globalAppStateRef, legacyOwnerRef, defaultStoreGet, defaultStoreSet };
});

const DEFAULT_GLOBAL_APP_STATE = { terminals: [], sidebarWidth: 350 };

/**
 * Legacy global app state left behind by whichever real project was open before
 * per-workspace state existed. Every value here is deliberately distinct from
 * both the defaults and any saved per-workspace state, so an assertion can tell
 * "inherited the legacy global" apart from "fell back to a default" (#11497).
 */
const LEGACY_WORKSPACE_STATE = {
  focusMode: true,
  focusPanelState: { sidebarWidth: 260, diagnosticsOpen: true },
  activeWorktreeId: "wt-legacy",
  mruList: ["terminal:legacy-panel", "worktree:wt-legacy"],
};

/** A genuinely app-global field, used to prove the fix stays narrowly scoped. */
const GLOBAL_PANEL_GRID_CONFIG = { strategy: "fixed-columns", value: 2 };

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn(defaultStoreGet),
    set: vi.fn(defaultStoreSet),
    delete: vi.fn(),
  },
  consumePendingSettingsRecovery: vi.fn(() => null),
  windowStatesStore: { get: vi.fn(), set: vi.fn() },
}));

const crashService = {
  scheduleBackup: vi.fn(),
  consumePanelFilter: vi.fn(() => null),
  hasPendingPanelFilter: vi.fn(() => false),
  startBackupTimer: vi.fn(),
  resetToFresh: vi.fn(),
  restoreBackup: vi.fn(() => false),
  setPanelFilter: vi.fn(),
  clearPendingCrash: vi.fn(),
  getPendingCrash: vi.fn() as any,
  getConfig: vi.fn(() => ({ autoRestoreOnCrash: false })),
};

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashService,
  initializeCrashRecoveryService: vi.fn(),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => null),
    getAllProjects: vi.fn(() => []),
    getProjectById: vi.fn(() => null),
    getProjectStateWithRecovery: vi.fn(),
    wasStateUnreadableThisSession: vi.fn(() => false),
    saveProjectState: vi.fn(),
    enqueueProjectStateUpdate: vi.fn(async () => undefined),
    readInRepoPresets: vi.fn(async () => ({})),
  },
}));

vi.mock("../../utils/gpuDetection.js", () => ({
  getGpuFeatureStatus: vi.fn(() => ({ webgl2: "hardware" })),
  getWebGLFeatureStatus: vi.fn((status: { webgl?: string; webgl2?: string } | null) =>
    status ? (status.webgl2 ?? status.webgl) : undefined
  ),
  isWebGLHardwareAccelerated: vi.fn(() => true),
  whenGpuReported: vi.fn(async (_timeoutMs: number) => {}),
}));

vi.mock("../../services/GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
  isGpuAngleFallbackApplied: vi.fn(() => false),
}));

const crashGuard = {
  isSafeMode: vi.fn(() => false),
  getCrashCount: vi.fn(() => 0),
  getLastCrashTimestamp: vi.fn(() => null),
  getQuarantinedStatePath: vi.fn(() => null),
  resetForNormalBoot: vi.fn(),
};

vi.mock("../../services/CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => crashGuard,
}));

const panelSuspectLedger = {
  getQuarantinedPanelIds: vi.fn(() => new Set<string>()),
  getQuarantinedPanels: vi.fn(() => [] as Array<Record<string, unknown>>),
  clearQuarantinedPanel: vi.fn((_panelId: string) => false),
};

vi.mock("../../services/PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => panelSuspectLedger,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  closeTelemetry: vi.fn(),
}));

const consumeDatabaseRecovery = vi.hoisted(() => vi.fn(() => null as unknown));
const restoreDatabaseRecovery = vi.hoisted(() => vi.fn());

vi.mock("../../services/DatabaseMaintenanceService.js", () => ({
  getDatabaseMaintenanceService: () => ({
    consumeRecovery: consumeDatabaseRecovery,
    restoreRecovery: restoreDatabaseRecovery,
  }),
}));

vi.mock("../../window/deferredInitQueue.js", () => ({
  signalFirstInteractive: vi.fn(),
}));

vi.mock("../../services/databaseBackupNotice.js", () => ({
  noteDatabaseNoticeRendererReady: vi.fn(),
}));

vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  isPerformanceCaptureEnabled: vi.fn(() => false),
  sampleIpcTiming: vi.fn(),
}));

vi.mock("../../services/prefetchHydrateCache.js", () => ({
  consumePrefetchedHydrateResult: vi.fn(() => null),
}));

// Decided by default, the steady state of every project past its first open,
// so the cache tests below are not also first-hydrate tests (#13782).
vi.mock("../../services/plugin/projectLayoutSeeds.js", () => ({
  getProjectLayoutSeed: vi.fn(() => ({ status: "settled", at: 0 })),
  captureProjectLayoutSeed: vi.fn(),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getProjectForWebContents: vi.fn(() => null),
}));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());

vi.mock("../../ipc/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/utils.js")>();
  return {
    ...actual,
    assertIpcSecurityReady: vi.fn(),
    broadcastToRenderer: broadcastToRendererMock,
  };
});

import { registerAppStateHandlers } from "../handlers/app/state.js";
import { noteDatabaseNoticeRendererReady } from "../../services/databaseBackupNotice.js";
import { CHANNELS } from "../channels.js";
import { consumePrefetchedHydrateResult } from "../../services/prefetchHydrateCache.js";
import {
  captureProjectLayoutSeed,
  getProjectLayoutSeed,
} from "../../services/plugin/projectLayoutSeeds.js";
import { projectStore } from "../../services/ProjectStore.js";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import { markPerformance } from "../../utils/performance.js";
import { PERF_MARKS } from "../../../shared/perf/marks.js";
import type { HandlerDependencies } from "../types.js";

function makeInvokeEvent(senderId = 1, senderUrl = "") {
  return {
    sender: {
      id: senderId,
      getURL: vi.fn(() => senderUrl),
    },
  } as unknown as Electron.IpcMainInvokeEvent;
}

async function invokeBoot(
  options: { deps?: HandlerDependencies; senderId?: number; senderUrl?: string } = {}
) {
  ipcHandlers.clear();
  const cleanup = registerAppStateHandlers(options.deps);
  const handler = ipcHandlers.get("app:boot");
  if (!handler) throw new Error("app:boot handler not registered");
  const result = (await handler(makeInvokeEvent(options.senderId, options.senderUrl))) as Record<
    string,
    unknown
  >;
  cleanup();
  return result;
}

describe("app:boot handler", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    // Reset here rather than in a nested afterEach so a test that poisons the
    // legacy globals can never bleed into an unrelated sibling. The `store.get`
    // implementation is reinstated for the same reason: `clearAllMocks` leaves a
    // swapped-in implementation in place, so without this every test after the
    // first swap reads that test's hard-coded app state instead of the ref.
    globalAppStateRef.current = { ...DEFAULT_GLOBAL_APP_STATE };
    legacyOwnerRef.current = undefined;
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation(
      defaultStoreGet as typeof storeModule.store.get
    );
    vi.mocked(storeModule.store.set).mockImplementation(
      defaultStoreSet as typeof storeModule.store.set
    );
    // Same reason: these two are swapped in by individual tests below and would
    // otherwise stay swapped for every test declared after them.
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set());
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([]);
    vi.mocked(projectStore.readInRepoPresets).mockResolvedValue({});
    crashGuard.isSafeMode.mockReturnValue(false);
    crashGuard.getCrashCount.mockReturnValue(0);
    crashService.getPendingCrash.mockReturnValue(null);
    crashService.consumePanelFilter.mockReturnValue(null);
    crashService.getConfig.mockReturnValue({ autoRestoreOnCrash: false });
    crashGuard.getQuarantinedStatePath.mockReturnValue(null);
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue(undefined);
    vi.mocked(getWindowForWebContents).mockReturnValue(null);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue(null);
    vi.mocked(projectStore.getProjectById).mockReturnValue(null);
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: null,
      quarantinedPath: undefined,
    });
    vi.mocked(projectStore.wasStateUnreadableThisSession).mockReturnValue(false);
    vi.mocked(getProjectLayoutSeed).mockReturnValue({ status: "settled", at: 0 });
  });

  it("boots with the effective cached-view count when none is stored, as terminalConfig.get reports it", async () => {
    const { effectiveCachedProjectViews } = await import("../../utils/cachedProjectViews.js");
    const result = (await invokeBoot()) as { terminalConfig: { cachedProjectViews?: number } };
    expect(result.terminalConfig.cachedProjectViews).toBe(effectiveCachedProjectViews(undefined));
  });

  it("attaches a pending crash plus the live crashCount when one exists", async () => {
    crashGuard.getCrashCount.mockReturnValue(3);
    crashService.getPendingCrash.mockReturnValue({
      logPath: "/fake.json",
      entry: {
        id: "c",
        timestamp: 0,
        appVersion: "1",
        platform: "x",
        osVersion: "y",
        arch: "z",
      },
      hasBackup: false,
      panels: [],
    });

    const result = (await invokeBoot()) as { crashPending: { crashCount: number } | null };
    expect(result.crashPending).not.toBeNull();
    expect(result.crashPending?.crashCount).toBe(3);
  });

  it("suppresses crashPending when in safe mode (mirrors crash-recovery:get-pending)", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    crashService.getPendingCrash.mockReturnValue({
      logPath: "/fake.json",
      entry: {
        id: "c",
        timestamp: 0,
        appVersion: "1",
        platform: "x",
        osVersion: "y",
        arch: "z",
      },
      hasBackup: false,
      panels: [],
    });

    const result = (await invokeBoot()) as { crashPending: unknown };
    expect(result.crashPending).toBeNull();
  });

  it("surfaces crashLoopStateRecovery only when in safe mode AND quarantine path is set", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    (crashGuard.getQuarantinedStatePath as any).mockReturnValue(
      "/tmp/crash-loop-state.json.corrupted.42"
    );

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toEqual({
      quarantinedPath: "/tmp/crash-loop-state.json.corrupted.42",
    });
  });

  it("omits crashLoopStateRecovery when not in safe mode (silent corruption is log-only)", async () => {
    crashGuard.isSafeMode.mockReturnValue(false);
    (crashGuard.getQuarantinedStatePath as any).mockReturnValue(
      "/tmp/crash-loop-state.json.corrupted.42"
    );

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toBeNull();
  });

  it("omits crashLoopStateRecovery when in safe mode but no quarantine occurred", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    crashGuard.getQuarantinedStatePath.mockReturnValue(null);

    const result = (await invokeBoot()) as { crashLoopStateRecovery: unknown };
    expect(result.crashLoopStateRecovery).toBeNull();
  });

  it("filters out quarantined panels in safe mode while keeping stable ones", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["panel-bad"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "panel-bad", kind: "terminal", title: "Misbehaving" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "panel-good", kind: "terminal", title: "Good", location: "grid", cwd: "/tmp" },
            { id: "panel-bad", kind: "terminal", title: "Bad", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: Array<{ id: string }>;
    };
    expect(result.appState.terminals.map((t) => t.id)).toEqual(["panel-good"]);
    expect(result.skippedPanelCount).toBe(1);
    expect(result.quarantinedPanels).toEqual([
      expect.objectContaining({ id: "panel-bad", title: "Misbehaving" }),
    ]);
  });

  it("falls back to the all-or-nothing wipe when every saved panel is quarantined", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["a", "b"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "a", kind: "terminal", title: "A" },
      { id: "b", kind: "terminal", title: "B" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: unknown[] };
      skippedPanelCount: number;
    };
    expect(result.appState.terminals).toEqual([]);
    expect(result.skippedPanelCount).toBe(2);
  });

  it("falls back to the all-or-nothing wipe when ledger is empty (legacy path)", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set());
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [{ id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" }],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: unknown[] };
      skippedPanelCount: number;
      quarantinedPanels: unknown[];
    };
    expect(result.appState.terminals).toEqual([]);
    expect(result.skippedPanelCount).toBe(1);
    expect(result.quarantinedPanels).toEqual([]);
  });

  it("preserves panels in safe mode when the quarantine set doesn't match this project", async () => {
    crashGuard.isSafeMode.mockReturnValue(true);
    // Ledger has IDs from a different project — none of the current project's
    // saved panels are quarantined.
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["other-project-bad"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "other-project-bad", kind: "terminal", title: "Other" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "current-a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "current-b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: Array<{ id: string }>;
    };
    expect(result.appState.terminals.map((t) => t.id).sort()).toEqual(["current-a", "current-b"]);
    expect(result.skippedPanelCount).toBe(0);
    // The other project's quarantine is still surfaced for the banner.
    expect(result.quarantinedPanels.map((p) => p.id)).toEqual(["other-project-bad"]);
  });

  describe("agents an unclean end cut short (#14382)", () => {
    const project = { id: "proj-a", name: "A", path: "/projects/a" };
    const HOST_END = { cause: "watchdog-deadlock", at: 5_000, missedBeats: 3 };
    let saved: Record<string, unknown>;
    let events: unknown;

    beforeEach(async () => {
      vi.mocked(projectStore.getCurrentProject).mockReturnValue(
        project as unknown as ReturnType<typeof projectStore.getCurrentProject>
      );
      vi.mocked(projectStore.getProjectById).mockReturnValue(
        project as unknown as ReturnType<typeof projectStore.getProjectById>
      );
      saved = {
        projectId: project.id,
        sidebarWidth: 350,
        terminals: [
          {
            id: "agent",
            kind: "terminal",
            launchAgentId: "claude",
            agentSessionId: "sess-1",
            title: "Claude",
            location: "grid",
            cwd: "/projects/a",
          },
        ],
      };
      // The save lands a tick later, as a queued write does.
      vi.mocked(projectStore.enqueueProjectStateUpdate).mockImplementation(async (_id, updater) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const next = await updater(saved as never);
        if (next) saved = next as unknown as Record<string, unknown>;
      });
      vi.mocked(projectStore.getProjectStateWithRecovery).mockImplementation(async () => ({
        state: structuredClone(saved) as never,
        quarantinedPath: undefined,
      }));
      events = [{ crashId: "c1", ...HOST_END, workspaceIds: [project.id] }];
      const storeModule = await import("../../store.js");
      vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
        key === "hostEndRestoreHolds"
          ? events
          : defaultStoreGet(key)) as typeof storeModule.store.get);
      vi.mocked(storeModule.store.set).mockImplementation(((key: string, value: unknown) => {
        if (key === "hostEndRestoreHolds") events = value;
        else defaultStoreSet(key, value);
      }) as typeof storeModule.store.set);
      vi.mocked(storeModule.store.delete).mockImplementation(((key: string) => {
        if (key === "hostEndRestoreHolds") events = undefined;
      }) as typeof storeModule.store.delete);
    });

    type Hydrated = { appState: { terminals: Array<{ id: string; restoreRecovery?: unknown }> } };

    it("hands them back held, and a pane resumed afterwards stays resumed", async () => {
      const result = (await invokeBoot()) as Hydrated;

      expect(result.appState.terminals[0].restoreRecovery).toEqual({
        reason: "host-ended-uncleanly",
        sessionId: "sess-1",
        hostEnd: HOST_END,
      });
      expect((saved.terminals as Array<{ restoreRecovery?: unknown }>)[0].restoreRecovery).toEqual(
        result.appState.terminals[0].restoreRecovery
      );
      expect(events).toBeUndefined();

      // The user resumes it; the next restore leaves it to resume as usual.
      (saved.terminals as Array<Record<string, unknown>>)[0].restoreRecovery = undefined;
      const next = (await invokeBoot()) as Hydrated;
      expect(next.appState.terminals[0].restoreRecovery).toBeUndefined();
    });

    it("still hands them back held when saving the hold fails, and stays due", async () => {
      vi.mocked(projectStore.enqueueProjectStateUpdate).mockRejectedValueOnce(new Error("disk"));

      const result = (await invokeBoot()) as Hydrated;

      expect(result.appState.terminals[0].restoreRecovery).toMatchObject({
        reason: "host-ended-uncleanly",
        hostEnd: HOST_END,
      });
      expect(events).toEqual([expect.objectContaining({ workspaceIds: [project.id] })]);
    });

    it("saves held the legacy terminals a first open migrates", async () => {
      legacyOwnerRef.current = project.id;
      globalAppStateRef.current = {
        ...globalAppStateRef.current,
        terminals: (saved.terminals as unknown[]).map((t) => ({ ...(t as object) })),
      };
      saved = {};
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });

      await invokeBoot();

      expect(
        (saved.terminals as Array<{ restoreRecovery?: unknown }>)[0].restoreRecovery
      ).toMatchObject({
        reason: "host-ended-uncleanly",
      });
    });

    it("never serves a cached payload built before the hold", async () => {
      legacyOwnerRef.current = project.id;
      vi.mocked(consumePrefetchedHydrateResult).mockReturnValue({
        appState: { terminals: [{ id: "agent" }] },
      } as never);

      const result = (await invokeBoot()) as Hydrated;

      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
      expect(result.appState.terminals[0].restoreRecovery).toBeDefined();
    });
  });

  it("does not consult the ledger filter outside of safe mode", async () => {
    crashGuard.isSafeMode.mockReturnValue(false);
    panelSuspectLedger.getQuarantinedPanelIds.mockReturnValue(new Set(["a"]));
    panelSuspectLedger.getQuarantinedPanels.mockReturnValue([
      { id: "a", kind: "terminal", title: "A" },
    ]);
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") {
        return {
          terminals: [
            { id: "a", kind: "terminal", title: "A", location: "grid", cwd: "/tmp" },
            { id: "b", kind: "terminal", title: "B", location: "grid", cwd: "/tmp" },
          ],
          sidebarWidth: 350,
        };
      }
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    });

    const result = (await invokeBoot()) as {
      appState: { terminals: Array<{ id: string }> };
      skippedPanelCount: number;
      quarantinedPanels: unknown[];
    };
    expect(result.appState.terminals.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(result.skippedPanelCount).toBe(0);
    expect(result.quarantinedPanels).toEqual([]);
  });

  it("propagates the cache-hit fast path from handleAppHydrate (no disk read)", async () => {
    const cachedResult = {
      // Nothing the slow path would build, so only the cache can supply it.
      appState: { terminals: [], sidebarWidth: 777 },
      terminalConfig: {
        scrollbackLines: 3000,
        performanceMode: false,
        resourceMonitoringEnabled: true,
      },
      project: null,
      agentSettings: { agents: {} },
      gpuWebGLHardware: true,
      gpuHardwareAccelerationDisabled: false,
      gpuDisabledReason: null,
      gpuAngleFallbackActive: false,
      safeMode: false,
      isWindowsStore: false,
    };
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue(
      cachedResult as ReturnType<typeof consumePrefetchedHydrateResult>
    );
    // Force the cache path by giving handleAppHydrate a current project and an
    // already-claimed legacy record — the cache is only eligible once the
    // record has an owner, since the read-only builder can't claim one (#11651).
    const projectStoreModule = await import("../../services/ProjectStore.js");
    vi.mocked(projectStoreModule.projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStoreModule.projectStore.getCurrentProject>);
    legacyOwnerRef.current = "p1";
    // Saved since the hover.
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) =>
      key === "terminalConfig"
        ? { scrollbackLines: 2500, performanceMode: true, resourceMonitoringEnabled: false }
        : defaultStoreGet(key)
    );

    const result = (await invokeBoot()) as Record<string, unknown>;
    expect(result.appState).toEqual(cachedResult.appState);
    expect(projectStoreModule.projectStore.getProjectStateWithRecovery).not.toHaveBeenCalled();
    // The saved values, not the prefetch's copy (#14699).
    expect(result.terminalConfig).toMatchObject({
      scrollbackLines: 2500,
      performanceMode: true,
      resourceMonitoringEnabled: false,
    });
    expect(result.crashPending).toBeNull();
    expect(result.crashConfig).toEqual({ autoRestoreOnCrash: false });
  });

  it("answers the grid and agent settings saved since the hover on the cache-hit path", async () => {
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue({
      appState: { terminals: [], panelGridConfig: { strategy: "automatic", value: 3 } },
      terminalConfig: { scrollbackLines: 3000, performanceMode: false },
      project: null,
      agentSettings: { agents: {}, globalSkipPermissions: false },
      agentDefaults: { defaultAgent: "claude" },
    } as unknown as ReturnType<typeof consumePrefetchedHydrateResult>);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    legacyOwnerRef.current = "p1";
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) => {
      if (key === "appState.panelGridConfig") return { strategy: "fixed-rows", value: 2 };
      if (key === "agentSettings") {
        return { agents: {}, globalSkipPermissions: true, defaultAgent: "codex" };
      }
      return defaultStoreGet(key);
    }) as typeof storeModule.store.get);

    const result = (await invokeBoot()) as {
      appState: Record<string, unknown>;
      agentSettings: Record<string, unknown>;
      agentDefaults: Record<string, unknown>;
    };

    expect(consumePrefetchedHydrateResult).toHaveBeenCalledWith("p1");
    expect(result.appState.panelGridConfig).toEqual({ strategy: "fixed-rows", value: 2 });
    expect(result.agentSettings).toMatchObject({ globalSkipPermissions: true });
    expect(result.agentDefaults).toEqual({ defaultAgent: "codex" });
  });

  it("surfaces the boot-time database recovery on the slow path", async () => {
    const recovery = { kind: "reset-to-fresh", quarantinedPath: "/u/daintree.db.corrupt-x" };
    consumeDatabaseRecovery.mockReturnValueOnce(recovery);

    const result = (await invokeBoot()) as Record<string, unknown>;

    expect(result.databaseRecovery).toEqual(recovery);
    expect(consumeDatabaseRecovery).toHaveBeenCalledTimes(1);
    expect(restoreDatabaseRecovery).not.toHaveBeenCalled();
  });

  it("hands the database recovery back when a pending crash will discard this payload", async () => {
    // useAppBootstrap throws the boot payload away and re-runs app:hydrate once
    // the crash gate resolves. An unclean exit is also exactly how the DB gets
    // corrupted, so consuming the one-shot here would lose the notification in
    // the very scenario it exists for.
    const recovery = { kind: "restored-from-backup", quarantinedPath: "/u/daintree.db.corrupt-x" };
    consumeDatabaseRecovery.mockReturnValueOnce(recovery);
    crashService.getPendingCrash.mockReturnValue({ terminals: [], timestamp: 1 });

    const result = (await invokeBoot()) as Record<string, unknown>;

    expect(result.crashPending).not.toBeNull();
    expect(result.databaseRecovery).toBeNull();
    expect(restoreDatabaseRecovery).toHaveBeenCalledWith(recovery);
  });

  it("surfaces the boot-time database recovery even on the prefetch cache-hit path", async () => {
    // The prefetch snapshot predates the boot probe and carries no recovery, so
    // the live one-shot consumer has to run on this path too or the user is
    // never told their database was rebuilt.
    const recovery = { kind: "restored-from-backup", quarantinedPath: "/u/daintree.db.corrupt-x" };
    consumeDatabaseRecovery.mockReturnValueOnce(recovery);
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue({
      appState: { terminals: [], sidebarWidth: 350 },
      terminalConfig: { scrollbackLines: 3000 },
      project: null,
      databaseRecovery: null,
    } as unknown as ReturnType<typeof consumePrefetchedHydrateResult>);
    const projectStoreModule = await import("../../services/ProjectStore.js");
    vi.mocked(projectStoreModule.projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStoreModule.projectStore.getCurrentProject>);
    // The cache is only eligible once the legacy record has an owner — without
    // this the hydrate silently takes the slow path and stops testing the
    // cache-hit path this case is named for (#11651).
    legacyOwnerRef.current = "p1";

    const result = (await invokeBoot()) as Record<string, unknown>;

    expect(result.databaseRecovery).toEqual(recovery);
    expect(consumePrefetchedHydrateResult).toHaveBeenCalledWith("p1");
  });

  it("waits for the GPU report, then answers the GPU half fresh even on the prefetch cache-hit path", async () => {
    // A cold-start prefetch can run before the GPU process reports, when the
    // feature status is still the provisional all-disabled one.
    const gpu = await import("../../utils/gpuDetection.js");
    vi.mocked(consumePrefetchedHydrateResult).mockReturnValue({
      appState: { terminals: [], sidebarWidth: 350 },
      terminalConfig: { scrollbackLines: 3000 },
      project: null,
      gpuWebGLHardware: false,
    } as unknown as ReturnType<typeof consumePrefetchedHydrateResult>);
    const projectStoreModule = await import("../../services/ProjectStore.js");
    vi.mocked(projectStoreModule.projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStoreModule.projectStore.getCurrentProject>);
    legacyOwnerRef.current = "p1";
    vi.mocked(gpu.isWebGLHardwareAccelerated).mockReturnValue(true);

    const result = (await invokeBoot()) as Record<string, unknown>;

    expect(gpu.whenGpuReported).toHaveBeenCalledWith(1_500);
    expect(consumePrefetchedHydrateResult).toHaveBeenCalledWith("p1");
    expect(result.gpuWebGLHardware).toBe(true);
  });

  it("hydrates the project bound to the sending project view instead of the stale global current project", async () => {
    const boundProject = {
      id: "proj-bound",
      name: "Bound Project",
      path: "/projects/bound",
    };
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockImplementation((projectId) =>
      projectId === boundProject.id
        ? (boundProject as unknown as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: {
        projectId: boundProject.id,
        sidebarWidth: 350,
        terminals: [],
      },
      quarantinedPath: undefined,
    });

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(boundProject.id),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: {
        getProjectIdForWebContents: vi.fn().mockReturnValue("proj-other"),
      },
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({ deps, senderId: 42 });

    expect(result.project).toEqual(boundProject);
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(42);
    expect(projectStore.getProjectStateWithRecovery).toHaveBeenCalledWith(boundProject.id);
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("does not inherit the global current project for an unbound project view", async () => {
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({ deps, senderId: 42 });

    expect(result.project).toBeNull();
    expect(projectStore.getProjectStateWithRecovery).not.toHaveBeenCalled();
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("never ships the legacy workspace state to an unresolvable sender", async () => {
    // A sender the PVM cannot bind owns no workspace, so it owns none of the
    // legacy focus/worktree/MRU state either — it must boot pristine rather
    // than adopting whatever project last wrote the global record (#11497).
    globalAppStateRef.current = {
      ...DEFAULT_GLOBAL_APP_STATE,
      ...LEGACY_WORKSPACE_STATE,
      panelGridConfig: GLOBAL_PANEL_GRID_CONFIG,
    };
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);

    const pvm = { getProjectIdForWebContents: vi.fn().mockReturnValue(null) };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({ services: { projectViewManager: pvm } }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({ deps, senderId: 42 });
    const appState = result.appState as Record<string, unknown>;

    expect(result.project).toBeNull();
    expect(result.workspaceId).toBeNull();
    expect(appState.focusMode).toBe(false);
    expect(appState.focusPanelState).toBeUndefined();
    expect(appState.activeWorktreeId).toBeUndefined();
    expect(appState.mruList).toBeUndefined();
    // Genuinely app-global settings still ride along — this fix narrows the
    // four workspace-owned fields only, it does not stop sharing preferences.
    expect(appState.panelGridConfig).toEqual(GLOBAL_PANEL_GRID_CONFIG);
  });

  describe("legacy workspace state migration for real projects (#11497)", () => {
    const REAL_PROJECT = {
      id: "proj-real",
      name: "Real Project",
      path: "/projects/real",
    };

    function realProjectDeps() {
      vi.mocked(getWindowForWebContents).mockReturnValue({
        id: 7,
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow);
      vi.mocked(projectStore.getProjectById).mockImplementation((projectId) =>
        projectId === REAL_PROJECT.id
          ? (REAL_PROJECT as unknown as ReturnType<typeof projectStore.getProjectById>)
          : null
      );
      const pvm = { getProjectIdForWebContents: vi.fn().mockReturnValue(REAL_PROJECT.id) };
      return {
        windowRegistry: {
          getByWindowId: vi.fn().mockReturnValue({ services: { projectViewManager: pvm } }),
        },
        projectViewManager: pvm,
      } as unknown as HandlerDependencies;
    }

    /**
     * Run the updater the handler enqueued against `existing` and return the
     * record it computes. Asserting on that record rather than on
     * `expect.any(Function)` is what makes these tests bite: an updater that
     * returned `existing` unchanged, or wrote the wrong focus state, would
     * satisfy a callable-shaped assertion.
     *
     * Types are derived from `enqueueProjectStateUpdate` rather than asserted:
     * the real updater may return a promise, so a hand-written synchronous
     * signature here is a lie that only the composite `tsc` build catches.
     */
    type EnqueuedUpdater = Parameters<typeof projectStore.enqueueProjectStateUpdate>[1];

    async function runEnqueuedUpdate(
      existing: Parameters<EnqueuedUpdater>[0] = null
    ): Promise<Awaited<ReturnType<EnqueuedUpdater>>> {
      const calls = vi.mocked(projectStore.enqueueProjectStateUpdate).mock.calls;
      // Exactly one write, keyed to this workspace — a second enqueue or a
      // write against another id is itself the bug these tests guard against.
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(REAL_PROJECT.id);
      return await calls[0][1](existing);
    }

    // Both unmigrated branches persist the legacy focus/worktree values to
    // per-project state but never assign the payload locals, so the payload
    // depends entirely on the initial seed. Gating that seed on anything
    // narrower than "the workspace that owns the legacy record" would silently
    // drop the user's worktree on the very boot that was supposed to carry it
    // forward. (The MRU is not part of these updaters — it stays on the legacy
    // global until the renderer next writes it — so only the payload half is
    // asserted for `mruList`.) The record starts unclaimed here, so this is
    // also the case that proves the first real project becomes its heir.
    it.each([
      [
        "with legacy terminals to migrate",
        [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
      ],
      ["with no legacy terminals", []],
    ])("still migrates the legacy workspace state %s", async (_label, legacyTerminals) => {
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
        terminals: legacyTerminals,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });

      const storeModule = await import("../../store.js");
      const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      expect(result.workspaceId).toBe(REAL_PROJECT.id);
      expect(appState.focusMode).toBe(LEGACY_WORKSPACE_STATE.focusMode);
      expect(appState.focusPanelState).toEqual(LEGACY_WORKSPACE_STATE.focusPanelState);
      expect(appState.activeWorktreeId).toBe(LEGACY_WORKSPACE_STATE.activeWorktreeId);
      expect(appState.mruList).toEqual(LEGACY_WORKSPACE_STATE.mruList);
      // Claiming the record is what locks every later project row out of it.
      // Without this write the next brand-new project reads the same unclaimed
      // record and inherits the same panels all over again (#11651).
      expect(storeModule.store.set).toHaveBeenCalledWith(
        "legacyWorkspaceStateOwnerId",
        REAL_PROJECT.id
      );
      // The same values must land in the per-project record, or the next boot
      // reads an empty one and the migration is lost.
      const migrated = (await runEnqueuedUpdate())!;
      expect(migrated.projectId).toBe(REAL_PROJECT.id);
      expect(migrated.activeWorktreeId).toBe(LEGACY_WORKSPACE_STATE.activeWorktreeId);
      expect(migrated.focusMode).toBe(LEGACY_WORKSPACE_STATE.focusMode);
      expect(migrated.focusPanelState).toEqual(LEGACY_WORKSPACE_STATE.focusPanelState);
    });

    it("migrates the legacy focus mode into a real project that has panels but no saved focus mode", async () => {
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: {
          projectId: REAL_PROJECT.id,
          sidebarWidth: 350,
          terminals: [],
        },
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

      const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      expect(appState.focusMode).toBe(LEGACY_WORKSPACE_STATE.focusMode);
      expect(appState.focusPanelState).toEqual(LEGACY_WORKSPACE_STATE.focusPanelState);
      // The saved record has no worktree or MRU of its own, so this branch must
      // still hand the real project the legacy ones.
      expect(appState.activeWorktreeId).toBe(LEGACY_WORKSPACE_STATE.activeWorktreeId);
      expect(appState.mruList).toEqual(LEGACY_WORKSPACE_STATE.mruList);
      // The migrate-once write must carry the focus state onto the existing
      // record without discarding what that record already holds.
      const migrated = (await runEnqueuedUpdate({
        projectId: REAL_PROJECT.id,
        sidebarWidth: 350,
        terminals: [],
      }))!;
      expect(migrated.focusMode).toBe(LEGACY_WORKSPACE_STATE.focusMode);
      expect(migrated.focusPanelState).toEqual(LEGACY_WORKSPACE_STATE.focusPanelState);
      expect(migrated.terminals).toEqual([]);
    });

    it("keeps an explicitly empty per-project MRU instead of falling back to the legacy list", async () => {
      // `[]` means "this project's MRU is genuinely empty", which is a different
      // statement from `undefined` ("never migrated"). Collapsing the two would
      // resurrect the legacy list every boot.
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: {
          projectId: REAL_PROJECT.id,
          sidebarWidth: 350,
          terminals: [],
          mruList: [],
        },
        quarantinedPath: undefined,
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

      const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });

      expect((result.appState as Record<string, unknown>).mruList).toEqual([]);
    });

    // The legacy record has exactly one heir. Nothing used to consume it, so
    // every project row that had not saved terminals yet re-read the same list
    // and was seeded with another project's panels — `cwd` and `worktreeId`
    // included — before the renderer finished restoring (#11651).
    describe("a project row that never owned the legacy record (#11651)", () => {
      const OTHER_OWNER = "proj-first-heir";
      const LEGACY_TERMINALS = [
        { id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/projects/first-heir" },
      ];

      beforeEach(() => {
        legacyOwnerRef.current = OTHER_OWNER;
        globalAppStateRef.current = {
          ...DEFAULT_GLOBAL_APP_STATE,
          ...LEGACY_WORKSPACE_STATE,
          panelGridConfig: GLOBAL_PANEL_GRID_CONFIG,
          terminals: LEGACY_TERMINALS,
        };
      });

      it("inherits none of it and writes a clean per-project record", async () => {
        vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
          state: null,
          quarantinedPath: undefined,
        });

        const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
        const appState = result.appState as Record<string, unknown>;

        // Above all not the foreign panel — its `cwd` points at the heir's
        // directory — and not the heir's quick-switcher history either.
        expect(appState.terminals).toEqual([]);
        expect(appState.mruList).toBeUndefined();
        // Genuinely app-global settings are untouched by the ownership gate.
        expect(appState.panelGridConfig).toEqual(GLOBAL_PANEL_GRID_CONFIG);

        // The disk write is the half that outlives the boot: a payload-only fix
        // would still leave the foreign worktree persisted for the next launch.
        // The payload keeps serving the live globals (see the note in the
        // handler), but nothing this workspace never owned reaches its record.
        const written = (await runEnqueuedUpdate())!;
        expect(written.projectId).toBe(REAL_PROJECT.id);
        expect(written.terminals).toEqual([]);
        expect(written.activeWorktreeId).toBeUndefined();
        expect(written.focusMode).toBeUndefined();
        expect(written.focusPanelState).toBeUndefined();
      });

      it("leaves the existing claim alone instead of stealing the record", async () => {
        vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
          state: null,
          quarantinedPath: undefined,
        });
        const storeModule = await import("../../store.js");

        await invokeBoot({ deps: realProjectDeps(), senderId: 42 });

        // Re-stamping would hand the record to whichever project booted last,
        // which is the same "no owner identity" hole in a different shape.
        // Filter by key rather than using `expect.anything()`, which does not
        // match a `set(key, undefined)` — the exact shape a botched claim takes.
        // Read through an untyped view for the same reason as the app:set-state
        // tests below: vi.mocked resolves the single-argument set(object)
        // overload, so `call[0]` types as the whole schema.
        const setCalls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
        expect(setCalls.filter((call) => call[0] === "legacyWorkspaceStateOwnerId")).toEqual([]);
        // The record must still be read — an implementation that ignored the
        // owner entirely would also write nothing and pass the assertion above.
        expect(storeModule.store.get).toHaveBeenCalledWith("legacyWorkspaceStateOwnerId");
        expect(legacyOwnerRef.current).toBe(OTHER_OWNER);
      });

      it("keeps its own saved panels when crash recovery restores the heir's list", async () => {
        // The filter ids come from the crash snapshot, which captures only the
        // global record — so they name the OWNER's panels, never this project's.
        // Ungated, the global list outranked the saved per-project one and this
        // project booted holding the owner's panel; scoping the filter to the
        // list it actually describes leaves this project's own panels alone.
        crashService.consumePanelFilter.mockReturnValue(["legacy-panel"] as unknown as null);
        vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
          state: {
            projectId: REAL_PROJECT.id,
            sidebarWidth: 350,
            terminals: [
              { id: "own-panel", title: "Own", location: "grid", cwd: REAL_PROJECT.path },
            ],
          },
        } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

        const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
        const terminals = (result.appState as Record<string, unknown>).terminals as Array<
          Record<string, unknown>
        >;

        expect(terminals.map((t) => t.id)).toEqual(["own-panel"]);
        expect(terminals.map((t) => t.cwd)).toEqual([REAL_PROJECT.path]);
      });
    });

    it("claims once and keeps migrating for the heir across repeated hydrates", async () => {
      // `app:boot` runs the migration, but the renderer drops that payload when
      // a crash is pending and hydrates again. Claiming is a stamp, not a
      // destructive consume, so the second pass must find the record it already
      // owns and migrate again — without re-stamping.
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
        terminals: [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });
      const storeModule = await import("../../store.js");
      // Untyped view: vi.mocked resolves the single-argument set(object)
      // overload, so the (key, value) form needs reading through `unknown[][]`.
      const ownerWriteCount = () =>
        (vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][]).filter(
          (call) => call[0] === "legacyWorkspaceStateOwnerId"
        ).length;

      // First hydrate: the record is unclaimed, so this project becomes the heir.
      await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
      expect(legacyOwnerRef.current).toBe(REAL_PROJECT.id);
      expect(ownerWriteCount()).toBe(1);

      // Second hydrate reads back the claim the first one persisted.
      vi.mocked(projectStore.enqueueProjectStateUpdate).mockClear();
      const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      expect((appState.terminals as Array<Record<string, unknown>>).map((t) => t.id)).toEqual([
        "legacy-panel",
      ]);
      const migrated = (await runEnqueuedUpdate())!;
      expect(migrated.terminals.map((t) => t.id)).toEqual(["legacy-panel"]);
      // Still exactly one claim — the second pass recognised itself as the heir
      // instead of stamping the record again.
      expect(ownerWriteCount()).toBe(1);
    });

    it("does not let a scratch claim the record out from under the first real project", async () => {
      // A scratch has a workspaceId but no Project row. Stamping the scratch's
      // id would lock every real project out of a record none of them ever had
      // a chance to inherit.
      const SCRATCH_WORKSPACE_ID = "b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e";
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
        terminals: [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });
      vi.mocked(getWindowForWebContents).mockReturnValue({
        id: 7,
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow);
      vi.mocked(projectStore.getProjectById).mockReturnValue(null);
      const scratchPvm = {
        getProjectIdForWebContents: vi.fn().mockReturnValue(SCRATCH_WORKSPACE_ID),
      };
      const scratchDeps = {
        windowRegistry: {
          getByWindowId: vi.fn().mockReturnValue({
            services: { projectViewManager: scratchPvm },
          }),
        },
        projectViewManager: scratchPvm,
      } as unknown as HandlerDependencies;

      await invokeBoot({ deps: scratchDeps, senderId: 42 });
      expect(legacyOwnerRef.current).toBeUndefined();

      // The record must still be there for the first real project — asserting
      // only "the scratch wrote nothing" would also hold for an implementation
      // that never wrote an owner at all.
      const result = await invokeBoot({ deps: realProjectDeps(), senderId: 42 });
      expect(legacyOwnerRef.current).toBe(REAL_PROJECT.id);
      expect(
        (
          (result.appState as Record<string, unknown>).terminals as Array<Record<string, unknown>>
        ).map((t) => t.id)
      ).toEqual(["legacy-panel"]);
    });

    it("holds the crash panel filter for its owner instead of eating it", async () => {
      // The filter is a one-shot keyed to the owner's panels. A non-owner that
      // consumed it would leave the owner's next hydrate with nothing to filter
      // by, silently restoring the panels the user had just deselected.
      legacyOwnerRef.current = "proj-first-heir";
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        terminals: [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
      };
      crashService.consumePanelFilter.mockReturnValue(["legacy-panel"] as unknown as null);
      crashService.hasPendingPanelFilter.mockReturnValueOnce(true);
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: {
          projectId: REAL_PROJECT.id,
          sidebarWidth: 350,
          terminals: [{ id: "own-panel", title: "Own", location: "grid", cwd: REAL_PROJECT.path }],
        },
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

      await invokeBoot({ deps: realProjectDeps(), senderId: 42 });

      expect(crashService.consumePanelFilter).not.toHaveBeenCalled();
    });

    it("keeps a cached payload out of play until the record has an owner", async () => {
      // `buildSwitchHydrateResult` writes nothing, so it can neither claim the
      // record nor migrate. Serving its cached payload before the first claim
      // would let the rightful heir boot without claiming, leaving the record
      // for the next brand-new project to take instead.
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
        terminals: [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });

      await invokeBoot({ deps: realProjectDeps(), senderId: 42 });

      // The cache is return-and-delete, so probing it at all would consume an
      // entry the migration path still needs.
      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
      expect(legacyOwnerRef.current).toBe(REAL_PROJECT.id);
    });
  });

  describe("scratch views (#11484)", () => {
    const SCRATCH_ID = "b3d1f2a4-5c6e-4a8b-9d0f-1e2a3b4c5d6e";

    function scratchDeps() {
      vi.mocked(getWindowForWebContents).mockReturnValue({
        id: 7,
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow);
      const pvm = { getProjectIdForWebContents: vi.fn().mockReturnValue(SCRATCH_ID) };
      return {
        windowRegistry: {
          getByWindowId: vi.fn().mockReturnValue({ services: { projectViewManager: pvm } }),
        },
        projectViewManager: pvm,
      } as unknown as HandlerDependencies;
    }

    it("restores the persisted grid for a workspace that has no Project row", async () => {
      const savedPanel = {
        id: "panel-1",
        title: "Agent",
        location: "grid",
        cwd: "/scratches/one",
        kind: "terminal",
      };
      // Poisoned globals that differ from every saved value below, so the
      // assertions prove the scratch's own state wins rather than coinciding
      // with the legacy record.
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: {
          projectId: SCRATCH_ID,
          sidebarWidth: 350,
          terminals: [savedPanel],
          activeWorktreeId: "wt-scratch",
          focusMode: false,
          focusPanelState: { sidebarWidth: 400, diagnosticsOpen: false },
          mruList: ["terminal:panel-1"],
        },
        quarantinedPath: undefined,
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

      const result = await invokeBoot({ deps: scratchDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      // No Project row exists, yet the state directory is still read and its
      // panels returned — this is the whole fix.
      expect(result.project).toBeNull();
      expect(result.workspaceId).toBe(SCRATCH_ID);
      expect(projectStore.getProjectStateWithRecovery).toHaveBeenCalledWith(SCRATCH_ID);
      expect(appState.terminals as unknown[]).toHaveLength(1);
      expect((appState.terminals as Array<{ id: string }>)[0].id).toBe(savedPanel.id);
      // The scratch's own saved workspace state wins over the legacy globals.
      expect(appState.activeWorktreeId).toBe("wt-scratch");
      expect(appState.focusMode).toBe(false);
      expect(appState.focusPanelState).toEqual({ sidebarWidth: 400, diagnosticsOpen: false });
      expect(appState.mruList).toEqual(["terminal:panel-1"]);
    });

    it("never inherits the legacy global terminals or workspace state", async () => {
      // The global record predates per-workspace state and belongs to whichever
      // project was open back then. Migrating it into a scratch would hand a
      // brand-new workspace someone else's panels, worktree and MRU history.
      globalAppStateRef.current = {
        sidebarWidth: 350,
        terminals: [{ id: "legacy-panel", title: "Legacy", location: "grid", cwd: "/old/project" }],
        ...LEGACY_WORKSPACE_STATE,
        panelGridConfig: GLOBAL_PANEL_GRID_CONFIG,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: undefined,
      });

      const result = await invokeBoot({ deps: scratchDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      expect(result.workspaceId).toBe(SCRATCH_ID);
      expect(appState.terminals).toEqual([]);
      expect(appState.focusMode).toBe(false);
      expect(appState.focusPanelState).toBeUndefined();
      expect(appState.activeWorktreeId).toBeUndefined();
      expect(appState.mruList).toBeUndefined();
      // App-global preferences are still shared with every workspace.
      expect(appState.panelGridConfig).toEqual(GLOBAL_PANEL_GRID_CONFIG);
      expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
    });

    it("neither adopts nor persists the legacy focus mode once the scratch has saved panels", async () => {
      // A scratch that has saved panels but no saved focus mode reaches the
      // focus-mode migration branch, which used to copy the legacy global focus
      // state in AND write it to the scratch's own record (#11497).
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        ...LEGACY_WORKSPACE_STATE,
      };
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: {
          projectId: SCRATCH_ID,
          sidebarWidth: 350,
          terminals: [],
        },
        quarantinedPath: undefined,
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);

      const result = await invokeBoot({ deps: scratchDeps(), senderId: 42 });
      const appState = result.appState as Record<string, unknown>;

      expect(appState.focusMode).toBe(false);
      expect(appState.focusPanelState).toBeUndefined();
      expect(appState.activeWorktreeId).toBeUndefined();
      expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
    });
  });

  it("hydrates the URL project while a project view binding is still pending", async () => {
    const urlProject = {
      id: "proj-url",
      name: "URL Project",
      path: "/projects/url",
    };
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockImplementation((projectId) =>
      projectId === urlProject.id
        ? (urlProject as unknown as ReturnType<typeof projectStore.getProjectById>)
        : null
    );
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: {
        projectId: urlProject.id,
        sidebarWidth: 350,
        terminals: [],
      },
      quarantinedPath: undefined,
    });

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({
      deps,
      senderId: 42,
      senderUrl: "app://daintree/index.html?projectId=proj-url",
    });

    expect(result.project).toEqual(urlProject);
    expect(pvm.getProjectIdForWebContents).toHaveBeenCalledWith(42);
    expect(projectStore.getProjectStateWithRecovery).toHaveBeenCalledWith(urlProject.id);
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });

  it("folds tabGroups/terminalSizes/draftInputs from the project state into the payload", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    const tabGroups = [
      { id: "g1", location: "grid" as const, activeTabId: "t1", panelIds: ["t1", "t2"] },
    ];
    const terminalSizes = { t1: { cols: 80, rows: 24 } };
    const draftInputs = { t1: "half-typed prompt" };
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
      state: {
        projectId: "p1",
        sidebarWidth: 350,
        terminals: [],
        tabGroups,
        terminalSizes,
        draftInputs,
      },
      quarantinedPath: undefined,
    });

    const result = await invokeBoot();
    expect(result.tabGroups).toEqual(tabGroups);
    expect(result.terminalSizes).toEqual(terminalSizes);
    expect(result.draftInputs).toEqual(draftInputs);
  });

  it("defaults tabGroups/terminalSizes/draftInputs to empty when the project state is null", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);

    const result = await invokeBoot();
    // Matches the standalone getTabGroups/getTerminalSizes/getDraftInputs
    // handlers' null-state returns.
    expect(result.tabGroups).toEqual([]);
    expect(result.terminalSizes).toEqual({});
    expect(result.draftInputs).toEqual({});
  });

  it("leaves tabGroups/terminalSizes/draftInputs undefined on the no-project fallback branch", async () => {
    const result = await invokeBoot();
    expect(result.tabGroups).toBeUndefined();
    expect(result.terminalSizes).toBeUndefined();
    expect(result.draftInputs).toBeUndefined();
  });

  it("folds in-repo project presets into the payload when a project is resolved", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    const presets = { claude: [{ id: "team-preset", name: "Team" }] };
    vi.mocked(projectStore.readInRepoPresets).mockResolvedValue(
      presets as unknown as Awaited<ReturnType<typeof projectStore.readInRepoPresets>>
    );

    const result = await invokeBoot();
    expect(projectStore.readInRepoPresets).toHaveBeenCalledWith("/p");
    expect(result.projectPresets).toEqual(presets);
  });

  it("degrades projectPresets to empty when the in-repo read fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "p1",
      name: "P",
      path: "/p",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.readInRepoPresets).mockRejectedValueOnce(new Error("EACCES"));

    const result = await invokeBoot();
    expect(result.projectPresets).toEqual({});
    warnSpy.mockRestore();
  });

  it("leaves projectPresets undefined on the no-project fallback branch", async () => {
    const result = await invokeBoot();
    expect(projectStore.readInRepoPresets).not.toHaveBeenCalled();
    expect(result.projectPresets).toBeUndefined();
  });

  it("folds a fully-migrated appTheme config into the boot payload", async () => {
    const appTheme = {
      colorSchemeId: "daintree",
      customSchemes: [{ id: "custom-1", name: "Custom", type: "dark", tokens: {} }],
      accentColorOverride: "#ff0000",
      colorVisionMode: "red-green",
    };
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
      if (key === "appState") return { terminals: [], sidebarWidth: 350 };
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      if (key === "appTheme") return appTheme;
      return undefined;
    });

    const result = await invokeBoot();
    expect(result.appTheme).toEqual(appTheme);
  });

  it("leaves appTheme off the payload when the stored config still needs migration or defaulting", async () => {
    const storeModule = await import("../../store.js");
    for (const stored of [
      undefined,
      {},
      { colorSchemeId: "" },
      { colorSchemeId: "daintree", customSchemes: '[{"id":"legacy"}]' },
    ]) {
      vi.mocked(storeModule.store.get).mockImplementation((key: string) => {
        if (key === "appState") return { terminals: [], sidebarWidth: 350 };
        if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
        if (key === "agentSettings") return {};
        if (key === "appTheme") return stored;
        return undefined;
      });

      const result = await invokeBoot();
      expect(result.appTheme).toBeUndefined();
    }
  });

  describe("APP_HYDRATE_PREFETCH perf mark", () => {
    const prefetchMarkCalls = () =>
      vi
        .mocked(markPerformance)
        .mock.calls.filter(([mark]) => mark === PERF_MARKS.APP_HYDRATE_PREFETCH);

    const setCurrentProject = () => {
      vi.mocked(projectStore.getCurrentProject).mockReturnValue({
        id: "p1",
        name: "P",
        path: "/p",
      } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
      // Steady state for every install past its first boot: the legacy record
      // has an owner, so the cache is eligible. An unclaimed record makes it
      // ineligible on purpose — covered separately (#11651).
      legacyOwnerRef.current = "p1";
    };

    it("emits exactly one hit mark when the prefetch cache services the hydrate", async () => {
      setCurrentProject();
      vi.mocked(consumePrefetchedHydrateResult).mockReturnValue({
        appState: { terminals: [], sidebarWidth: 350 },
        terminalConfig: { resourceMonitoringEnabled: false },
        project: null,
        agentSettings: {},
        gpuWebGLHardware: true,
        gpuHardwareAccelerationDisabled: false,
        gpuAngleFallbackActive: false,
        safeMode: false,
        isWindowsStore: false,
      } as unknown as ReturnType<typeof consumePrefetchedHydrateResult>);

      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({ hit: true, projectId: "p1", reason: "hit" });
      // The fast path must not pay the full config.json parse — the cached
      // HydrateResult already carries appState.
      const storeModule = await import("../../store.js");
      expect(storeModule.store.get).not.toHaveBeenCalledWith("appState");
    });

    it("emits a miss mark when the cache is eligible but empty", async () => {
      setCurrentProject();

      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({ hit: false, projectId: "p1", reason: "miss" });
      expect(consumePrefetchedHydrateResult).toHaveBeenCalledWith("p1");
    });

    it("emits a no-project mark without probing the cache", async () => {
      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({ hit: false, projectId: null, reason: "no-project" });
      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
    });

    it("emits a safe-mode mark without probing (consume would destroy the entry)", async () => {
      setCurrentProject();
      crashGuard.isSafeMode.mockReturnValue(true);

      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({ hit: false, projectId: "p1", reason: "safe-mode" });
      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
    });

    it("emits a panel-filter mark without probing when crash recovery set a filter", async () => {
      setCurrentProject();
      crashService.consumePanelFilter.mockReturnValue(["panel-x"] as unknown as null);

      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toEqual({ hit: false, projectId: "p1", reason: "panel-filter" });
      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
    });

    it("skips the cache for a project whose first-open layout seed is undecided", async () => {
      // The prefetch skips the state read the seed is decided from (#13782).
      setCurrentProject();
      vi.mocked(getProjectLayoutSeed).mockReturnValue(null);

      await invokeBoot();

      const calls = prefetchMarkCalls();
      expect(calls[0]![1]).toEqual({
        hit: false,
        projectId: "p1",
        reason: "layout-seed-undecided",
      });
      expect(consumePrefetchedHydrateResult).not.toHaveBeenCalled();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", true);
    });

    it("still uses the cache when the seed record can't be read", async () => {
      setCurrentProject();
      vi.mocked(getProjectLayoutSeed).mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await invokeBoot();

      expect(prefetchMarkCalls()[0]![1]).toEqual({ hit: false, projectId: "p1", reason: "miss" });
      warn.mockRestore();
    });
  });

  describe("first-open layout seed (#13782)", () => {
    const setCurrentProject = () => {
      vi.mocked(projectStore.getCurrentProject).mockReturnValue({
        id: "p1",
        name: "P",
        path: "/p",
      } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
      legacyOwnerRef.current = "p1";
    };

    it("records a project with no saved state as a first open", async () => {
      setCurrentProject();
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", true);
    });

    it("records a project with saved state, even an empty one, as not a first open", async () => {
      setCurrentProject();
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: { projectId: "p1", sidebarWidth: 350, terminals: [] },
      } as unknown as Awaited<ReturnType<typeof projectStore.getProjectStateWithRecovery>>);
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
    });

    it("does not count a state file that was quarantined as missing", async () => {
      setCurrentProject();
      vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
        state: null,
        quarantinedPath: "/p/state.json.corrupted.1",
      });
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
    });

    it("does not count a state file that was unreadable this session as missing", async () => {
      // Quarantine can fail to rename, leaving no recovery path to report.
      setCurrentProject();
      vi.mocked(projectStore.wasStateUnreadableThisSession).mockReturnValue(true);
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
    });

    it("does not count a safe-mode boot as a first open", async () => {
      setCurrentProject();
      crashGuard.isSafeMode.mockReturnValue(true);
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
    });

    it("does not count the heir of legacy global terminals as a first open", async () => {
      setCurrentProject();
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        terminals: [{ id: "t1", type: "terminal", title: "Shell", cwd: "/p", location: "grid" }],
      };
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
    });

    it("still counts a project as new when another project owns the legacy terminals", async () => {
      vi.mocked(projectStore.getCurrentProject).mockReturnValue({
        id: "p1",
        name: "P",
        path: "/p",
      } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
      globalAppStateRef.current = {
        ...DEFAULT_GLOBAL_APP_STATE,
        terminals: [{ id: "t1", type: "terminal", title: "Shell", cwd: "/p", location: "grid" }],
      };
      legacyOwnerRef.current = "p-other";
      await invokeBoot();
      expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", true);
    });

    it("records nothing for a view with no project row", async () => {
      await invokeBoot();
      expect(captureProjectLayoutSeed).not.toHaveBeenCalled();
    });

    describe("a state file that is unreadable and still in place (#15613)", () => {
      const legacyPanel = {
        id: "t1",
        type: "terminal",
        title: "Shell",
        cwd: "/p",
        location: "grid",
      } as const;

      beforeEach(() => {
        setCurrentProject();
        vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
          state: null,
          unreadableInPlace: true,
        });
        vi.mocked(projectStore.wasStateUnreadableThisSession).mockReturnValue(true);
      });

      it("hydrates empty without seeding a fresh state over it", async () => {
        const result = await invokeBoot();

        expect(result.workspaceId).toBe("p1");
        expect((result.appState as Record<string, unknown>).terminals).toEqual([]);
        expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
        expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p1", false);
      });

      it("neither shows nor migrates the heir's legacy terminals", async () => {
        globalAppStateRef.current = { ...DEFAULT_GLOBAL_APP_STATE, terminals: [legacyPanel] };

        const result = await invokeBoot();

        expect((result.appState as Record<string, unknown>).terminals).toEqual([]);
        expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
      });

      it("still restores the crash snapshot's panels, without writing them over it", async () => {
        globalAppStateRef.current = { ...DEFAULT_GLOBAL_APP_STATE, terminals: [legacyPanel] };
        crashService.consumePanelFilter.mockReturnValue(["t1"] as unknown as null);

        const result = await invokeBoot();
        const terminals = (result.appState as Record<string, unknown>).terminals as Array<
          Record<string, unknown>
        >;

        expect(terminals.map((t) => t.id)).toEqual(["t1"]);
        expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
      });

      it("still seeds once the read reports a file that really was moved aside", async () => {
        vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValue({
          state: null,
          quarantinedPath: "/p/state.json.corrupted.1",
        });

        await invokeBoot();

        expect(projectStore.enqueueProjectStateUpdate).toHaveBeenCalledTimes(1);
      });
    });

    it("hydrates normally when the seed can't be recorded", async () => {
      setCurrentProject();
      vi.mocked(captureProjectLayoutSeed).mockImplementationOnce(() => {
        throw new Error("EACCES");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await invokeBoot();
      expect(result.workspaceId).toBe("p1");
      warn.mockRestore();
    });
  });

  it("does not hydrate a closed URL project before the project view binding is ready", async () => {
    vi.mocked(getWindowForWebContents).mockReturnValue({
      id: 7,
      isDestroyed: () => false,
    } as unknown as Electron.BrowserWindow);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-stale",
      name: "Stale Project",
      path: "/projects/stale",
    } as unknown as ReturnType<typeof projectStore.getCurrentProject>);
    vi.mocked(projectStore.getProjectById).mockReturnValue({
      id: "proj-url-closed",
      name: "Closed URL Project",
      path: "/projects/url-closed",
      status: "closed",
    } as unknown as ReturnType<typeof projectStore.getProjectById>);

    const pvm = {
      getProjectIdForWebContents: vi.fn().mockReturnValue(null),
    };
    const deps = {
      windowRegistry: {
        getByWindowId: vi.fn().mockReturnValue({
          services: {
            projectViewManager: pvm,
          },
        }),
      },
      projectViewManager: pvm,
    } as unknown as HandlerDependencies;

    const result = await invokeBoot({
      deps,
      senderId: 42,
      senderUrl: "app://daintree/index.html?projectId=proj-url-closed",
    });

    expect(result.project).toBeNull();
    // A closed project keeps its row, so it must not be mistaken for a
    // row-less scratch and have its state served back (#11484).
    expect(result.workspaceId).toBeNull();
    expect(projectStore.getProjectStateWithRecovery).not.toHaveBeenCalled();
    expect(projectStore.getCurrentProject).not.toHaveBeenCalled();
  });
});

describe("app:set-state handler", () => {
  async function invokeSetState(payload: unknown) {
    ipcHandlers.clear();
    const cleanup = registerAppStateHandlers();
    const handler = ipcHandlers.get("app:set-state");
    if (!handler) throw new Error("app:set-state handler not registered");
    await handler(makeInvokeEvent(), payload);
    cleanup();
  }

  let storeModule: typeof import("../../store.js");

  beforeEach(async () => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) => {
      if (key === "appState") return { terminals: [], sidebarWidth: 350 };
      if (key === "terminalConfig") return { resourceMonitoringEnabled: false };
      if (key === "agentSettings") return {};
      return undefined;
    }) as never);
  });

  it("persists a multi-field update as a single merged appState write", async () => {
    await invokeSetState({ sidebarWidth: 400, focusMode: true, activeWorktreeId: "wt-1" });

    const setMock = vi.mocked(storeModule.store.set);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      "appState",
      expect.objectContaining({
        terminals: [],
        sidebarWidth: 400,
        focusMode: true,
        activeWorktreeId: "wt-1",
      })
    );
    expect(storeModule.store.delete).not.toHaveBeenCalled();
  });

  it("preserves unrelated persisted fields in the merged write", async () => {
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) => {
      if (key === "appState") return { terminals: [], sidebarWidth: 350, hasSeenWelcome: true };
      return undefined;
    }) as never);

    await invokeSetState({ focusMode: true });

    // store.set is called in the (key, value) form; read through an untyped
    // view since vi.mocked resolves the single-argument set(object) overload.
    const calls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
    const written = calls[0]![1];
    expect(written).toMatchObject({ sidebarWidth: 350, hasSeenWelcome: true, focusMode: true });
  });

  it("changes the grid strategy without touching the stored count", async () => {
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
      key === "appState"
        ? { terminals: [], panelGridConfig: { strategy: "automatic", value: 6 } }
        : undefined) as never);
    await invokeSetState({ panelGridConfig: { strategy: "fixed-rows" } });
    const calls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
    expect((calls[0]![1] as Record<string, unknown>).panelGridConfig).toEqual({
      strategy: "fixed-rows",
      value: 6,
    });
  });

  it("tells this machine's views the saved grid when it changes, and only then (#14700)", async () => {
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
      key === "appState"
        ? { terminals: [], panelGridConfig: { strategy: "automatic", value: 6 } }
        : undefined) as never);
    broadcastToRendererMock.mockClear();

    await invokeSetState({ panelGridConfig: { value: 6 } });
    await invokeSetState({ sidebarWidth: 300 });
    expect(broadcastToRendererMock).not.toHaveBeenCalledWith(
      CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED,
      expect.anything()
    );

    await invokeSetState({ panelGridConfig: { strategy: "fixed-rows" } });
    expect(
      broadcastToRendererMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED
      )
    ).toEqual([[CHANNELS.APP_PANEL_GRID_CONFIG_CHANGED, { strategy: "fixed-rows", value: 6 }]]);
  });

  it("changes the grid count without touching the stored strategy", async () => {
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
      key === "appState"
        ? { terminals: [], panelGridConfig: { strategy: "fixed-columns", value: 3 } }
        : undefined) as never);
    await invokeSetState({ panelGridConfig: { value: 5 } });
    const calls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
    expect((calls[0]![1] as Record<string, unknown>).panelGridConfig).toEqual({
      strategy: "fixed-columns",
      value: 5,
    });
  });

  it("drops cleared fields from the merged object instead of writing undefined", async () => {
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) => {
      if (key === "appState") {
        return {
          terminals: [],
          sidebarWidth: 350,
          focusPanelState: { sidebarWidth: 300, diagnosticsOpen: false },
        };
      }
      return undefined;
    }) as never);

    await invokeSetState({ focusPanelState: null });

    const setMock = vi.mocked(storeModule.store.set);
    expect(setMock).toHaveBeenCalledTimes(1);
    const calls = setMock.mock.calls as unknown as unknown[][];
    const written = calls[0]![1];
    expect(written).not.toHaveProperty("focusPanelState");
    expect(written).toMatchObject({ sidebarWidth: 350 });
    expect(storeModule.store.delete).not.toHaveBeenCalled();
  });

  it("writes nothing when no field survives validation", async () => {
    await invokeSetState({ sidebarWidth: 99999 });
    expect(storeModule.store.set).not.toHaveBeenCalled();
  });

  it("schedules a crash backup only for crash-critical fields", async () => {
    await invokeSetState({ sidebarWidth: 400 });
    expect(crashService.scheduleBackup).not.toHaveBeenCalled();

    await invokeSetState({ focusMode: true });
    expect(crashService.scheduleBackup).toHaveBeenCalledTimes(1);
  });

  it("keeps plugin panel and worktree path MRU ids while dropping malformed ones (#13763)", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue(null);
    const projectPluginPanel = `terminal:project:${"a".repeat(64)}/acme/dashboard-${"0".repeat(36)}`;

    await invokeSetState({
      mruList: [
        "terminal:acme.dashboard-1234",
        projectPluginPanel,
        "worktree:/Users/me/repo-wt",
        "worktree:C:\\repo\\wt",
        "terminal:acme.dashboard-1234",
        "terminal:",
        "panel:x",
        "terminal:bad\nid",
        `terminal:${"x".repeat(1025)}`,
        42,
      ],
    });

    const calls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
    const written = calls.filter((call) => call[0] === "appState").at(-1)?.[1] as {
      mruList?: string[];
    };
    expect(written.mruList).toEqual([
      "terminal:acme.dashboard-1234",
      projectPluginPanel,
      "worktree:/Users/me/repo-wt",
      "worktree:C:\\repo\\wt",
    ]);
  });
});

describe("app:hydrate host fields", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    globalAppStateRef.current = { ...DEFAULT_GLOBAL_APP_STATE };
    legacyOwnerRef.current = undefined;
    const storeModule = await import("../../store.js");
    vi.mocked(storeModule.store.get).mockImplementation(
      defaultStoreGet as typeof storeModule.store.get
    );
  });

  it("names this machine as the host of a local window", async () => {
    const os = await import("os");
    const result = await invokeBoot();
    expect(result.hostPlatform).toBe(process.platform);
    expect(result.hostHomeDir).toBe(os.homedir());
    expect(result.hostTmpDir).toBe(os.tmpdir());
    expect(result.systemTmpDir).toBe(os.tmpdir());
  });

  it("leaves this machine's one-shot notices alone when answering a remote Shell", async () => {
    const { getIpcDispatcher, _resetIpcDispatcherForTesting } = await import("../dispatcher.js");
    const { wrapError, wrapSuccess } =
      await import("../../../shared/utils/ipcErrorSerialization.js");
    const storeModule = await import("../../store.js");
    _resetIpcDispatcherForTesting();
    const dispatcher = getIpcDispatcher();
    dispatcher.setInvokeEnveloper(async (_channel, _args, call) => {
      try {
        return wrapSuccess(await call());
      } catch (error) {
        return wrapError(error);
      }
    });
    const release = dispatcher.allowHybridOverLink("app:hydrate");
    ipcHandlers.clear();
    const cleanup = registerAppStateHandlers();
    const endpoint = {
      endpointId: "s1:view-1",
      clientId: "client-1",
      projectId: null,
      kind: "remote-view" as const,
      handle: -4,
      send: vi.fn(),
      request: vi.fn(),
      onClose: vi.fn(() => ({ dispose: () => undefined })),
      isClosed: () => false,
    };
    const client = { clientId: "client-1", clientName: "mbp", kind: "remote" } as never;
    crashService.hasPendingPanelFilter.mockReturnValueOnce(true);

    const envelope = await dispatcher.invokeForEndpoint({ endpoint, client }, "app:hydrate", []);

    cleanup();
    release();
    _resetIpcDispatcherForTesting();
    expect(envelope.ok).toBe(true);
    expect(storeModule.consumePendingSettingsRecovery).not.toHaveBeenCalled();
    expect(consumeDatabaseRecovery).not.toHaveBeenCalled();
    expect(crashService.consumePanelFilter).not.toHaveBeenCalled();
    const data = (envelope as { data: Record<string, unknown> }).data;
    expect(data.hostPlatform).toBe(process.platform);
    expect(data.settingsRecovery).toBeNull();
    expect(data.databaseRecovery).toBeNull();
  });

  it("never lets a remote Shell's view claim the legacy global layout", async () => {
    const { getIpcDispatcher, _resetIpcDispatcherForTesting } = await import("../dispatcher.js");
    const { wrapSuccess } = await import("../../../shared/utils/ipcErrorSerialization.js");
    const storeModule = await import("../../store.js");
    vi.mocked(projectStore.getProjectById).mockReturnValueOnce({
      id: "p-remote",
      name: "R",
      path: "/r",
    } as never);
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValueOnce({
      state: null,
    } as never);
    _resetIpcDispatcherForTesting();
    const dispatcher = getIpcDispatcher();
    dispatcher.setInvokeEnveloper(async (_c, _a, call) => wrapSuccess(await call()));
    const release = dispatcher.allowHybridOverLink("app:hydrate");
    const cleanup = registerAppStateHandlers();
    const endpoint = {
      endpointId: "s1:view-2",
      clientId: "client-1",
      projectId: "p-remote",
      kind: "remote-view" as const,
      handle: -5,
      send: vi.fn(),
      request: vi.fn(),
      onClose: vi.fn(() => ({ dispose: () => undefined })),
      isClosed: () => false,
    };

    await dispatcher.invokeForEndpoint(
      { endpoint, client: { clientId: "client-1", kind: "remote" } as never },
      "app:hydrate",
      []
    );

    cleanup();
    release();
    _resetIpcDispatcherForTesting();
    expect(legacyOwnerRef.current).toBeUndefined();
    expect(vi.mocked(storeModule.store.set)).not.toHaveBeenCalledWith(
      "legacyWorkspaceStateOwnerId",
      expect.anything()
    );
  });

  it("records a remote Shell view's first open of a host project as one (#13782)", async () => {
    // The fresh state this hydrate writes is the host's, so a later local open
    // would find it and could never count as first.
    const { getIpcDispatcher, _resetIpcDispatcherForTesting } = await import("../dispatcher.js");
    const { wrapSuccess } = await import("../../../shared/utils/ipcErrorSerialization.js");
    vi.mocked(projectStore.getProjectById).mockReturnValueOnce({
      id: "p-remote",
      name: "R",
      path: "/r",
    } as never);
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValueOnce({
      state: null,
    } as never);
    _resetIpcDispatcherForTesting();
    const dispatcher = getIpcDispatcher();
    dispatcher.setInvokeEnveloper(async (_c, _a, call) => wrapSuccess(await call()));
    const release = dispatcher.allowHybridOverLink("app:hydrate");
    const cleanup = registerAppStateHandlers();
    const endpoint = {
      endpointId: "s1:view-3",
      clientId: "client-1",
      projectId: "p-remote",
      kind: "remote-view" as const,
      handle: -6,
      send: vi.fn(),
      request: vi.fn(),
      onClose: vi.fn(() => ({ dispose: () => undefined })),
      isClosed: () => false,
    };

    await dispatcher.invokeForEndpoint(
      { endpoint, client: { clientId: "client-1", kind: "remote" } as never },
      "app:hydrate",
      []
    );

    cleanup();
    release();
    _resetIpcDispatcherForTesting();
    expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p-remote", true);
  });

  it("does not count a remote first open as one while unclaimed legacy terminals could be its own", async () => {
    // A remote view never claims the legacy record, so it stays unowned here
    // and could still be this project's history (#13782).
    const { getIpcDispatcher, _resetIpcDispatcherForTesting } = await import("../dispatcher.js");
    const { wrapSuccess } = await import("../../../shared/utils/ipcErrorSerialization.js");
    globalAppStateRef.current = {
      ...DEFAULT_GLOBAL_APP_STATE,
      terminals: [{ id: "t1", type: "terminal", title: "Shell", cwd: "/r", location: "grid" }],
    };
    vi.mocked(projectStore.getProjectById).mockReturnValueOnce({
      id: "p-remote",
      name: "R",
      path: "/r",
    } as never);
    vi.mocked(projectStore.getProjectStateWithRecovery).mockResolvedValueOnce({
      state: null,
    } as never);
    _resetIpcDispatcherForTesting();
    const dispatcher = getIpcDispatcher();
    dispatcher.setInvokeEnveloper(async (_c, _a, call) => wrapSuccess(await call()));
    const release = dispatcher.allowHybridOverLink("app:hydrate");
    const cleanup = registerAppStateHandlers();
    const endpoint = {
      endpointId: "s1:view-4",
      clientId: "client-1",
      projectId: "p-remote",
      kind: "remote-view" as const,
      handle: -7,
      send: vi.fn(),
      request: vi.fn(),
      onClose: vi.fn(() => ({ dispose: () => undefined })),
      isClosed: () => false,
    };

    await dispatcher.invokeForEndpoint(
      { endpoint, client: { clientId: "client-1", kind: "remote" } as never },
      "app:hydrate",
      []
    );

    cleanup();
    release();
    _resetIpcDispatcherForTesting();
    expect(legacyOwnerRef.current).toBeUndefined();
    expect(captureProjectLayoutSeed).toHaveBeenCalledWith("p-remote", false);
  });
});

describe("app:set-state while another screen drives the view's project", () => {
  let storeModule: typeof import("../../store.js");
  let leaseModule: typeof import("../../services/DriveLeaseService.js");
  let registryModule: typeof import("../../window/webContentsRegistry.js");

  async function invokeSetState(payload: unknown) {
    ipcHandlers.clear();
    const cleanup = registerAppStateHandlers();
    await ipcHandlers.get("app:set-state")!(
      {
        sender: { id: 7, getURL: () => "", isDestroyed: () => false, once: vi.fn(), on: vi.fn() },
      },
      payload
    );
    cleanup();
  }

  function written(): Record<string, unknown> {
    const calls = vi.mocked(storeModule.store.set).mock.calls as unknown as unknown[][];
    const appState = calls.filter((call) => call[0] === "appState").at(-1);
    return (appState?.[1] ?? {}) as Record<string, unknown>;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    storeModule = await import("../../store.js");
    leaseModule = await import("../../services/DriveLeaseService.js");
    registryModule = await import("../../window/webContentsRegistry.js");
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
      key === "appState" ? { terminals: [], sidebarWidth: 350 } : undefined) as never);
    vi.mocked(registryModule.getProjectForWebContents).mockReturnValue("proj-1");
  });

  afterEach(() => {
    leaseModule._resetDriveLeaseServiceForTesting(null);
    vi.mocked(registryModule.getProjectForWebContents).mockReturnValue(null);
  });

  const mixed = {
    sidebarWidth: 420,
    diagnosticsHeight: 300,
    panelGridConfig: { strategy: "fixed-columns", value: 3 },
    activeWorktreeId: "wt-stale",
    focusMode: true,
  };

  it("keeps this screen's own fields and leaves the project's to its driver", async () => {
    const isDriving = vi.fn(() => false);
    leaseModule._resetDriveLeaseServiceForTesting({
      isDriving,
      dispose: () => undefined,
    } as unknown as InstanceType<typeof leaseModule.DriveLeaseService>);

    await invokeSetState(mixed);

    expect(isDriving).toHaveBeenCalledWith(
      "proj-1",
      expect.objectContaining({ clientId: "local" })
    );
    expect(written()).toMatchObject({
      sidebarWidth: 420,
      diagnosticsHeight: 300,
      panelGridConfig: mixed.panelGridConfig,
    });
    expect(written()).not.toHaveProperty("activeWorktreeId");
    expect(written()).not.toHaveProperty("focusMode");
  });

  it("holds a view to the lease before its binding lands, through the workspace it writes", async () => {
    vi.mocked(registryModule.getProjectForWebContents).mockReturnValue(null);
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-1",
      name: "p",
      path: "/p",
    } as never);
    const isDriving = vi.fn(() => false);
    leaseModule._resetDriveLeaseServiceForTesting({
      isDriving,
      dispose: () => undefined,
    } as unknown as InstanceType<typeof leaseModule.DriveLeaseService>);

    await invokeSetState(mixed);

    expect(isDriving).toHaveBeenCalledWith("proj-1", expect.anything());
    expect(written()).toMatchObject({ sidebarWidth: 420 });
    expect(written()).not.toHaveProperty("activeWorktreeId");
    vi.mocked(projectStore.getCurrentProject).mockReturnValue(null);
  });

  it("writes every field while it drives, and with no lease service at all", async () => {
    leaseModule._resetDriveLeaseServiceForTesting({
      isDriving: () => true,
      dispose: () => undefined,
    } as unknown as InstanceType<typeof leaseModule.DriveLeaseService>);
    await invokeSetState(mixed);
    expect(written()).toMatchObject({
      panelGridConfig: mixed.panelGridConfig,
      activeWorktreeId: "wt-stale",
    });

    vi.mocked(storeModule.store.set).mockClear();
    leaseModule._resetDriveLeaseServiceForTesting(null);
    await invokeSetState(mixed);
    expect(written()).toMatchObject({
      panelGridConfig: mixed.panelGridConfig,
      activeWorktreeId: "wt-stale",
    });
  });
});

describe("app:set-state grid layout patch (#14700)", () => {
  let storeModule: typeof import("../../store.js");
  let stored: Record<string, unknown>;

  async function invokeSetState(payload: unknown) {
    ipcHandlers.clear();
    const cleanup = registerAppStateHandlers();
    const handler = ipcHandlers.get("app:set-state");
    if (!handler) throw new Error("app:set-state handler not registered");
    await handler(makeInvokeEvent(), payload);
    cleanup();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    storeModule = await import("../../store.js");
    stored = { terminals: [], panelGridConfig: { strategy: "automatic", value: 4 } };
    vi.mocked(storeModule.store.get).mockImplementation(((key: string) =>
      key === "appState" ? stored : undefined) as never);
    vi.mocked(storeModule.store.set).mockImplementation(((key: string, value: unknown) => {
      if (key === "appState") stored = value as Record<string, unknown>;
    }) as never);
  });

  afterEach(() => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue(null);
  });

  it.each([0, -1, 11, 2.5])("refuses a count of %s", async (value) => {
    await invokeSetState({ panelGridConfig: { value } });

    expect(stored.panelGridConfig).toEqual({ strategy: "automatic", value: 4 });
  });

  it.each([1, 10])("keeps a count of %s", async (value) => {
    await invokeSetState({ panelGridConfig: { value } });

    expect(stored.panelGridConfig).toEqual({ strategy: "automatic", value });
  });

  it("merges over the count saved while the same write waited on its MRU save", async () => {
    vi.mocked(projectStore.getCurrentProject).mockReturnValue({
      id: "proj-1",
      name: "p",
      path: "/p",
    } as never);
    let release!: () => void;
    vi.mocked(projectStore.enqueueProjectStateUpdate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }) as never
    );

    const pending = invokeSetState({
      mruList: ["terminal:a"],
      panelGridConfig: { strategy: "fixed-rows" },
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    // Another view changes the count while this write is parked.
    stored = { ...stored, panelGridConfig: { strategy: "automatic", value: 7 } };
    release();
    await pending;

    expect(stored.panelGridConfig).toEqual({ strategy: "fixed-rows", value: 7 });
  });
});

describe("app:first-interactive handler", () => {
  it("marks the sender ready for a held database backup notice", async () => {
    vi.mocked(noteDatabaseNoticeRendererReady).mockClear();
    ipcHandlers.clear();
    const cleanup = registerAppStateHandlers();
    const handler = ipcHandlers.get(CHANNELS.APP_FIRST_INTERACTIVE);
    if (!handler) throw new Error("app:first-interactive handler not registered");

    await handler(makeInvokeEvent(7));
    cleanup();

    expect(noteDatabaseNoticeRendererReady).toHaveBeenCalledExactlyOnceWith(7);
  });
});
