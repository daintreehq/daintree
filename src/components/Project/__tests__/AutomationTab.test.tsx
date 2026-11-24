// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RunCommand } from "@/types";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";
import { AutomationTab } from "../AutomationTab";

vi.mock("@/components/Settings/SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

function automationTab(
  runCommands: RunCommand[],
  onRunCommandsChange: (commands: RunCommand[]) => void
) {
  return (
    <AutomationTab
      currentProject={undefined}
      runCommands={runCommands}
      onRunCommandsChange={onRunCommandsChange}
      branchPrefixMode="none"
      onBranchPrefixModeChange={vi.fn()}
      branchPrefixCustom=""
      onBranchPrefixCustomChange={vi.fn()}
      worktreePathPattern=""
      onWorktreePathPatternChange={vi.fn()}
      terminalShell={undefined}
      onTerminalShellChange={vi.fn()}
      onTerminalShellReset={vi.fn()}
      terminalShellArgs={undefined}
      onTerminalShellArgsChange={vi.fn()}
      onTerminalShellArgsReset={vi.fn()}
      terminalDefaultCwd={undefined}
      onTerminalDefaultCwdChange={vi.fn()}
      onTerminalDefaultCwdReset={vi.fn()}
      terminalScrollback={undefined}
      onTerminalScrollbackChange={vi.fn()}
      onTerminalScrollbackReset={vi.fn()}
    />
  );
}

function renderAutomationTab() {
  return render(automationTab([], vi.fn()));
}

describe("AutomationTab — DOM anchors for settings deep-links", () => {
  it("exposes the project-run-commands anchor for settings deep-links", () => {
    const { container } = renderAutomationTab();
    expect(container.querySelector("#project-run-commands")).not.toBeNull();
  });

  it("exposes the project-branch-prefix anchor for settings deep-links", () => {
    const { container } = renderAutomationTab();
    expect(container.querySelector("#project-branch-prefix")).not.toBeNull();
  });

  it("exposes the project-terminal-settings anchor for settings deep-links", () => {
    const { container } = renderAutomationTab();
    expect(container.querySelector("#project-terminal-settings")).not.toBeNull();
  });
});

describe("AutomationTab — run command reordering", () => {
  afterEach(() => _resetTooltipFocusSuppressionForTests());

  let drawn: string[] = [];
  function Harness({ names }: { names: string[] }) {
    const [runCommands, setRunCommands] = useState<RunCommand[]>(() =>
      names.map((name) => ({ id: `cmd-${name}`, name, command: `npm run ${name}` }))
    );
    drawn = runCommands.map((c) => c.name);
    return automationTab(runCommands, setRunCommands);
  }

  // A keyboard Enter or Space on a focused button is a click with no pointer behind it.
  const press = async (button: HTMLElement) => {
    act(() => button.focus());
    await act(async () => {
      fireEvent.click(button);
    });
  };
  const focusedButton = () => document.activeElement as HTMLButtonElement;

  it("keeps focus on the command it moved into the first position", async () => {
    render(<Harness names={["build", "test", "deploy"]} />);
    await press(screen.getByRole("button", { name: "Move test up" }));
    expect(drawn).toEqual(["test", "build", "deploy"]);
    expect(focusedButton().getAttribute("aria-label")).toBe("Move test up");
    expect(focusedButton().disabled).toBe(false);
    expect(focusedButton().getAttribute("aria-disabled")).toBe("true");
    // Pressing again at the top moves nothing and keeps focus where it is.
    await press(focusedButton());
    expect(drawn).toEqual(["test", "build", "deploy"]);
    expect(focusedButton().getAttribute("aria-label")).toBe("Move test up");
  });

  it("keeps focus on the command it moved into the last position", async () => {
    render(<Harness names={["build", "test", "deploy"]} />);
    await press(screen.getByRole("button", { name: "Move test down" }));
    expect(drawn).toEqual(["build", "deploy", "test"]);
    expect(focusedButton().getAttribute("aria-label")).toBe("Move test down");
    expect(focusedButton().disabled).toBe(false);
    expect(focusedButton().getAttribute("aria-disabled")).toBe("true");
    await press(focusedButton());
    expect(drawn).toEqual(["build", "deploy", "test"]);
  });

  // React restores a keyed row's focus across its own relocation, so only an
  // activation that never focused the arrow shows the moved command is followed.
  it.each([
    ["Move test up", ["test", "build", "deploy"]],
    ["Move test down", ["build", "deploy", "test"]],
  ])("follows the command after %s from a click that left focus elsewhere", async (name, order) => {
    render(<Harness names={["build", "test", "deploy"]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }), { detail: 1 });
    });
    expect(drawn).toEqual(order);
    expect(focusedButton().getAttribute("aria-label")).toBe(name);
  });

  it.each([
    ["Move test up", "Move up"],
    ["Move test down", "Move down"],
    ["Remove test", "Remove"],
  ])("names the %s icon button in a tooltip", async (name, tooltip) => {
    render(<Harness names={["build", "test", "deploy"]} />);
    act(() => screen.getByRole("button", { name }).focus());
    const tip = await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 });
    expect(tip.textContent).toBe(tooltip);
  });
});
