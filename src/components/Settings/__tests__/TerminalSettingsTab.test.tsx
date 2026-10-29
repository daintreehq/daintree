// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

import { TerminalSettingsTab } from "../TerminalSettingsTab";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { useLayoutConfigStore, usePerformanceModeStore, useScrollbackStore } from "@/store";
import { formatBytes } from "@/lib/formatBytes";
import {
  bytesForScrollbackLines,
  getScrollbackForType,
  PERFORMANCE_MODE_SCROLLBACK,
  SCROLLBACK_ESTIMATE_COLUMNS,
} from "@/utils/scrollbackConfig";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { useCachedProjectViewsStore } from "@/store/cachedProjectViewsStore";
import { useMemoryLeakConfigStore } from "@/store/memoryLeakConfigStore";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

const getHardwareInfo = vi.fn();
const setResourceMonitoring = vi.fn();

beforeEach(() => {
  dispatch.mockClear();
  getHardwareInfo.mockReset().mockResolvedValue(null);
  setResourceMonitoring.mockReset().mockResolvedValue(undefined);
  Reflect.set(window, "electron", {
    system: { getHardwareInfo },
    terminalConfig: {
      setResourceMonitoring,
      setMemoryLeakDetection: vi.fn().mockResolvedValue(undefined),
      setMemoryLeakAutoRestartThresholdMb: vi.fn().mockResolvedValue(undefined),
    },
  });
});

function renderSubtab(subtab: string) {
  return render(<TerminalSettingsTab activeSubtab={subtab} onSubtabChange={() => {}} />);
}

describe("TerminalSettingsTab in a window attached to another host", () => {
  beforeEach(() => {
    _resetHostPlatformForTests();
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
  });

  afterEach(() => {
    delete window.__DAINTREE_HOST_ID__;
    _resetHostPlatformForTests();
  });

  it("names this machine as the owner of scrollback", () => {
    renderSubtab("scrollback");
    expect(screen.getByText(/^New terminals · This (Mac|machine)$/)).toBeTruthy();
  });

  it("marks performance mode as this machine's inside the host's resources section", () => {
    renderSubtab("performance");
    expect(screen.getByText("On studio-01")).toBeTruthy();
    expect(screen.getByText(/Set on this (Mac|machine)\.$/)).toBeTruthy();
  });
});

