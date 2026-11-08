// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentConfig, AgentInstallOS } from "@shared/config/agentRegistry";
import { config as antigravity } from "@shared/config/agents/antigravity";

const installOS = vi.hoisted(() => ({ current: "linux" as AgentInstallOS }));
// The window's grid, if it has one: null leaves install commands copy-only.
const runner = vi.hoisted(() => ({ current: null as null | ReturnType<typeof vi.fn> }));

vi.mock("@/hooks/terminal/useInstallCommandRunner", () => ({
  useInstallCommandRunner: () => runner.current,
}));
vi.mock("@/clients", () => ({
  systemClient: { openExternal: vi.fn(() => Promise.resolve()) },
}));

// jsdom reports no platform, so the test names the OS; the blocks are the
// registry's own for that OS.
vi.mock("@/lib/agentInstall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentInstall")>()),
  detectOS: () => installOS.current,
  getInstallBlocksForCurrentOS: (agent: AgentConfig) =>
    agent.install?.byOs?.[installOS.current] ?? null,
}));

vi.mock("@/store", () => ({
  useAgentSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ updateAgent: vi.fn(), settings: { agents: {} } }),
}));

import { AgentCliStep } from "../AgentCliStep";

function renderStep() {
  return render(
    <TooltipProvider>
      <AgentCliStep availability={{ antigravity: "missing" }} selections={{ antigravity: true }} />
    </TooltipProvider>
  );
}

function expectCopyOnly(commands: readonly string[]) {
  expect(commands.length).toBeGreaterThan(0);
  expect(screen.queryByTestId("agent-cli-install-primary")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  expect(screen.getByText("Manual")).toBeTruthy();
  for (const command of commands) {
    expect(screen.getAllByText(command).length).toBeGreaterThan(0);
  }
}

// The agy installers all need a shell, so Agent Setup shows them to copy and
// never offers to run them (#15622).
describe("Agent Setup for Antigravity", () => {
  beforeEach(() => {
    runner.current = null;
  });

  it("opens the install script in a terminal where the window has a grid", () => {
    installOS.current = "linux";
    runner.current = vi.fn();
    renderStep();

    fireEvent.click(screen.getByLabelText("Open command in a new terminal"));

    expect(runner.current).toHaveBeenCalledWith(
      antigravity.install?.byOs?.linux?.[0]?.commands?.[0],
      { kind: "agent", agentId: "antigravity" }
    );
    // Still never the shell-less installer.
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  });

  it.each(["macos", "linux"] as const)("shows the %s install script to copy", (os) => {
    installOS.current = os;
    renderStep();

    expectCopyOnly(antigravity.install?.byOs?.[os]?.[0]?.commands ?? []);
  });

  it("keeps every Windows method copy-only, whichever is picked", async () => {
    installOS.current = "windows";
    const blocks = antigravity.install?.byOs?.windows ?? [];
    expect(blocks.length).toBeGreaterThan(1);
    renderStep();

    for (const [index, block] of blocks.entries()) {
      await act(async () => {
        fireEvent.click(screen.getByTestId(`install-method-antigravity-${index}`));
      });
      expectCopyOnly(block.commands ?? []);
    }
  });
});
