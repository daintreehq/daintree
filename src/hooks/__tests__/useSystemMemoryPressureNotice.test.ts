// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const removeNotificationMock = vi.fn();
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({ removeNotification: removeNotificationMock }),
  },
}));

let mac = true;
vi.mock("@/lib/platform", () => ({
  isMac: () => mac,
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

let viewWorkspaceId: string | null = "project-1";
vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => viewWorkspaceId,
}));

let projectState: { projects: unknown[]; currentProject: unknown } = {
  projects: [],
  currentProject: null,
};
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));

let scratchState: { scratches: unknown[]; currentScratch: unknown } = {
  scratches: [],
  currentScratch: null,
};
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => scratchState },
}));

let cliState: { availability: Record<string, unknown>; hasRealData: boolean } = {
  availability: {},
  hasRealData: true,
};
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: () => cliState },
}));

let defaultAgent: string | undefined = "claude";
vi.mock("@/store/agentPreferencesStore", () => ({
  useAgentPreferencesStore: { getState: () => ({ defaultAgent }) },
}));

const PROJECT = { id: "project-1", name: "App", path: "/work/app" };
const SCRATCH = { id: "scratch-1", name: "Scratch", path: "/scratch/1" };

function setEligible() {
  viewWorkspaceId = "project-1";
  projectState = { projects: [PROJECT], currentProject: PROJECT };
  scratchState = { scratches: [], currentScratch: null };
  cliState = { availability: { claude: "ready" }, hasRealData: true };
  defaultAgent = "claude";
}

const eventsOnMock = vi.fn();
let captured: ((payload: SystemMemoryPressurePayload) => void) | null = null;

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: 36 * 1024,
  kernelPressureLevel: null,
};
const NORMAL: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
};

function load() {
  return import("../useSystemMemoryPressureNotice");
}

async function mountAndCapture() {
  const mod = await load();
  renderHook(() => mod.useSystemMemoryPressureNotice());
  return mod;
}

describe("formatSystemMemoryPressureMessage", () => {
  it("states each measurement over threshold and the restart note, nothing else", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(formatSystemMemoryPressureMessage(DEGRADED, true)).toBe(
      "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this."
    );
    expect(formatSystemMemoryPressureMessage({ ...DEGRADED, swapUsedPercent: null }, true)).toBe(
      "The fseventsd process is using 36 GB of memory. Restarting your Mac clears this."
    );
    expect(
      formatSystemMemoryPressureMessage({ ...DEGRADED, fseventsdRssMb: 8.4 * 1024 }, true)
    ).toContain("using 8.4 GB of memory");
  });

  it("labels a Windows figure as commit and names a generic computer off macOS", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(
      formatSystemMemoryPressureMessage(
        { ...DEGRADED, swapKind: "commit", fseventsdRssMb: null },
        false
      )
    ).toBe("Committed memory is at 91% of its limit. Restarting your computer clears this.");
  });

  it("states the kernel's reported level first, without the restart note when alone (#12799)", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(
      formatSystemMemoryPressureMessage(
        { ...NORMAL, status: "degraded", kernelPressureLevel: "critical" },
        true
      )
    ).toBe("macOS reports memory pressure at its critical level.");
    expect(
      formatSystemMemoryPressureMessage(
        { ...DEGRADED, fseventsdRssMb: null, kernelPressureLevel: "warn" },
        true
      )
    ).toBe(
      "macOS reports memory pressure at its warning level and swap is 91% full. Restarting your Mac clears this."
    );
  });

  it("returns null when no figure was over threshold", async () => {
    const { formatSystemMemoryPressureMessage } = await load();
    expect(formatSystemMemoryPressureMessage(NORMAL, true)).toBeNull();
  });
});