describe("TerminalSettingsTab", () => {
  it("does not open the performance subtab with a section named after it", () => {
    renderSubtab("performance");
    expect(screen.getByText("Terminal resources")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Cached project views" })).toBeTruthy();
  });

  it("renders scrollback presets as one radiogroup and dispatches the chosen value", () => {
    renderSubtab("scrollback");
    const group = screen.getByRole("radiogroup", { name: "Base scrollback" });
    const radios = group.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(4);
    fireEvent.click(screen.getByRole("radio", { name: "5,000" }));
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setScrollback",
      { scrollbackLines: 5000 },
      { source: "user" }
    );
    // The memory estimate is a plain row, not an empty disclosure.
    expect(screen.getByText("Estimated scrollback memory")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  describe("scrollback memory estimate", () => {
    const initialPerformanceMode = usePerformanceModeStore.getState().performanceMode;
    const initialScrollbackLines = useScrollbackStore.getState().scrollbackLines;

    afterEach(() => {
      usePerformanceModeStore.setState({ performanceMode: initialPerformanceMode });
      useScrollbackStore.setState({ scrollbackLines: initialScrollbackLines });
    });

    function estimateDescription(): string {
      return screen.getByText(/^A typical session of/).textContent ?? "";
    }

    it("prices each terminal at the lines it keeps and names the assumed width", () => {
      usePerformanceModeStore.setState({ performanceMode: false });
      useScrollbackStore.setState({ scrollbackLines: 1000 });
      renderSubtab("scrollback");

      const text = estimateDescription();
      const agentBytes = bytesForScrollbackLines(getScrollbackForType(true, 1000)) * 8;
      const plainBytes = bytesForScrollbackLines(getScrollbackForType(false, 1000)) * 8;
      expect(text).toContain(`8 agents (${formatBytes(agentBytes)})`);
      expect(text).toContain(`8 terminals (${formatBytes(plainBytes)})`);
      expect(text).toContain(`${SCROLLBACK_ESTIMATE_COLUMNS} columns`);
    });

    it("estimates performance mode at its flat cap, not as a base to scale", () => {
      usePerformanceModeStore.setState({ performanceMode: true });
      renderSubtab("scrollback");

      const capped = formatBytes(bytesForScrollbackLines(PERFORMANCE_MODE_SCROLLBACK) * 8);
      const text = estimateDescription();
      expect(text).toContain(`8 agents (${capped})`);
      expect(text).toContain(`8 terminals (${capped})`);
    });
  });

  it("renders grid strategies as native radio rows with descriptions", () => {
    renderSubtab("layout");
    const radios = screen.getAllByRole("radio");
    const strategyRadios = radios.filter(
      (r) => r instanceof HTMLInputElement && r.name === "gridLayoutStrategy"
    );
    expect(strategyRadios).toHaveLength(3);
    fireEvent.click(strategyRadios[1]!);
    expect(dispatch).toHaveBeenCalledWith(
      "panel.gridLayout.setStrategy",
      { strategy: "fixed-columns" },
      { source: "user" }
    );
  });

  it("offers a strategy reset only while the strategy differs from Automatic", () => {
    useLayoutConfigStore.setState({ layoutConfig: { strategy: "automatic", value: 3 } });
    const { unmount } = renderSubtab("layout");
    expect(
      screen.queryByRole("button", { name: "Reset grid layout strategy to default" })
    ).toBeNull();
    unmount();

    useLayoutConfigStore.setState({ layoutConfig: { strategy: "fixed-rows", value: 3 } });
    renderSubtab("layout");
    fireEvent.click(screen.getByRole("button", { name: "Reset grid layout strategy to default" }));
    expect(dispatch).toHaveBeenCalledWith(
      "panel.gridLayout.setStrategy",
      { strategy: "automatic" },
      { source: "user" }
    );
    useLayoutConfigStore.setState({ layoutConfig: { strategy: "automatic", value: 3 } });
  });

  it("renders screen reader mode as a segmented choice", () => {
    renderSubtab("accessibility");
    expect(screen.getByRole("radiogroup", { name: "Screen reader mode" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "On" }));
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setScreenReaderMode",
      { mode: "on" },
      { source: "user" }
    );
  });
});

describe("TerminalSettingsTab save failures", () => {
  it("shows a retryable error on the group and clears it once the save succeeds", async () => {
    dispatch.mockResolvedValueOnce({ ok: false, error: { message: "disk full" } });
    renderSubtab("accessibility");
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "On" }));
    });
    expect(screen.getByText("Couldn't save that change")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(dispatch).toHaveBeenLastCalledWith(
      "terminalConfig.setScreenReaderMode",
      { mode: "on" },
      { source: "user" }
    );
    expect(screen.queryByText("Couldn't save that change")).toBeNull();
  });

  it("rolls resource monitoring back when its IPC write fails", async () => {
    useResourceMonitoringStore.setState({ enabled: false });
    setResourceMonitoring.mockRejectedValueOnce(new Error("IPC down"));
    renderSubtab("performance");
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Resource Monitoring Toggle" }));
    });
    expect(useResourceMonitoringStore.getState().enabled).toBe(false);
    expect(screen.getByText("Couldn't save that change")).toBeTruthy();
  });

  it("replays the store update on Retry so a saved value is also the displayed one", async () => {
    useResourceMonitoringStore.setState({ enabled: false });
    setResourceMonitoring.mockRejectedValueOnce(new Error("IPC down"));
    renderSubtab("performance");
    const toggle = screen.getByRole("switch", { name: "Resource Monitoring Toggle" });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(useResourceMonitoringStore.getState().enabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(setResourceMonitoring).toHaveBeenLastCalledWith(true);
    expect(useResourceMonitoringStore.getState().enabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Couldn't save that change")).toBeNull();
  });
});

