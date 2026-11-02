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
  target: { kind: "preset", presetId: "company" },
  prior: { agentPresetId: "personal", cwd: "/repo" },
};

function seed(
  presetSwitchResume: PresetSwitchResume | undefined,
  pane: Partial<PtyPanelData> = {}
): void {
  useAgentSettingsStore.setState({
    settings: {
      agents: {
        codex: {
          customPresets: [
            { id: "personal", name: "Personal" },
            { id: "company", name: "Company" },
          ],
          accounts: [
            { id: "work", name: "Work login", configDir: "/home/me/.codex-work" },
            { id: "side", name: "Side login", configDir: "/home/me/.codex-side" },
          ],
        },
      },
    },
  });
  const seeded: PtyPanelData = {
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
    ...pane,
  };
  usePanelStore.setState({ panelsById: { t1: seeded }, panelIds: ["t1"] });
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
      targetName: "Company",
      priorName: undefined,
    });
    expect(copy.backLabel).toBe("Go back");
    expect(copy.description).not.toContain("undefined");
  });
});

describe("PresetSwitchRefusedBanner on an account switch (#16135)", () => {
  const accountAttempt: PresetSwitchResume = {
    agentId: "codex",
    sessionId: "thread-1",
    target: { kind: "account", accountId: "work" },
    // The preset stays; only the account moved.
    prior: { agentPresetId: "company", agentAccountId: "side", cwd: "/repo" },
  };

  it("names both accounts, not the preset the pane kept", async () => {
    seed({ ...accountAttempt, refused: true }, { agentAccountId: "work" });
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    expect(screen.getByText("Codex couldn't find this conversation on Work login")).toBeTruthy();
    expect(screen.queryByText(/Company/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to Side login" }));
    });
    expect(recovery.returnAfterRefusedSwitch).toHaveBeenCalledWith("t1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start new on Work login" }));
    });
    expect(recovery.startNewAfterRefusedSwitch).toHaveBeenCalledWith("t1");
  });

  it("names the default login on either side", () => {
    seed(
      {
        ...accountAttempt,
        target: { kind: "account", accountId: null },
        prior: { agentPresetId: "company", agentAccountId: "side", cwd: "/repo" },
        refused: true,
      },
      { agentAccountId: undefined }
    );
    const view = render(<PresetSwitchRefusedBanner panelId="t1" />);
    expect(screen.getByRole("button", { name: "Start new on the default login" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Side login" })).toBeTruthy();
    view.unmount();

    seed(
      { ...accountAttempt, prior: { agentPresetId: "company", cwd: "/repo" }, refused: true },
      { agentAccountId: "work" }
    );
    render(<PresetSwitchRefusedBanner panelId="t1" />);
    expect(screen.getByRole("button", { name: "Back to the default login" })).toBeTruthy();
  });

  it("goes back without a name when the account it left has been removed", () => {
    seed(
      {
        ...accountAttempt,
        prior: { agentPresetId: "company", agentAccountId: "removed", cwd: "/repo" },
        refused: true,
      },
      { agentAccountId: "work" }
    );
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
    expect(screen.queryByText(/removed/)).toBeNull();
  });

  it("drops Start new and points back when a new conversation can't start there", async () => {
    recovery.startNewAfterRefusedSwitch.mockResolvedValueOnce({
      success: false,
      error: "Codex has no account 'work'",
    });
    seed({ ...accountAttempt, refused: true }, { agentAccountId: "work" });
    render(<PresetSwitchRefusedBanner panelId="t1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start new on Work login" }));
    });

    expect(screen.queryByRole("button", { name: "Start new on Work login" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to Side login" })).toBeTruthy();
    expect(
      screen.getByText(
        "A new conversation couldn't start on Work login. Go back to Side login to carry on with this one."
      )
    ).toBeTruthy();
  });
});
