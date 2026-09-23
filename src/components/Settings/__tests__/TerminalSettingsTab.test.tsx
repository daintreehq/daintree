// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

import { TerminalSettingsTab } from "../TerminalSettingsTab";
import { useLayoutConfigStore } from "@/store";
import { useResourceMonitoringStore } from "@/store/resourceMonitoringStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";

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
    expect(screen.getByText("Estimated memory")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
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

  it("states how agent and shell limits derive from the base", () => {
    renderSubtab("scrollback");
    expect(screen.getByText(/agent terminals keep 10× it/)).toBeTruthy();
    expect(screen.getByText("Agent terminals")).toBeTruthy();
    expect(screen.getByText("Shells and dev servers")).toBeTruthy();
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