describe("TerminalSettingsTab cached project views", () => {
  const resetName = /Reset cached project views/i;

  it("marks a count off the RAM tier and resets it to the tier through the action", async () => {
    // 16 GiB sits on the 3-view tier.
    getHardwareInfo.mockResolvedValue({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 });
    useCachedProjectViewsStore.setState({ cachedProjectViews: 5 });
    renderSubtab("performance");
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: resetName }));
    });
    expect(dispatch).toHaveBeenCalledWith(
      "terminalConfig.setCachedProjectViews",
      { cachedProjectViews: 3 },
      { source: "user" }
    );
  });

  it("claims no difference while the count matches the tier or the hardware is unknown", async () => {
    getHardwareInfo.mockResolvedValue({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 });
    useCachedProjectViewsStore.setState({ cachedProjectViews: 3 });
    const { unmount } = renderSubtab("performance");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: resetName })).toBeNull();
    unmount();

    getHardwareInfo.mockRejectedValue(new Error("probe failed"));
    useCachedProjectViewsStore.setState({ cachedProjectViews: 5 });
    renderSubtab("performance");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: resetName })).toBeNull();
  });
});

describe("TerminalSettingsTab panel limits", () => {
  it("marks each limit that differs from the hardware recommendation and resets it alone", async () => {
    // 16 GB recommends soft 16, confirm 30, hard 48.
    getHardwareInfo.mockResolvedValue({
      totalMemoryBytes: 16 * 1024 ** 3,
      logicalCpuCount: 8,
    });
    usePanelLimitStore.setState({
      softWarningLimit: 20,
      confirmationLimit: 30,
      hardLimit: 48,
      warningsDisabled: false,
      hardwareDefaultsApplied: true,
    });
    renderSubtab("performance");
    await act(async () => {});

    expect(
      screen.queryByRole("button", {
        name: "Reset confirmation limit to the hardware-recommended value",
      })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset hard limit to the hardware-recommended value" })
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset soft warning to the hardware-recommended value" })
    );
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(16);
    expect(
      screen.getByRole("button", { name: "Reset to hardware-recommended defaults" })
    ).toBeTruthy();
  });
});

