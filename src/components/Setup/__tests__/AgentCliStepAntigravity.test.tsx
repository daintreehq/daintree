// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentConfig, AgentInstallOS } from "@shared/config/agentRegistry";
import { config as antigravity } from "@shared/config/agents/antigravity";

const installOS = vi.hoisted(() => ({ current: "linux" as AgentInstallOS }));

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
