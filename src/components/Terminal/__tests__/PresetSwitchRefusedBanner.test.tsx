// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const recovery = vi.hoisted(() => ({
  startNewAfterRefusedSwitch: vi.fn().mockResolvedValue({ success: true }),
  returnAfterRefusedSwitch: vi.fn().mockResolvedValue("launched"),
  dismissRefusedPresetSwitch: vi.fn(),
}));
vi.mock("@/services/terminal/agentEndRecovery", () => recovery);

import {
  PresetSwitchRefusedBanner,
  buildPresetSwitchRefusedCopy,
} from "../PresetSwitchRefusedBanner";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { PresetSwitchResume, PtyPanelData } from "@shared/types/panel";

const attempt: PresetSwitchResume = {
  agentId: "codex",
  sessionId: "thread-1",
  presetId: "company",
  prior: { agentPresetId: "personal", cwd: "/repo" },
};

function seed(presetSwitchResume: PresetSwitchResume | undefined): void {
  useAgentSettingsStore.setState({
    settings: {
      agents: {
        codex: {
          customPresets: [
            { id: "personal", name: "Personal" },
            { id: "company", name: "Company" },
          ],
        },
      },
    },
  });
  const pane: PtyPanelData = {
    id: "t1",
    kind: "terminal",
    title: "Codex",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "codex",
    agentPresetId: "company",
    presetSwitchResume,
  };
  usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("PresetSwitchRefusedBanner (#16045)", () => {
  it("stays out of the way until the CLI refused", () => {
    seed(attempt);
    render(<PresetSwitchRefusedBanner panelId="t1" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names both presets and offers both ways out", async () => {
    seed({ ...attempt, refused: true });
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    expect(screen.getByText("Codex couldn't find this conversation on Company")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to Personal" }));
    });
    expect(recovery.returnAfterRefusedSwitch).toHaveBeenCalledWith("t1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start new on Company" }));
    });
    expect(recovery.startNewAfterRefusedSwitch).toHaveBeenCalledWith("t1");
  });

  it("takes one choice at a time", async () => {
    let finish: (value: string) => void = () => {};
    recovery.returnAfterRefusedSwitch.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve))
    );
    seed({ ...attempt, refused: true });
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    const back = screen.getByRole("button", { name: "Back to Personal" });
    const startNew = screen.getByRole("button", { name: "Start new on Company" });
    act(() => {
      fireEvent.click(back);
    });
    act(() => {
      fireEvent.click(back);
      fireEvent.click(startNew);
    });

    expect(recovery.returnAfterRefusedSwitch).toHaveBeenCalledTimes(1);
    expect(recovery.startNewAfterRefusedSwitch).not.toHaveBeenCalled();
    await act(async () => {
      finish("launched");
    });
  });

  it("drops the way back when another pane holds the conversation", async () => {
    recovery.returnAfterRefusedSwitch.mockResolvedValueOnce("held-elsewhere");
    seed({ ...attempt, refused: true });
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to Personal" }));
    });

    expect(screen.queryByRole("button", { name: "Back to Personal" })).toBeNull();
    expect(screen.getByText(/Another pane has this conversation open/)).toBeTruthy();
  });

  it("goes back to a launch that had no preset without naming one", () => {
    const copy = buildPresetSwitchRefusedCopy({
      agentName: "Codex",
      presetName: "Company",
      priorPresetName: undefined,
    });
    expect(copy.backLabel).toBe("Go back");
    expect(copy.description).not.toContain("undefined");
  });
});