describe("TerminalSettingsTab panel limit editing", () => {
  const field = (name: string) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;

  beforeEach(() => {
    usePanelLimitStore.setState({
      softWarningLimit: 12,
      confirmationLimit: 20,
      hardLimit: 32,
      warningsDisabled: false,
      hardwareDefaultsApplied: true,
    });
  });

  it("lets a two-digit number be typed without clamping the first digit", () => {
    renderSubtab("performance");
    const soft = field("Soft warning");

    fireEvent.change(soft, { target: { value: "2" } });
    expect(soft.value).toBe("2");
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(12);

    fireEvent.change(soft, { target: { value: "20" } });
    expect(soft.value).toBe("20");

    fireEvent.blur(soft);
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(20);
    expect(soft.value).toBe("20");
  });

  it("lets a field be cleared and typed afresh", () => {
    renderSubtab("performance");
    const hard = field("Hard limit");

    fireEvent.change(hard, { target: { value: "" } });
    expect(hard.value).toBe("");

    fireEvent.change(hard, { target: { value: "50" } });
    fireEvent.blur(hard);
    expect(usePanelLimitStore.getState().hardLimit).toBe(50);
  });

  it.each([
    ["Soft warning", "softWarningLimit", 12, 10],
    ["Confirmation required", "confirmationLimit", 20, 25],
    ["Hard limit", "hardLimit", 32, 50],
  ] as const)("commits %s on Enter", (name, key, before, typed) => {
    renderSubtab("performance");
    const input = field(name);

    fireEvent.change(input, { target: { value: String(typed) } });
    expect(usePanelLimitStore.getState()[key]).toBe(before);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(usePanelLimitStore.getState()[key]).toBe(typed);
  });

  it("corrects an out-of-range number when it is committed, not while typing", () => {
    renderSubtab("performance");
    const hard = field("Hard limit");

    fireEvent.change(hard, { target: { value: "500" } });
    expect(hard.value).toBe("500");
    expect(usePanelLimitStore.getState().hardLimit).toBe(32);

    fireEvent.blur(hard);
    expect(usePanelLimitStore.getState().hardLimit).toBe(100);
    expect(hard.value).toBe("100");
  });

  it("puts the stored number back when an empty field is committed", () => {
    renderSubtab("performance");
    const soft = field("Soft warning");

    fireEvent.change(soft, { target: { value: "" } });
    fireEvent.blur(soft);
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(12);
    expect(soft.value).toBe("12");
  });

  it.each([
    [
      "Soft warning",
      "softWarningLimit",
      "Reset soft warning to the hardware-recommended value",
      16,
    ],
    [
      "Confirmation required",
      "confirmationLimit",
      "Reset confirmation limit to the hardware-recommended value",
      30,
    ],
    ["Hard limit", "hardLimit", "Reset hard limit to the hardware-recommended value", 48],
  ] as const)(
    "resets %s over a draft to the recommended number",
    async (name, key, button, rec) => {
      getHardwareInfo.mockResolvedValue({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 });
      renderSubtab("performance");
      await act(async () => {});
      const input = field(name);

      fireEvent.change(input, { target: { value: "7" } });
      fireEvent.click(screen.getByRole("button", { name: button }));

      expect(usePanelLimitStore.getState()[key]).toBe(rec);
      expect(input.value).toBe(String(rec));
    }
  );

  it("corrects a number below the minimum on commit and ignores a decimal", () => {
    renderSubtab("performance");
    const soft = field("Soft warning");

    fireEvent.change(soft, { target: { value: "1" } });
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(12);
    fireEvent.blur(soft);
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(4);
    expect(soft.value).toBe("4");

    fireEvent.change(soft, { target: { value: "9.5" } });
    fireEvent.blur(soft);
    expect(usePanelLimitStore.getState().softWarningLimit).toBe(4);
    expect(soft.value).toBe("4");
  });

  it("keeps a half-typed number in one field when another is committed", () => {
    renderSubtab("performance");
    const soft = field("Soft warning");
    const hard = field("Hard limit");

    fireEvent.change(soft, { target: { value: "1" } });
    fireEvent.change(hard, { target: { value: "50" } });
    fireEvent.blur(hard);

    expect(usePanelLimitStore.getState().hardLimit).toBe(50);
    expect(soft.value).toBe("1");
  });

  // The second start is already on the recommendation: the reset then changes no
  // stored number, so only dropping the drafts can bring the fields back to it.
  it.each([
    [
      "away from the recommendation",
      { softWarningLimit: 12, confirmationLimit: 20, hardLimit: 32 },
    ],
    ["on the recommendation", { softWarningLimit: 16, confirmationLimit: 30, hardLimit: 48 }],
  ] as const)(
    "applies the hardware-recommended limits over a draft, starting %s",
    async (_, start) => {
      getHardwareInfo.mockResolvedValue({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpuCount: 8 });
      usePanelLimitStore.setState(start);
      renderSubtab("performance");
      await act(async () => {});

      fireEvent.change(field("Soft warning"), { target: { value: "7" } });
      fireEvent.change(field("Confirmation required"), { target: { value: "8" } });
      fireEvent.change(field("Hard limit"), { target: { value: "9" } });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Reset to hardware-recommended defaults" })
        );
      });

      expect(usePanelLimitStore.getState()).toMatchObject({
        softWarningLimit: 16,
        confirmationLimit: 30,
        hardLimit: 48,
      });
      expect(field("Soft warning").value).toBe("16");
      expect(field("Confirmation required").value).toBe("30");
      expect(field("Hard limit").value).toBe("48");

      fireEvent.blur(field("Soft warning"));
      expect(usePanelLimitStore.getState().softWarningLimit).toBe(16);
    }
  );

  describe("limits out of order", () => {
    it("points out a warning above the hard limit without refusing it", () => {
      renderSubtab("performance");
      const soft = field("Soft warning");

      fireEvent.change(soft, { target: { value: "40" } });
      expect(screen.queryByText(/never appears/i)).toBeNull();
      fireEvent.blur(soft);

      expect(usePanelLimitStore.getState().softWarningLimit).toBe(40);
      expect(screen.getByText(/hard limit of 32, so this warning never appears/i)).toBeTruthy();
      expect(soft.getAttribute("aria-invalid")).toBe("true");
      expect(field("Confirmation required").getAttribute("aria-invalid")).not.toBe("true");
    });

    it("points out a confirmation at the hard limit, but not one slot below it", () => {
      renderSubtab("performance");
      const confirm = field("Confirmation required");

      fireEvent.change(confirm, { target: { value: "31" } });
      fireEvent.blur(confirm);
      expect(confirm.getAttribute("aria-invalid")).not.toBe("true");

      fireEvent.change(confirm, { target: { value: "32" } });
      fireEvent.blur(confirm);
      expect(usePanelLimitStore.getState().confirmationLimit).toBe(32);
      expect(confirm.getAttribute("aria-invalid")).toBe("true");
      expect(
        screen.getByText(/hard limit of 32, so batches are never asked to confirm/i)
      ).toBeTruthy();
    });

    it("re-evaluates both rows when the hard limit moves, and clears them once ordered", () => {
      renderSubtab("performance");
      const hard = field("Hard limit");

      fireEvent.change(hard, { target: { value: "10" } });
      fireEvent.blur(hard);
      expect(field("Soft warning").getAttribute("aria-invalid")).toBe("true");
      expect(field("Confirmation required").getAttribute("aria-invalid")).toBe("true");

      fireEvent.change(hard, { target: { value: "60" } });
      fireEvent.blur(hard);
      expect(field("Soft warning").getAttribute("aria-invalid")).not.toBe("true");
      expect(field("Confirmation required").getAttribute("aria-invalid")).not.toBe("true");
    });

    it("points out a configuration that was already saved out of order", () => {
      usePanelLimitStore.setState({ softWarningLimit: 50, confirmationLimit: 60, hardLimit: 32 });
      renderSubtab("performance");

      expect(field("Soft warning").getAttribute("aria-invalid")).toBe("true");
      expect(field("Confirmation required").getAttribute("aria-invalid")).toBe("true");
    });

    it("stays quiet while panel warnings are off", () => {
      usePanelLimitStore.setState({
        softWarningLimit: 50,
        confirmationLimit: 60,
        warningsDisabled: true,
      });
      renderSubtab("performance");

      expect(screen.queryByText(/never appears/i)).toBeNull();
      expect(screen.queryByText(/never asked to confirm/i)).toBeNull();
    });
  });
});

