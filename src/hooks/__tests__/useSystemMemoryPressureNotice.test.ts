// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
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

/** The same singleton the freshly imported hook writes, after `vi.resetModules`. */
async function noticeStore() {
  return (await import("@/store/systemMemoryNoticeStore")).useSystemMemoryNoticeStore;
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
    eventsOnMock.mockReset();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true, result: { launched: true } });
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

  it("shows the reading as a sidebar row and never raises a grid bar (#13101)", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));

    expect(store.getState().notice).toEqual({
      reading: "Swap is 91% full and the fseventsd process is using 36 GB of memory.",
      detail:
        "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this.",
      action: null,
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    // Inbox only, uncounted: low priority with no placement never toasts or bars.
    expect(payload).toMatchObject({
      type: "warning",
      priority: "low",
      urgent: false,
      countable: false,
      title: "High system memory use",
      context: { eventKind: "host" },
    });
    expect(payload.placement).toBeUndefined();
    expect(payload.duration).toBeUndefined();
    expect(payload.supersedeKey).toEqual(expect.any(String));
    expect(payload.message).toContain("Swap is 91% full");
    expect(payload.action).toBeUndefined();
    expect(payload.actions).toBeUndefined();
  });

  it("raises nothing when no reading was over threshold", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!({ ...NORMAL, status: "degraded" }));

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("offers one agent diagnosis in a project view without changing the notice copy", async () => {
    setEligible();
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));

    const payload = notifyMock.mock.calls[0]![0];
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
    // The row offers the same launch the inbox record does.
    expect(store.getState().notice?.action).toBe(action);
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
  ])("hides the action but still shows the reading when %s", async (_label, arrange) => {
    setEligible();
    arrange();
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.type).toBe("warning");
    expect(payload.actions).toBeUndefined();
    expect(store.getState().notice?.action).toBeNull();
    expect(store.getState().notice?.reading).toContain("Swap is 91% full");
  });

  it("launches once on click and clears the row only after a successful launch", async () => {
    setEligible();
    await mountAndCapture();
    const store = await noticeStore();
    act(() => captured!(DEGRADED));
    const action = store.getState().notice!.action!;

    await act(async () => {
      await Promise.all([action.onClick(), action.onClick()]);
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("agent.launch", action.actionArgs, {
      source: "user",
    });
    expect(store.getState().notice).toBeNull();
  });

  it.each([
    ["the dispatch is refused", { ok: false, error: { code: "EXECUTION_ERROR", message: "x" } }],
    ["the launcher declines", { ok: true, result: { launched: false } }],
  ])("keeps the row when %s", async (_label, result) => {
    setEligible();
    dispatchMock.mockResolvedValue(result);
    await mountAndCapture();
    const store = await noticeStore();
    act(() => captured!(DEGRADED));
    const notice = store.getState().notice!;

    await act(async () => {
      await notice.action!.onClick();
    });

    expect(store.getState().notice).toBe(notice);
  });

  it("never clears a later episode's row when a launch outlives its own", async () => {
    setEligible();
    let resolveLaunch!: (value: unknown) => void;
    dispatchMock.mockReturnValueOnce(new Promise((resolve) => (resolveLaunch = resolve)));
    await mountAndCapture();
    const store = await noticeStore();
    act(() => captured!(DEGRADED));
    const action = store.getState().notice!.action!;

    let pending!: void | Promise<void>;
    act(() => {
      pending = action.onClick();
    });
    act(() => captured!(NORMAL));
    act(() => captured!(DEGRADED));
    const second = store.getState().notice;
    await act(async () => {
      resolveLaunch({ ok: true, result: { launched: true } });
      await pending;
    });

    expect(second).not.toBeNull();
    expect(store.getState().notice).toBe(second);
    // The second episode still owns its row, so its recovery clears it.
    act(() => captured!(NORMAL));
    expect(store.getState().notice).toBeNull();
  });

  it("does not re-raise the row within an episode after a launch cleared it", async () => {
    setEligible();
    await mountAndCapture();
    const store = await noticeStore();
    act(() => captured!(DEGRADED));

    await act(async () => {
      await store.getState().notice!.action!.onClick();
    });
    act(() => captured!(DEGRADED));

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeated degraded edge for the same episode", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));
    const first = store.getState().notice;
    act(() => captured!(DEGRADED));

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(store.getState().notice).toBe(first);
  });

  it("clears its own row on recovery and leaves a quiet resolution row", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const warning = notifyMock.mock.calls[0]![0];
    const resolution = notifyMock.mock.calls[1]![0];
    expect(resolution).toMatchObject({
      type: "success",
      priority: "low",
      urgent: false,
      countable: false,
      context: { eventKind: "host" },
    });
    expect(resolution.placement).toBeUndefined();
    // Same key, so the resolution row archives the warning's inbox row.
    expect(resolution.supersedeKey).toBe(warning.supersedeKey);
  });

  it("does nothing on recovery in a view that never raised the notice", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(NORMAL));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(store.getState().notice).toBeNull();
  });

  it("raises the notice again for a new episode after recovery", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));
    act(() => captured!(DEGRADED));

    expect(notifyMock.mock.calls.map(([p]) => p.type)).toEqual(["warning", "success", "warning"]);
    expect(store.getState().notice).not.toBeNull();
  });
});
