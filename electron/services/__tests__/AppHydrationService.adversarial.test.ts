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
  },
  terminalConfig: { scrollback: 5000 },
  agentSettings: { defaultAgent: "codex" },
  project: { id: "project-1", name: "Project One", path: "/project/one" },
  projectState: undefined as
    | {
        terminals?: unknown[];
        activeWorktreeId?: string;
        focusMode?: boolean;
        focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
      }
    | undefined,
  safeMode: false,
  gpuStatus: { webgl2: "enabled" },
  gpuWebGLHardware: true,
  gpuDisabledByFlag: false,
}));

const getProjectByIdMock = vi.hoisted(() =>
  vi.fn((projectId: string) => (projectId === mockState.project?.id ? mockState.project : null))
);
const getProjectStateMock = vi.hoisted(() => vi.fn(async () => mockState.projectState));
const storeGetMock = vi.hoisted(() =>
  vi.fn((key: string) => {
    if (key === "appState") return mockState.appState;
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
  },
}));

vi.mock("../CrashLoopGuardService.js", () => ({
  getCrashLoopGuard: () => ({
    isSafeMode: isSafeModeMock,
  }),
}));

vi.mock("../../utils/gpuDetection.js", () => ({
  isWebGLHardwareAccelerated: isWebGLHardwareAcceleratedMock,
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: isGpuDisabledByFlagMock,
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
    };
    mockState.terminalConfig = { scrollback: 5000 };
    mockState.agentSettings = { defaultAgent: "codex" };
    mockState.project = { id: "project-1", name: "Project One", path: "/project/one" };
    mockState.projectState = undefined;
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
    expect(result.appState.activeWorktreeId).toBe("wt-global");
    expect(result.appState.focusMode).toBe(true);
    expect(result.settingsRecovery).toBeNull();
  });

  it("CONCURRENT_CALLS_READ_ONLY", async () => {
    let resolveProjectState!: (value: {
      terminals?: unknown[];
      activeWorktreeId?: string;
      focusMode?: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }) => void;
    const pendingProjectState = new Promise<{
      terminals?: unknown[];
      activeWorktreeId?: string;
      focusMode?: boolean;
      focusPanelState?: { sidebarWidth: number; diagnosticsOpen: boolean };
    }>((resolve) => {
      resolveProjectState = resolve;
    });
    getProjectStateMock.mockReturnValueOnce(pendingProjectState);
    getProjectStateMock.mockReturnValueOnce(pendingProjectState);

    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const firstPromise = buildSwitchHydrateResult("project-1");
    const secondPromise = buildSwitchHydrateResult("project-1");

    resolveProjectState({
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
    });

    const [first, second] = (await Promise.all([firstPromise, secondPromise])) as [
      HydrateResult,
      HydrateResult,
    ];

    expect(first).toEqual(second);
    expect(getProjectStateMock).toHaveBeenCalledTimes(2);
    expect(storeGetMock).not.toHaveBeenCalledWith("pendingSettingsRecovery");
  });

  it("UNKNOWN_PROJECT_ID_STILL_VALID", async () => {
    const { buildSwitchHydrateResult } = await import("../AppHydrationService.js");
    const result = await buildSwitchHydrateResult("missing-project");

    expect(result.project).toBeNull();
    expect(result.appState.terminals).toEqual([]);
    expect(result.terminalConfig).toBe(mockState.terminalConfig);
    expect(result.agentSettings).toBe(mockState.agentSettings);
    expect(result.gpuWebGLHardware).toBe(true);
  });
});
