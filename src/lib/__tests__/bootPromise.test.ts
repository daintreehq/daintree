// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BootResult } from "@shared/types/ipc/app";

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

const { getBootPromise, releaseBootPayload, resetBootPromiseForTests } =
  await import("../bootPromise");

function makeBootResult(): BootResult {
  return {
    appState: { terminals: [], sidebarWidth: 350 },
    terminalConfig: { scrollbackLines: 1000 },
    project: null,
    agentSettings: { agents: {} },
    gpuWebGLHardware: true,
    gpuHardwareAccelerationDisabled: false,
    gpuAngleFallbackActive: false,
    safeMode: false,
    isWindowsStore: false,
    crashPending: null,
    crashConfig: { autoRestoreOnCrash: true },
    tabGroups: [{ id: "g1", location: "grid", activeTabId: "t1", panelIds: ["t1"] }],
    terminalSizes: { t1: { cols: 80, rows: 24 } },
    draftInputs: { t1: "secret half-typed draft" },
    projectPresets: { claude: [{ id: "p1", name: "Preset" }] },
    appTheme: { schemeId: "dark", customSchemes: [] },
  } as unknown as BootResult;
}

describe("releaseBootPayload", () => {
  beforeEach(() => {
    resetBootPromiseForTests();
    (window as unknown as { electron: unknown }).electron = {
      app: { boot: vi.fn().mockResolvedValue(makeBootResult()) },
    };
  });

  afterEach(() => {
    resetBootPromiseForTests();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it("nulls the heavy sub-objects including tabGroups/terminalSizes/draftInputs, keeping crash fields", async () => {
    const result = await getBootPromise();
    // Settle the annotate() handler so the thenable's `value` field is populated.
    await Promise.resolve();

    releaseBootPayload();

    expect(result.appState).toBeUndefined();
    expect(result.terminalConfig).toBeUndefined();
    expect(result.agentSettings).toBeUndefined();
    // User draft text must not be retained for the renderer's lifetime.
    expect(result.draftInputs).toBeUndefined();
    expect(result.tabGroups).toBeUndefined();
    expect(result.terminalSizes).toBeUndefined();
    expect(result.projectPresets).toBeUndefined();
    expect(result.appTheme).toBeUndefined();
    // Crash fields are still read from the cached payload after hydration.
    expect(result.crashPending).toBeNull();
    expect(result.crashConfig).toEqual({ autoRestoreOnCrash: true });
  });
});
