import os from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrateResult } from "../../../shared/types/ipc/app.js";

const mockState = vi.hoisted(() => ({
  appState: {
    terminals: [
      {
        id: "global-terminal",
        kind: "terminal",
        type: "terminal",
        title: "Global Terminal",
        cwd: "/global",
        location: "grid",
      },
    ],
    sidebarWidth: 320,
    focusMode: true,
    focusPanelState: { sidebarWidth: 260, diagnosticsOpen: true },
    activeWorktreeId: "wt-global",
    mruList: ["terminal:global-terminal"] as string[],
  },
  /**
   * The workspace that claimed the legacy global record. Defaults to the
   * fixture's own project so the inheritance tests below read as "the heir
   * gets its record back" rather than "any row with a Project row does"
   * (#11651).
   */
  legacyWorkspaceStateOwnerId: "project-1" as string | undefined,
  terminalConfig: { scrollback: 5000 },
  agentSettings: { defaultAgent: "codex" },
  project: { id: "project-1", name: "Project One", path: "/project/one" },
  projectState: undefined as
    | {
        terminals?: unknown[];
        activeWorktreeId?: string;
        focusMode?: boolean;
        focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
        mruList?: string[];
        tabGroups?: unknown[];
        terminalSizes?: Record<string, { cols: number; rows: number }>;
        draftInputs?: Record<string, string>;
      }
    | undefined,
  projectPresets: {} as Record<string, unknown[]>,
  projectStateQuarantinedPath: undefined as string | undefined,
  safeMode: false,
  gpuStatus: { webgl2: "enabled" },
  gpuWebGLHardware: true,
  gpuDisabledByFlag: false,
}));

const getProjectByIdMock = vi.hoisted(() =>
  vi.fn((projectId: string) => (projectId === mockState.project?.id ? mockState.project : null))
);
const getProjectStateMock = vi.hoisted(() => vi.fn(async () => mockState.projectState));
const readInRepoPresetsMock = vi.hoisted(() => vi.fn(async () => mockState.projectPresets));
const getProjectStateWithRecoveryMock = vi.hoisted(() =>
  vi.fn(async () => ({
    state: mockState.projectState,
    quarantinedPath: mockState.projectStateQuarantinedPath,
  }))
);
const storeGetMock = vi.hoisted(() =>
  vi.fn((key: string) => {
    if (key === "appState") return mockState.appState;
    if (key === "legacyWorkspaceStateOwnerId") return mockState.legacyWorkspaceStateOwnerId;
    if (key === "terminalConfig") return mockState.terminalConfig;
    if (key === "agentSettings") return mockState.agentSettings;
    return undefined;
  })
);
const isSafeModeMock = vi.hoisted(() => vi.fn(() => mockState.safeMode));
const getGPUFeatureStatusMock = vi.hoisted(() => vi.fn(() => mockState.gpuStatus));
const isWebGLHardwareAcceleratedMock = vi.hoisted(() => vi.fn(() => mockState.gpuWebGLHardware));
const isGpuDisabledByFlagMock = vi.hoisted(() => vi.fn(() => mockState.gpuDisabledByFlag));

vi.mock("electron", () => ({
  app: {
    getGPUFeatureStatus: getGPUFeatureStatusMock,
    getPath: vi.fn(() => "/tmp/user-data"),
  },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: storeGetMock,
  },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getProjectById: getProjectByIdMock,
    getProjectState: getProjectStateMock,
    getProjectStateWithRecovery: getProjectStateWithRecoveryMock,
    readInRepoPresets: readInRepoPresetsMock,
  },
}));

vi.mock("../CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => ({
    isSafeMode: isSafeModeMock,
  }),
}));

vi.mock("../../utils/gpuDetection.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/gpuDetection.js")>(
    "../../utils/gpuDetection.js"
  );
  return {
    ...actual,
    isWebGLHardwareAccelerated: isWebGLHardwareAcceleratedMock,
  };
});

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: isGpuDisabledByFlagMock,
  isGpuAngleFallbackApplied: vi.fn(() => false),
}));

