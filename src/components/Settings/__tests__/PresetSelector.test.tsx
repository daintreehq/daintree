// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PresetSelector } from "../PresetSelector";
import type { AgentPreset } from "@/config/agents";

vi.mock("lucide-react", () => ({
  ChevronDown: () => <span data-testid="chevron-icon" />,
  Check: () => <span data-testid="check-icon" />,
}));

// Render Popover children inline for test visibility — we're asserting on the
// listbox markup, not on portal/focus-trap mechanics.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mkPreset = (id: string, name: string, color?: string): AgentPreset =>
  ({
    id,
    name,
    color,
  }) as AgentPreset;

describe("PresetSelector", () => {
  let onChange: ReturnType<typeof vi.fn<(presetId: string | undefined) => void>>;

  beforeEach(() => {
    onChange = vi.fn<(presetId: string | undefined) => void>();
  });

  it("trigger label shows the agent-default copy when no preset selected", () => {
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[]}
        ccrPresets={[]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(getByTestId("preset-selector-trigger").textContent).toContain("Default");
  });

  it("trigger shows the stripped CCR name (without 'CCR:' prefix) when a CCR preset is selected", () => {
    const ccr = mkPreset("ccr-opus", "CCR: Opus");
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId="ccr-opus"
        allPresets={[ccr]}
        ccrPresets={[ccr]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    const label = getByTestId("preset-selector-trigger").textContent ?? "";
    expect(label).toContain("Opus");
    expect(label).not.toContain("CCR:"); // prefix is stripped in the visible label
    expect(label).toContain("CCR"); // but the "CCR" badge is present
  });

  it("renders a group label for each non-empty category (Settings is explicit-management context)", () => {
    const ccr = mkPreset("ccr-a", "CCR: A");
    const custom = mkPreset("user-b", "B");
    const { queryByTestId, rerender } = render(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[ccr]}
        ccrPresets={[ccr]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    // Only CCR group present → show CCR label but no Custom label.
    expect(queryByTestId("preset-group-ccr-routes")).toBeTruthy();
    expect(queryByTestId("preset-group-custom")).toBeNull();

    rerender(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[ccr, custom]}
        ccrPresets={[ccr]}
        customPresets={[custom]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(queryByTestId("preset-group-ccr-routes")).toBeTruthy();
    expect(queryByTestId("preset-group-custom")).toBeTruthy();
  });

  it("selecting a custom preset invokes onChange with its id", () => {
    const custom = mkPreset("user-x", "X", "#123456");
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[custom]}
        ccrPresets={[]}
        customPresets={[custom]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    fireEvent.click(getByTestId("preset-option-user-x"));
    expect(onChange).toHaveBeenCalledWith("user-x");
  });

  it("selecting Default invokes onChange with undefined", () => {
    const custom = mkPreset("user-x", "X");
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId="user-x"
        allPresets={[custom]}
        ccrPresets={[]}
        customPresets={[custom]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    fireEvent.click(getByTestId("preset-option-default"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("options announce aria-selected on the currently selected preset", () => {
    const custom = mkPreset("user-x", "X");
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId="user-x"
        allPresets={[custom]}
        ccrPresets={[]}
        customPresets={[custom]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(getByTestId("preset-option-user-x").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("preset-option-default").getAttribute("aria-selected")).toBe("false");
  });

  it("renders 'Project Shared' group and badge when project presets are present", () => {
    const project = mkPreset("team-opus", "Team Opus");
    const { getByTestId, queryByTestId } = render(
      <PresetSelector
        selectedPresetId="team-opus"
        allPresets={[project]}
        ccrPresets={[]}
        projectPresets={[project]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(queryByTestId("preset-group-project-shared")).toBeTruthy();
    expect(getByTestId("preset-selector-trigger").textContent).toContain("Project");
    expect(getByTestId("preset-option-project-team-opus")).toBeTruthy();
  });

  it("project preset with a ccr- prefixed id still renders as Project, not CCR", () => {
    // Regression guard: without a membership-first source classification,
    // a project preset authored with id `ccr-team` would get stolen by the
    // CCR badge/group path and appear under "CCR Routes".
    const project = mkPreset("ccr-team", "Team Route");
    const { getByTestId, queryByTestId } = render(
      <PresetSelector
        selectedPresetId="ccr-team"
        allPresets={[project]}
        ccrPresets={[]}
        projectPresets={[project]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(queryByTestId("preset-group-project-shared")).toBeTruthy();
    expect(queryByTestId("preset-group-ccr-routes")).toBeNull();
    const triggerText = getByTestId("preset-selector-trigger").textContent ?? "";
    expect(triggerText).toContain("Project");
    expect(triggerText).not.toContain("CCR");
  });

  it("project group is absent when projectPresets is empty", () => {
    const { queryByTestId } = render(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[]}
        ccrPresets={[]}
        projectPresets={[]}
        customPresets={[]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    expect(queryByTestId("preset-group-project-shared")).toBeNull();
  });

  it("keyboard Enter on an option invokes onChange", () => {
    const custom = mkPreset("user-x", "X");
    const { getByTestId } = render(
      <PresetSelector
        selectedPresetId={undefined}
        allPresets={[custom]}
        ccrPresets={[]}
        customPresets={[custom]}
        onChange={onChange}
        agentColor="#888"
      />
    );
    fireEvent.keyDown(getByTestId("preset-option-user-x"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("user-x");
  });
});
