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
import type { DecisionsStatus } from "@shared/types/decisions";
import {
  DecisionsAgentsSection,
  decisionsAgentSupport,
  decisionsLaunchesGetAsk,
} from "../DecisionsAgentsSection";

const ORIGIN = "https://decisions.example.workers.dev";
const CONNECTED: DecisionsStatus = { state: "connected", relayOrigin: ORIGIN, revision: 3 };
const NO_RELAY: DecisionsStatus = { state: "not-connected", revision: 1 };

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

// Tests stub the store's refresh; each starts from the real one.
const REFRESH = useCliAvailabilityStore.getState().refresh;

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

/** The not-connected notice's text; null while launches get ask_human. */
function notice(): string | null {
  return screen.queryByTestId("decisions-agents-not-connected")?.textContent ?? null;
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
    useCliAvailabilityStore.setState({ refresh: REFRESH });
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
    const { container } = render(<DecisionsAgentsSection status={CONNECTED} />);

    expect(namesUnder("Get ask_human")).toEqual(namesOf(["claude", "codex"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    // Nothing to copy, run or click: an unsupported agent has no way in.
    expect(container.querySelectorAll("button, code, pre, input, a")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/gemini|decisions mcp|npx|config/i);
  });

  it("follows a plugin's agents in and out, by the launch-time MCP each declares", () => {
    setAvailability({ ...INSTALLED, "acme-agent": "ready", "acme-plain": "ready" });
    render(<DecisionsAgentsSection status={CONNECTED} />);
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
    render(<DecisionsAgentsSection status={CONNECTED} />);
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
    render(<DecisionsAgentsSection status={CONNECTED} />);

    expect(screen.queryByText("Checking which agents are installed…")).toBeNull();
    expect(screen.getByText("Couldn't check which agents are installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it("keeps a Retry that fails again to the banner, raising nothing", async () => {
    // The store records the failure and then rethrows it.
    const refresh = vi.fn(async () => {
      throw new Error("probe failed again");
    });
    useCliAvailabilityStore.setState({ refresh });
    setAvailability({}, { hasRealData: false, error: "probe failed" });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      render(<DecisionsAgentsSection status={CONNECTED} />);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refresh).toHaveBeenCalledOnce();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("treats only a running relay connection as handing launches ask_human", () => {
    const launches = (status: DecisionsStatus) => decisionsLaunchesGetAsk(status);
    for (const state of ["connecting", "connected", "reconnecting", "replaced"] as const) {
      expect(launches({ state, relayOrigin: ORIGIN })).toBe(true);
    }
    expect(launches(NO_RELAY)).toBe(false);
    for (const problem of ["keys", "storage", "other-relay"] as const) {
      expect(launches({ state: "not-connected", relayOrigin: ORIGIN, problem })).toBe(false);
    }
    expect(launches({ state: "not-connected", relayOrigin: ORIGIN })).toBe(false);
    expect(launches({ state: "revoked", relayOrigin: ORIGIN })).toBe(false);
    expect(launches({ state: "off" })).toBe(false);
  });

  it("with no relay, says launches get ask_human once one is connected and points to Connection, keeping both lists (#16203)", () => {
    setAvailability(INSTALLED);
    const { container } = render(<DecisionsAgentsSection status={NO_RELAY} />);

    expect(notice()).toMatch(/No relay.*without ask_human/);
    expect(notice()).toMatch(/Connection/);
    expect(container.textContent).toMatch(/launched while a relay is connected/);
    expect(namesUnder("Get ask_human")).toBeNull();
    expect(namesUnder("Get ask_human once connected")).toEqual(namesOf(["claude", "codex"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    expect(container.textContent).not.toMatch(/launched while Decisions is on/);
    expect(container.querySelectorAll("button, code, pre, input, a")).toHaveLength(0);
  });

  it("with a relay set up that isn't connecting, or revoked, points to Connection for why", () => {
    setAvailability(INSTALLED);
    const stopped: DecisionsStatus[] = [
      { state: "not-connected", relayOrigin: ORIGIN, problem: "keys" },
      { state: "not-connected", relayOrigin: ORIGIN, problem: "storage" },
      { state: "not-connected", relayOrigin: ORIGIN, problem: "other-relay" },
      { state: "revoked", relayOrigin: ORIGIN },
    ];
    const { rerender } = render(<DecisionsAgentsSection status={CONNECTED} />);
    for (const status of stopped) {
      rerender(<DecisionsAgentsSection status={status} />);
      expect(notice()).toMatch(/relay isn't connected.*without ask_human/);
      expect(notice()).toMatch(/Connection.*why/);
      expect(namesUnder("Get ask_human once connected")).toEqual(namesOf(["claude", "codex"]));
      expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    }
  });

  it("reads as it always has while a connection runs, between attempts included", () => {
    setAvailability(INSTALLED);
    const { container, rerender } = render(<DecisionsAgentsSection status={CONNECTED} />);
    for (const state of ["connecting", "connected", "reconnecting", "replaced"] as const) {
      rerender(<DecisionsAgentsSection status={{ state, relayOrigin: ORIGIN }} />);
      expect(notice()).toBeNull();
      expect(namesUnder("Get ask_human")).toEqual(namesOf(["claude", "codex"]));
      expect(namesUnder("Get ask_human once connected")).toBeNull();
      expect(container.textContent).toMatch(/launched while Decisions is on/);
    }
  });

  it("follows the connection as it comes and goes", () => {
    setAvailability(INSTALLED);
    const { rerender } = render(<DecisionsAgentsSection status={NO_RELAY} />);
    expect(namesUnder("Get ask_human once connected")).toEqual(namesOf(["claude", "codex"]));

    rerender(<DecisionsAgentsSection status={CONNECTED} />);
    expect(notice()).toBeNull();
    expect(namesUnder("Get ask_human")).toEqual(namesOf(["claude", "codex"]));

    rerender(<DecisionsAgentsSection status={{ state: "revoked", relayOrigin: ORIGIN }} />);
    expect(notice()).toMatch(/The relay isn't connected/);
    expect(namesUnder("Get ask_human")).toBeNull();
  });

  it("keeps the not-connected notice while the agent check is running or has failed", () => {
    setAvailability({}, { hasRealData: false });
    const { rerender } = render(<DecisionsAgentsSection status={NO_RELAY} />);
    expect(screen.getByText("Checking which agents are installed…")).toBeTruthy();
    expect(notice()).toMatch(/No relay is connected/);

    act(() => setAvailability({}, { hasRealData: false, error: "probe failed" }));
    rerender(<DecisionsAgentsSection status={NO_RELAY} />);
    expect(screen.getByText("Couldn't check which agents are installed")).toBeTruthy();
    expect(notice()).toMatch(/No relay is connected/);
  });

  it("shows nothing in a remote window, whose agents are the host's", () => {
    remote.hostName = "build-box";
    setAvailability(INSTALLED);
    const { container } = render(<DecisionsAgentsSection status={CONNECTED} />);

    expect(container.textContent).toBe("");
  });
});