describe("AppHydrationService adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.appState = {
      terminals: [
        {
          id: "global-terminal",
          kind: "terminal",
          type: "terminal",
          title: "Global Terminal",
          cwd: "/global",
          location: "grid",
        },
      ],
      sidebarWidth: 320,
      focusMode: true,
      focusPanelState: { sidebarWidth: 260, diagnosticsOpen: true },
      activeWorktreeId: "wt-global",
      mruList: ["terminal:global-terminal"],
    };
    mockState.legacyWorkspaceStateOwnerId = "project-1";
    mockState.terminalConfig = { scrollback: 5000 };
    mockState.agentSettings = { defaultAgent: "codex" };
    mockState.project = { id: "project-1", name: "Project One", path: "/project/one" };
    mockState.projectState = undefined;
    mockState.projectPresets = {};
    mockState.projectStateQuarantinedPath = undefined;
    mockState.safeMode = false;
    mockState.gpuStatus = { webgl2: "enabled" };
    mockState.gpuWebGLHardware = true;
    mockState.gpuDisabledByFlag = false;
  });

  it("PARTIAL_PROJECT_STATE_OVERRIDES_ONLY_DEFINED", async () => {
    mockState.projectState = {
      terminals: [
        {
          id: "project-terminal",
          type: "terminal",
          title: "Project Terminal",
          cwd: "/project",
          location: "dock",
        },
      ],
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.terminals).toEqual([
      expect.objectContaining({
        id: "project-terminal",
        kind: "terminal",
        location: "dock",
      }),
    ]);
    expect(result.appState.activeWorktreeId).toBe("wt-global");
    expect(result.appState.focusMode).toBe(true);
    expect(result.appState.focusPanelState).toEqual({ sidebarWidth: 260, diagnosticsOpen: true });
  });

  it("serves the per-project mruList on switch, not the global list (#9922)", async () => {
    mockState.projectState = {
      terminals: [],
      mruList: ["terminal:project-terminal", "worktree:wt-local"],
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.mruList).toEqual(["terminal:project-terminal", "worktree:wt-local"]);
  });

  it("falls back to the global mruList when the project has none (migration)", async () => {
    mockState.projectState = {
      terminals: [],
      // mruList intentionally undefined — not migrated yet.
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.mruList).toEqual(["terminal:global-terminal"]);
  });

  it("treats an explicitly empty per-project mruList as authoritative (no global fallback)", async () => {
    mockState.projectState = {
      terminals: [],
      mruList: [],
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.mruList).toEqual([]);
  });

  it("CORRUPT_TERMINALS_FILTERED_NOT_FATAL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockState.projectState = {
      terminals: [
        {
          id: "terminal-ok",
          type: "terminal",
          title: "OK",
          cwd: "/ok",
          location: "grid",
        },
        {
          id: "browser-ok",
          title: "Browser",
          browserUrl: "https://example.com",
          location: "dock",
        },
        {
          id: "trash-terminal",
          type: "terminal",
          title: "Trash",
          cwd: "/trash",
          location: "trash",
        },
        {
          id: "invalid-terminal",
          type: "terminal",
          title: "Invalid",
          location: "grid",
        },
      ],
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.terminals).toEqual([
      expect.objectContaining({
        id: "terminal-ok",
        kind: "terminal",
        location: "grid",
      }),
      expect.objectContaining({
        id: "browser-ok",
        kind: "browser",
        location: "dock",
      }),
    ]);
    expect(result.appState.terminals).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("SAFE_MODE_SUPPRESSES_TERMINALS_ONLY", async () => {
    mockState.safeMode = true;
    mockState.projectState = {
      terminals: [
        {
          id: "project-terminal",
          type: "terminal",
          title: "Project Terminal",
          cwd: "/project",
          location: "grid",
        },
      ],
      focusMode: false,
      activeWorktreeId: "wt-project",
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.terminals).toEqual([]);
    expect(result.appState.focusMode).toBe(false);
    expect(result.appState.activeWorktreeId).toBe("wt-project");
    expect(result.terminalConfig).toBe(mockState.terminalConfig);
    expect(result.agentSettings).toBe(mockState.agentSettings);
    expect(result.project).toEqual(mockState.project);
    expect(result.safeMode).toBe(true);
  });

  it("NO_PROJECT_STATE_EMPTY_TERMINALS_GLOBAL_FOCUS", async () => {
    mockState.projectState = undefined;

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.terminals).toEqual([]);
    // A real project row still inherits the two fields the renderer keeps
    // rewriting app-globally (#11497) — see the ownership note in
    // `buildSwitchHydrateResult`.
    expect(result.appState.activeWorktreeId).toBe("wt-global");
    expect(result.appState.focusMode).toBe(true);
    expect(result.appState.focusPanelState).toEqual(mockState.appState.focusPanelState);
    // The MRU is the one legacy field here, so it takes the owner gate: this
    // project claimed the record, so it gets the list back.
    expect(result.appState.mruList).toEqual(mockState.appState.mruList);
    expect(result.settingsRecovery).toBeNull();
    expect(result.projectStateRecovery).toBeNull();
  });

  it("NO_PROJECT_STATE_DENIES_THE_LEGACY_MRU_TO_A_NON_OWNER", async () => {
    // Same shape as the test above — a real Project row with nothing saved yet
    // — but another workspace owns the legacy record. Serving it the legacy MRU
    // would seed this project's quick-switcher with another project's panels
    // and worktrees (#11651).
    mockState.projectState = undefined;
    mockState.legacyWorkspaceStateOwnerId = "project-somebody-else";

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.mruList).toBeUndefined();
    // Focus and worktree are NOT denied: they are still live app-global state
    // the renderer rewrites, so withholding them would drop this project's own
    // selection rather than narrow a legacy leak.
    expect(result.appState.activeWorktreeId).toBe("wt-global");
    expect(result.appState.focusMode).toBe(true);
    // The row itself still resolves — this is an ownership denial, not a
    // failure to find the project.
    expect(result.project).toEqual(mockState.project);
  });

  it("denies the legacy mruList while the record is still unclaimed", async () => {
    // This path performs no writes, so it can never claim the record itself.
    // Until `handleAppHydrate` settles ownership, an unclaimed record has no
    // heir, and serving it to whoever switches first is the guess the owner id
    // exists to remove (#11651).
    mockState.projectState = undefined;
    mockState.legacyWorkspaceStateOwnerId = undefined;

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.appState.mruList).toBeUndefined();
  });

  it("folds the system temp dir into the payload so the renderer can skip the IPC call", async () => {
    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    // The field must be present and wired to the live temp dir (not undefined),
    // so the renderer can derive the clipboard directory without a round-trip.
    expect(result.systemTmpDir).toBe(os.tmpdir());
    expect(result.systemTmpDir!.length).toBeGreaterThan(0);
  });

  it("folds tabGroups/terminalSizes/draftInputs from project state into the payload", async () => {
    const tabGroups = [{ id: "g1", location: "grid", activeTabId: "t1", panelIds: ["t1"] }];
    const terminalSizes = { t1: { cols: 120, rows: 40 } };
    const draftInputs = { t1: "draft text" };
    mockState.projectState = {
      terminals: [],
      tabGroups,
      terminalSizes,
      draftInputs,
    };

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.tabGroups).toEqual(tabGroups);
    expect(result.terminalSizes).toEqual(terminalSizes);
    expect(result.draftInputs).toEqual(draftInputs);
  });

  it("folds in-repo project presets into the payload", async () => {
    const presets = { claude: [{ id: "team-preset", name: "Team" }] };
    mockState.projectPresets = presets as Record<string, unknown[]>;

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(readInRepoPresetsMock).toHaveBeenCalledWith("/project/one");
    expect(result.projectPresets).toEqual(presets);
  });

  it("degrades projectPresets to empty when the in-repo read fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    readInRepoPresetsMock.mockRejectedValueOnce(new Error("EACCES"));

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.projectPresets).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("leaves projectPresets undefined when the project is unknown", async () => {
    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("missing-project");

    expect(readInRepoPresetsMock).not.toHaveBeenCalled();
    expect(result.projectPresets).toBeUndefined();
  });

  it("defaults tabGroups/terminalSizes/draftInputs to empty when project state is missing", async () => {
    mockState.projectState = undefined;

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    // Must mirror the standalone IPC handlers' null-state returns so the
    // renderer's payload-presence gate never re-fetches on a fresh project.
    expect(result.tabGroups).toEqual([]);
    expect(result.terminalSizes).toEqual({});
    expect(result.draftInputs).toEqual({});
  });

  it("CONCURRENT_CALLS_READ_ONLY", async () => {
    type ProjectStateFixture = {
      terminals?: unknown[];
      activeWorktreeId?: string;
      focusMode?: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    };
    let resolveProjectState!: (value: {
      state: ProjectStateFixture;
      quarantinedPath: string | undefined;
    }) => void;
    const pendingProjectState = new Promise<{
      state: ProjectStateFixture;
      quarantinedPath: string | undefined;
    }>((resolve) => {
      resolveProjectState = resolve;
    });
    getProjectStateWithRecoveryMock.mockReturnValueOnce(pendingProjectState);
    getProjectStateWithRecoveryMock.mockReturnValueOnce(pendingProjectState);

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const firstPromise = buildSwitchHydrateResult("project-1");
    const secondPromise = buildSwitchHydrateResult("project-1");

    resolveProjectState({
      state: {
        terminals: [
          {
            id: "project-terminal",
            type: "terminal",
            title: "Project Terminal",
            cwd: "/project",
            location: "grid",
          },
        ],
        focusMode: false,
        activeWorktreeId: "wt-project",
      },
      quarantinedPath: undefined,
    });

    const [first, second] = (await Promise.all([firstPromise, secondPromise])) as [
      HydrateResult,
      HydrateResult,
    ];

    expect(first).toEqual(second);
    expect(getProjectStateWithRecoveryMock).toHaveBeenCalledTimes(2);
    expect(storeGetMock).not.toHaveBeenCalledWith("pendingSettingsRecovery");
  });

  it("PROJECT_STATE_RECOVERY_PROPAGATED", async () => {
    mockState.projectState = undefined;
    mockState.projectStateQuarantinedPath = "/projects/abc/state.json.corrupted";

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.projectStateRecovery).toEqual({
      quarantinedPath: "/projects/abc/state.json.corrupted",
    });
    expect(result.appState.terminals).toEqual([]);
  });

  it("PROJECT_STATE_RECOVERY_NULL_WHEN_CLEAN", async () => {
    mockState.projectState = {
      terminals: [
        {
          id: "project-terminal",
          type: "terminal",
          title: "Project Terminal",
          cwd: "/project",
          location: "grid",
        },
      ],
    };
    mockState.projectStateQuarantinedPath = undefined;

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("project-1");

    expect(result.projectStateRecovery).toBeNull();
  });

  it("UNKNOWN_PROJECT_ID_STILL_VALID", async () => {
    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("missing-project");

    expect(result.project).toBeNull();
    expect(result.appState.terminals).toEqual([]);
    // No Project row resolved, so this workspace owns none of the legacy
    // focus/worktree/MRU state and must not inherit it (#11497).
    expect(result.appState.focusMode).toBe(false);
    expect(result.appState.focusPanelState).toBeUndefined();
    expect(result.appState.activeWorktreeId).toBeUndefined();
    expect(result.appState.mruList).toBeUndefined();
    // App-global preferences still ride along unchanged.
    expect(result.appState.sidebarWidth).toBe(mockState.appState.sidebarWidth);
    expect(result.terminalConfig).toBe(mockState.terminalConfig);
    expect(result.agentSettings).toBe(mockState.agentSettings);
    expect(result.gpuWebGLHardware).toBe(true);
  });
});