describe("buildSystemMemoryDiagnosisPrompt", () => {
  it("asks why, dates the readings, and keeps the investigation read-only", async () => {
    const { buildSystemMemoryDiagnosisPrompt } = await load();

    const prompt = buildSystemMemoryDiagnosisPrompt(DEGRADED, "Sep 29, 2026, 9:14 AM", true)!;

    expect(prompt.startsWith("Why is my system under memory pressure?")).toBe(true);
    expect(prompt).toContain(
      "at Sep 29, 2026, 9:14 AM. Swap is 91% full and the fseventsd process is using 36 GB of memory."
    );
    expect(prompt).toContain("check the current state first");
    expect(prompt).toContain("If the pressure has already cleared, say so.");
    expect(prompt).toContain("vm_stat");
    expect(prompt).not.toMatch(/[`\n]/);
    expect(prompt).toContain("without asking me first");
    // The restart advice is the notice's, not a reading for the agent to act on.
    expect(prompt).not.toContain("Restarting");
  });

  it("keeps commit wording and drops the macOS commands off macOS", async () => {
    const { buildSystemMemoryDiagnosisPrompt } = await load();

    const prompt = buildSystemMemoryDiagnosisPrompt(
      { ...DEGRADED, swapKind: "commit", fseventsdRssMb: null },
      "noon",
      false
    )!;

    expect(prompt).toContain("Committed memory is at 91% of its limit.");
    expect(prompt).not.toContain("vm_stat");
    expect(prompt).toContain("your platform's read-only memory and process tools");
  });

  it("returns null when no figure was over threshold", async () => {
    const { buildSystemMemoryDiagnosisPrompt } = await load();
    expect(buildSystemMemoryDiagnosisPrompt(NORMAL, "noon", true)).toBeNull();
  });
});

describe("useSystemMemoryPressureNotice", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notice-1");
    removeNotificationMock.mockReset();
    eventsOnMock.mockReset();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, result: {} });
    setEligible();
    viewWorkspaceId = null;
    projectState = { projects: [], currentProject: null };
    mac = true;
    captured = null;
    eventsOnMock.mockImplementation(
      (name: string, cb: (payload: SystemMemoryPressurePayload) => void) => {
        if (name === "system:memory-pressure") captured = cb;
        return vi.fn();
      }
    );
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { events: { on: eventsOnMock } },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useSystemMemoryPressureNotice } = await load();

    const first = renderHook(() => useSystemMemoryPressureNotice());
    first.unmount();
    renderHook(() => useSystemMemoryPressureNotice());

    expect(eventsOnMock).toHaveBeenCalledTimes(1);
    expect(eventsOnMock).toHaveBeenCalledWith("system:memory-pressure", expect.any(Function));
  });

  it("raises one quiet, dismissible grid-bar warning with no action outside a workspace", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload).toMatchObject({
      type: "warning",
      priority: "low",
      urgent: false,
      placement: "grid-bar",
      duration: 0,
      context: { eventKind: "host" },
    });
    expect(payload.supersedeKey).toEqual(expect.any(String));
    expect(payload.message).toContain("Swap is 91% full");
    expect(payload.action).toBeUndefined();
    expect(payload.actions).toBeUndefined();
  });

  it("offers one agent diagnosis in a project view without changing the notice copy", async () => {
    setEligible();
    await mountAndCapture();

    act(() => captured!(DEGRADED));

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.title).toBe("High system memory use");
    expect(payload.message).toBe(
      "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this."
    );
    expect(payload.actions).toHaveLength(1);
    const [action] = payload.actions;
    expect(action).toMatchObject({
      label: "Ask agent about memory",
      actionId: "agent.launch",
      actionArgs: {
        agentId: "claude",
        name: "Memory pressure",
        prompt: expect.stringContaining("Why is my system under memory pressure?"),
      },
    });
    expect(action.actionArgs.prompt).toContain("Swap is 91% full");
    expect(Object.keys(action.actionArgs).sort()).toEqual(["agentId", "name", "prompt"]);
    // Offered, never launched on its own.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("offers it in a Scratch view, where there is no current project", async () => {
    setEligible();
    viewWorkspaceId = "scratch-1";
    projectState = { projects: [PROJECT], currentProject: null };
    scratchState = { scratches: [SCRATCH], currentScratch: SCRATCH };
    await mountAndCapture();

    act(() => captured!(DEGRADED));

    expect(notifyMock.mock.calls[0]![0].actions).toHaveLength(1);
  });

  it.each([
    [
      "the view's project is closed",
      () => {
        projectState = {
          projects: [{ ...PROJECT, status: "closed" }],
          currentProject: null,
        };
      },
    ],
    ["the view names no known workspace", () => (viewWorkspaceId = "gone")],
    [
      "no agent CLI is launchable",
      () => (cliState = { availability: { claude: "missing" }, hasRealData: true }),
    ],
    [
      "CLI availability has not been probed yet",
      () => (cliState = { availability: { claude: "ready" }, hasRealData: false }),
    ],
  ])("hides the action but still warns when %s", async (_label, arrange) => {
    setEligible();
    arrange();
    await mountAndCapture();

    act(() => captured!(DEGRADED));

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("warning");
    expect(payload.actions).toBeUndefined();
  });

  it("launches once on click and clears the live bar only after a successful launch", async () => {
    setEligible();
    await mountAndCapture();
    act(() => captured!(DEGRADED));
    const [action] = notifyMock.mock.calls[0]![0].actions;

    await act(async () => {
      await Promise.all([action.onClick(), action.onClick()]);
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("agent.launch", action.actionArgs, {
      source: "user",
    });
    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
  });

  it("keeps the bar when the launch is refused", async () => {
    setEligible();
    dispatchMock.mockResolvedValue({ ok: false, error: { code: "EXECUTION_ERROR", message: "x" } });
    await mountAndCapture();
    act(() => captured!(DEGRADED));
    const [action] = notifyMock.mock.calls[0]![0].actions;

    await act(async () => {
      await action.onClick();
    });

    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("ignores a repeated degraded edge for the same episode", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(DEGRADED));

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("clears its own notice on recovery and leaves a low-priority resolution row", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const warning = notifyMock.mock.calls[0]![0];
    const resolution = notifyMock.mock.calls[1]![0];
    expect(resolution).toMatchObject({
      type: "success",
      priority: "low",
      context: { eventKind: "host" },
    });
    // Same key, so the resolution row archives the warning's inbox row.
    expect(resolution.supersedeKey).toBe(warning.supersedeKey);
  });

  it("does nothing on recovery in a view that never raised the notice", async () => {
    await mountAndCapture();

    act(() => captured!(NORMAL));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("still resolves the inbox row when quiet hours kept the bar from showing", async () => {
    notifyMock.mockReturnValueOnce("");
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

    expect(removeNotificationMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("raises the notice again for a new episode after recovery", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));
    act(() => captured!(DEGRADED));

    expect(notifyMock.mock.calls.map(([p]) => p.type)).toEqual(["warning", "success", "warning"]);
  });
});
