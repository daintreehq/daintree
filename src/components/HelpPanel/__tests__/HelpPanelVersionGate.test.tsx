// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getAgentConfig } from "@/config/agents";
import type { VersionTooOld } from "@/controllers/HelpSessionController";
import { HelpPanelVersionGate } from "../HelpPanelVersionGate";

const CLAUDE: VersionTooOld = {
  agentId: "claude",
  agentName: "Claude",
  installedVersion: "2.0.14",
  requiredVersion: "2.1.0",
};

const OPENCODE: VersionTooOld = {
  agentId: "opencode",
  agentName: "OpenCode",
  installedVersion: "0.15.3",
  requiredVersion: "1.0.0",
};

function renderGate(
  versionTooOld: VersionTooOld,
  overrides: Partial<{ isCheckingVersion: boolean; onCheckAgain: () => void }> = {}
) {
  const props = {
    versionTooOld,
    onOpenSettings: () => {},
    onCheckAgain: overrides.onCheckAgain ?? (() => {}),
    isCheckingVersion: overrides.isCheckingVersion ?? false,
  };
  const utils = render(
    <TooltipProvider>
      <HelpPanelVersionGate {...props} />
    </TooltipProvider>
  );
  return {
    ...utils,
    setChecking: (isCheckingVersion: boolean) =>
      utils.rerender(
        <TooltipProvider>
          <HelpPanelVersionGate {...props} isCheckingVersion={isCheckingVersion} />
        </TooltipProvider>
      ),
  };
}

describe("HelpPanelVersionGate", () => {
  it("names the agent in a heading and states both versions", () => {
    renderGate(CLAUDE);
    expect(screen.getByRole("heading", { name: "Update Claude" })).toBeTruthy();
    const gate = screen.getByTestId("help-version-too-old");
    expect(gate.textContent).toContain("2.1.0");
    expect(gate.textContent).toContain("2.0.14");
  });

  it("shows every update command the registry carries for the agent, so the fix is on screen", () => {
    for (const block of [CLAUDE, OPENCODE]) {
      const { unmount } = renderGate(block);
      const gate = screen.getByTestId("help-version-too-old");
      const commands = Object.values(getAgentConfig(block.agentId)?.update ?? {});
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(gate.textContent).toContain(command);
      expect(screen.getAllByRole("button", { name: /copy command/i })).toHaveLength(
        commands.length
      );
      unmount();
    }
  });

  it("offers no action that claims to update the CLI itself", () => {
    renderGate(CLAUDE);
    expect(screen.queryByRole("button", { name: /^update/i })).toBeNull();
  });

  it("keeps Check again focusable while a check runs, and ignores presses", () => {
    const onCheckAgain = vi.fn();
    const { setChecking } = renderGate(CLAUDE, { onCheckAgain });
    const button = screen.getByRole("button", { name: /check again/i });
    button.focus();
    fireEvent.click(button);
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
    setChecking(true);
    const busy = screen.getByRole("button", { name: /check again/i });
    expect(busy).toBe(button);
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it("reports a check that settles with the gate still up", () => {
    const { setChecking } = renderGate(CLAUDE);
    const status = () => screen.getByRole("status");
    expect(status().textContent).toBe("");
    setChecking(true);
    expect(status().textContent).toContain("Checking");
    setChecking(false);
    expect(status().textContent).toBe("No newer version found");
  });
});