describe("TerminalSettingsTab auto-restart threshold", () => {
  it("keeps an out-of-range draft out of the store and puts the effective value back on blur", () => {
    useResourceMonitoringStore.getState().setEnabled(true);
    useMemoryLeakConfigStore.getState().setEnabled(true);
    const effective = useMemoryLeakConfigStore.getState().autoRestartThresholdMb;
    renderSubtab("performance");
    const input = screen.getByRole("spinbutton", {
      name: "Auto-restart threshold",
    }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: String(Math.floor(effective / 10)) } });

    expect(useMemoryLeakConfigStore.getState().autoRestartThresholdMb).toBe(effective);
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.blur(input);
    expect(input.value).toBe(String(effective));
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });
});

describe("TerminalSettingsTab worktree split ratios", () => {
  it("clears at once and offers an Undo that puts every ratio back", () => {
    mockNotify.mockClear();
    const split = useTwoPaneSplitStore.getState();
    split.resetAllWorktreeRatios();
    split.setWorktreeRatio("wt-a", 0.3, ["p1", "p2"]);
    split.setWorktreeRatio("wt-b", 0.7, ["p3", "p4"]);
    const before = useTwoPaneSplitStore.getState().ratioByWorktreeId;
    renderSubtab("layout");

    fireEvent.click(screen.getByRole("button", { name: "Reset all worktree split ratios" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toEqual({});
    const payload = mockNotify.mock.calls[0]![0] as {
      action: { label: string; onClick: () => void };
    };
    expect(payload.action.label).toBe("Undo");

    // A ratio set after the reset outranks the one Undo brings back.
    useTwoPaneSplitStore.getState().setWorktreeRatio("wt-b", 0.6, ["p3", "p4"]);
    act(() => payload.action.onClick());
    expect(useTwoPaneSplitStore.getState().ratioByWorktreeId).toEqual({
      ...before,
      "wt-b": { ratio: 0.6, panels: ["p3", "p4"] },
    });
  });
});
