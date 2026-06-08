// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { AutomationTab } from "../AutomationTab";

vi.mock("@/components/Settings/SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

function renderAutomationTab() {
  return render(
    <AutomationTab
      currentProject={undefined}
      runCommands={[]}
      onRunCommandsChange={vi.fn()}
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
