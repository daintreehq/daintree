// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "@shared/config/pluginAgentRegistry";
import type { CliAvailability } from "@shared/types";
import { DecisionsAgentsSection, decisionsAgentSupport } from "../DecisionsAgentsSection";

const INSTALLED: CliAvailability = {
  claude: "ready",
  codex: "unauthenticated",
  cursor: "installed",
  grok: "blocked",
  gemini: "missing",
};

function setAvailability(availability: CliAvailability, hasRealData = true) {
  useCliAvailabilityStore.setState({ availability, hasRealData });
}

/** The agent names listed under a group's label, in order. */
function namesUnder(label: string): string[] {
  const heading = screen.getByText(label);
  const group = heading.parentElement!;
  return [...group.querySelectorAll("[id^='decisions-agent-']")].map(
    (row) => row.textContent?.trim() ?? ""
  );
}

describe("DecisionsAgentsSection (#16012)", () => {
  beforeEach(() => {
    clearPluginAgentRegistryForTests();
  });

  afterEach(() => {
    cleanup();
    clearPluginAgentRegistryForTests();
    setAvailability({}, false);
  });

  it("splits installed agents by whether a launch hands them ask_human, leaving out the missing", () => {
    const { supported, unsupported } = decisionsAgentSupport(
      ["claude", "codex", "cursor", "grok", "gemini", "not-registered"],
      INSTALLED
    );

    expect(supported).toEqual(["claude", "codex"]);
    expect(unsupported).toEqual(["cursor", "grok"]);
  });

  it("lists the installed agents that get ask_human and the ones not supported yet, with no setup to offer", () => {
    setAvailability(INSTALLED);
    const { container } = render(<DecisionsAgentsSection />);

    expect(namesUnder("Get ask_human")).toEqual(expect.arrayContaining(["Claude", "Codex"]));
    const unsupported = namesUnder("Not supported yet");
    expect(unsupported).toHaveLength(2);
    expect(unsupported.some((name) => /cursor/i.test(name))).toBe(true);
    expect(container.textContent).not.toMatch(/gemini/i);
    // Nothing to copy, run or click: an unsupported agent has no way in.
    expect(container.querySelectorAll("button, code, pre, input")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/decisions mcp/i);
  });

  it("follows a plugin's agents in and out, by the launch-time MCP each declares", () => {
    setAvailability({ ...INSTALLED, "acme-agent": "ready", "acme-plain": "ready" });
    render(<DecisionsAgentsSection />);
    expect(screen.queryByText("Acme Agent")).toBeNull();

    act(() => {
      registerPluginAgents("acme.agents", [
        {
          id: "acme-agent",
          name: "Acme Agent",
          command: "acme",
          color: "#3366ff",
          iconId: "terminal",
          launchMcp: { format: "claude-mcp-config" },
        },
        { id: "acme-plain", name: "Acme Plain", command: "plain", color: "#3366ff" },
      ]);
    });

    expect(namesUnder("Get ask_human")).toContain("Acme Agent");
    expect(namesUnder("Not supported yet")).toContain("Acme Plain");
  });

  it("says it is still checking before the first availability result, and names the next step once none is found", () => {
    setAvailability({}, false);
    const { rerender } = render(<DecisionsAgentsSection />);
    expect(screen.getByText("Checking which agents are installed…")).toBeTruthy();

    act(() => setAvailability({ claude: "missing" }));
    rerender(<DecisionsAgentsSection />);
    expect(screen.getByText(/No agent CLIs found\. Install one/)).toBeTruthy();
    expect(screen.queryByText("Get ask_human")).toBeNull();
  });
});
