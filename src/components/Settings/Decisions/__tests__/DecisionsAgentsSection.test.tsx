// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const remote = vi.hoisted(() => ({ hostName: null as string | null }));
vi.mock("@/hooks/useSettingsOwner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSettingsOwner")>()),
  useRemoteHostName: () => remote.hostName,
}));

import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { getAgentConfig, getAgentIds } from "@/config/agents";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
  unregisterPluginAgents,
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

const ACME = {
  id: "acme-agent",
  name: "Acme Agent",
  command: "acme",
  color: "#3366ff",
  iconId: "terminal",
  launchMcp: { format: "claude-mcp-config" as const },
};
const PLAIN = {
  id: "acme-plain",
  name: "Acme Plain",
  command: "plain",
  color: "#3366ff",
  iconId: "terminal",
};

function setAvailability(
  availability: CliAvailability,
  { hasRealData = true, error = null as string | null } = {}
) {
  useCliAvailabilityStore.setState({ availability, hasRealData, error });
}

function nameOf(id: string): string {
  return getAgentConfig(id)?.name ?? id;
}

/** The names of `ids`, in the registry's order, which is the list's. */
function namesOf(ids: readonly string[]): string[] {
  return getAgentIds()
    .filter((id) => ids.includes(id))
    .map(nameOf);
}

/** The agent names listed under a group's label, in order; null when there is no such group. */
function namesUnder(label: string): string[] | null {
  const heading = screen.queryByText(label);
  if (heading === null) return null;
  return [...heading.parentElement!.querySelectorAll("[id^='decisions-agent-']")].map(
    (row) => row.textContent?.trim() ?? ""
  );
}

describe("DecisionsAgentsSection (#16012)", () => {
  beforeEach(() => {
    clearPluginAgentRegistryForTests();
    remote.hostName = null;
  });

  afterEach(() => {
    cleanup();
    clearPluginAgentRegistryForTests();
    setAvailability({}, { hasRealData: false });
  });

  it("splits installed agents by whether a launch hands them ask_human, leaving out the missing and the unknown", () => {
    const { supported, unsupported } = decisionsAgentSupport(
      ["claude", "codex", "cursor", "grok", "gemini", "not-registered"],
      { ...INSTALLED, "not-registered": "ready" }
    );

    expect(supported).toEqual(["claude", "codex"]);
    expect(unsupported).toEqual(["cursor", "grok"]);
  });

  it("lists exactly the installed agents that get ask_human and the ones not supported yet, with nothing to set up", () => {
    setAvailability(INSTALLED);
    const { container } = render(<DecisionsAgentsSection />);

    expect(namesUnder("Get ask_human")).toEqual(namesOf(["claude", "codex"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    // Nothing to copy, run or click: an unsupported agent has no way in.
    expect(container.querySelectorAll("button, code, pre, input, a")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/gemini|decisions mcp|npx|config/i);
  });

  it("follows a plugin's agents in and out, by the launch-time MCP each declares", () => {
    setAvailability({ ...INSTALLED, "acme-agent": "ready", "acme-plain": "ready" });
    render(<DecisionsAgentsSection />);
    expect(screen.queryByText("Acme Agent")).toBeNull();

    act(() => registerPluginAgents("acme.agents", [ACME, PLAIN]));
    expect(namesUnder("Get ask_human")).toEqual(namesOf(["claude", "codex", "acme-agent"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok", "acme-plain"]));

    // A reload that drops its launch-time MCP moves it; an unload removes both.
    act(() => registerPluginAgents("acme.agents", [{ ...ACME, launchMcp: undefined }, PLAIN]));
    expect(namesUnder("Get ask_human")).not.toContain("Acme Agent");
    expect(namesUnder("Not supported yet")).toContain("Acme Agent");
    act(() => unregisterPluginAgents("acme.agents"));
    expect(screen.queryByText("Acme Agent")).toBeNull();
    expect(screen.queryByText("Acme Plain")).toBeNull();
  });

  it("says it is still checking before the first result, and follows the store once one lands", () => {
    setAvailability({}, { hasRealData: false });
    render(<DecisionsAgentsSection />);
    expect(screen.getByText("Checking which agents are installed…")).toBeTruthy();

    act(() => setAvailability({ claude: "missing" }));
    expect(screen.getByText(/No agent CLIs found\. Install one/)).toBeTruthy();
    expect(namesUnder("Get ask_human")).toBeNull();

    act(() => setAvailability({ claude: "ready" }));
    expect(namesUnder("Get ask_human")).toEqual([nameOf("claude")]);
  });

  it("shows a failed check with Retry rather than checking forever", () => {
    const refresh = vi.fn(async () => {});
    useCliAvailabilityStore.setState({ refresh });
    setAvailability({}, { hasRealData: false, error: "probe failed" });
    render(<DecisionsAgentsSection />);

    expect(screen.queryByText("Checking which agents are installed…")).toBeNull();
    expect(screen.getByText("Couldn't check which agents are installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it("shows nothing in a remote window, whose agents are the host's", () => {
    remote.hostName = "build-box";
    setAvailability(INSTALLED);
    const { container } = render(<DecisionsAgentsSection />);

    expect(container.textContent).toBe("");
  });
});
