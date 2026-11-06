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
import type {
  DecisionsPolicy,
  DecisionsStatus,
  SetDecisionsAgentAskHumanPayload,
} from "@shared/types/decisions";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DecisionsAgentsSection,
  decisionsAgentSupport,
  decisionsLaunchesGetAsk,
} from "../DecisionsAgentsSection";
import { useDecisionsPolicy } from "../useDecisionsPolicy";

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

function policy(overrides: Partial<DecisionsPolicy> = {}): DecisionsPolicy {
  return {
    gates: [],
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: 1,
    maxQuestionExpiryMs: 2,
    askHumanAgents: [],
    revision: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const getPolicy = vi.fn<() => Promise<DecisionsPolicy>>();
const setAgentAskHuman =
  vi.fn<(payload: SetDecisionsAgentAskHumanPayload) => Promise<DecisionsPolicy>>();
const statusListeners = new Set<() => void>();

/** Main's status push, which another window's change sends. */
async function statusPushed() {
  await act(async () => {
    for (const listener of [...statusListeners]) listener();
  });
}

/** The section as the Decisions tab renders it, fed by the tab's one policy read. */
function Section({ status, active = true }: { status: DecisionsStatus; active?: boolean }) {
  const read = useDecisionsPolicy(active);
  return (
    <TooltipProvider>
      <DecisionsAgentsSection status={status} policy={read} />
    </TooltipProvider>
  );
}

async function renderSection(status: DecisionsStatus) {
  const view = render(<Section status={status} />);
  await act(async () => {});
  return view;
}

function agentSwitch(id: string): HTMLButtonElement {
  return screen.getByRole("switch", { name: `ask_human for ${nameOf(id)}` }) as HTMLButtonElement;
}

function isOn(id: string): boolean {
  return agentSwitch(id).getAttribute("aria-checked") === "true";
}

/** Every control inside the group under `label`. */
function controlsUnder(label: string): Element[] {
  const group = screen.getByText(label).parentElement!;
  return [...group.querySelectorAll("button, code, pre, input, a")];
}

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
    getPolicy.mockReset();
    getPolicy.mockResolvedValue(policy());
    setAgentAskHuman.mockReset();
    statusListeners.clear();
    Object.defineProperty(window, "electron", {
      value: {
        decisions: { getPolicy, setAgentAskHuman },
        events: {
          on: (name: string, listener: () => void) => {
            if (name !== "decisions:status-changed") return () => {};
            statusListeners.add(listener);
            return () => statusListeners.delete(listener);
          },
        },
      },
      configurable: true,
      writable: true,
    });
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

  it("lists the installed agents that can get ask_human, each with a switch, and the ones not supported yet without one", async () => {
    setAvailability(INSTALLED);
    const { container } = await renderSection(CONNECTED);

    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    expect(controlsUnder("Supported").map((control) => control.getAttribute("role"))).toEqual([
      "switch",
      "switch",
    ]);
    // Nothing to copy, run or click: an unsupported agent has no way in.
    expect(controlsUnder("Not supported yet")).toEqual([]);
    expect(container.textContent).not.toMatch(/gemini|decisions mcp|npx|config/i);
  });

  it("follows a plugin's agents in and out, by the launch-time MCP each declares", () => {
    setAvailability({ ...INSTALLED, "acme-agent": "ready", "acme-plain": "ready" });
    render(<Section status={CONNECTED} />);
    expect(screen.queryByText("Acme Agent")).toBeNull();

    act(() => registerPluginAgents("acme.agents", [ACME, PLAIN]));
    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex", "acme-agent"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok", "acme-plain"]));

    // A reload that drops its launch-time MCP moves it; an unload removes both.
    act(() => registerPluginAgents("acme.agents", [{ ...ACME, launchMcp: undefined }, PLAIN]));
    expect(namesUnder("Supported")).not.toContain("Acme Agent");
    expect(namesUnder("Not supported yet")).toContain("Acme Agent");
    act(() => unregisterPluginAgents("acme.agents"));
    expect(screen.queryByText("Acme Agent")).toBeNull();
    expect(screen.queryByText("Acme Plain")).toBeNull();
  });

  it("says it is still checking before the first result, and follows the store once one lands", () => {
    setAvailability({}, { hasRealData: false });
    render(<Section status={CONNECTED} />);
    expect(screen.getByText("Checking which agents are installed…")).toBeTruthy();

    act(() => setAvailability({ claude: "missing" }));
    expect(screen.getByText(/No agent CLIs found\. Install one/)).toBeTruthy();
    expect(namesUnder("Supported")).toBeNull();

    act(() => setAvailability({ claude: "ready" }));
    expect(namesUnder("Supported")).toEqual([nameOf("claude")]);
  });

  it("shows a failed check with Retry rather than checking forever", () => {
    const refresh = vi.fn(async () => {});
    useCliAvailabilityStore.setState({ refresh });
    setAvailability({}, { hasRealData: false, error: "probe failed" });
    render(<Section status={CONNECTED} />);

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
      render(<Section status={CONNECTED} />);
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
    const { container } = render(<Section status={NO_RELAY} />);

    expect(notice()).toMatch(/No relay.*without ask_human/);
    expect(notice()).toMatch(/Connection/);
    expect(container.textContent).toMatch(
      /switch on can ask you with ask_human once a relay is connected/
    );
    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));
    expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    expect(controlsUnder("Not supported yet")).toEqual([]);
  });

  it("with a relay set up that isn't connecting, or revoked, points to Connection for why", () => {
    setAvailability(INSTALLED);
    const stopped: DecisionsStatus[] = [
      { state: "not-connected", relayOrigin: ORIGIN, problem: "keys" },
      { state: "not-connected", relayOrigin: ORIGIN, problem: "storage" },
      { state: "not-connected", relayOrigin: ORIGIN, problem: "other-relay" },
      { state: "revoked", relayOrigin: ORIGIN },
    ];
    const { rerender } = render(<Section status={CONNECTED} />);
    for (const status of stopped) {
      rerender(<Section status={status} />);
      expect(notice()).toMatch(/relay isn't connected.*without ask_human/);
      expect(notice()).toMatch(/Connection.*why/);
      expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));
      expect(namesUnder("Not supported yet")).toEqual(namesOf(["cursor", "grok"]));
    }
  });

  it("reads as it always has while a connection runs, between attempts included", () => {
    setAvailability(INSTALLED);
    const { container, rerender } = render(<Section status={CONNECTED} />);
    for (const state of ["connecting", "connected", "reconnecting", "replaced"] as const) {
      rerender(<Section status={{ state, relayOrigin: ORIGIN }} />);
      expect(notice()).toBeNull();
      expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));
      expect(container.textContent).not.toMatch(/once a relay is connected/);
    }
  });

  it("follows the connection as it comes and goes", () => {
    setAvailability(INSTALLED);
    const { rerender } = render(<Section status={NO_RELAY} />);
    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));

    rerender(<Section status={CONNECTED} />);
    expect(notice()).toBeNull();
    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));

    rerender(<Section status={{ state: "revoked", relayOrigin: ORIGIN }} />);
    expect(notice()).toMatch(/The relay isn't connected/);
    expect(namesUnder("Supported")).toEqual(namesOf(["claude", "codex"]));
  });

  it("keeps the not-connected notice while the agent check is running or has failed", () => {
    setAvailability({}, { hasRealData: false });
    const { rerender } = render(<Section status={NO_RELAY} />);
    expect(screen.getByText("Checking which agents are installed…")).toBeTruthy();
    expect(notice()).toMatch(/No relay is connected/);

    act(() => setAvailability({}, { hasRealData: false, error: "probe failed" }));
    rerender(<Section status={NO_RELAY} />);
    expect(screen.getByText("Couldn't check which agents are installed")).toBeTruthy();
    expect(notice()).toMatch(/No relay is connected/);
  });

  describe("switching an agent's ask_human (#16223)", () => {
    it("starts every agent off, and shows the ones main holds switched on", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      expect([isOn("claude"), isOn("codex")]).toEqual([false, false]);
      cleanup();

      getPolicy.mockResolvedValue(policy({ askHumanAgents: ["codex", "not-installed"] }));
      await renderSection(CONNECTED);
      expect([isOn("claude"), isOn("codex")]).toEqual([false, true]);
      // On is the one change from the default, and only it can be reset.
      expect(
        screen.queryByRole("button", { name: `Switch off ask_human for ${nameOf("claude")}` })
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: `Switch off ask_human for ${nameOf("codex")}` })
      ).toBeTruthy();
    });

    it("keeps the switches still until the policy has loaded, and a failed read offers Retry", async () => {
      setAvailability(INSTALLED);
      const read = deferred<DecisionsPolicy>();
      getPolicy.mockReturnValueOnce(read.promise);
      render(<Section status={CONNECTED} />);
      expect(agentSwitch("claude").disabled).toBe(true);
      fireEvent.click(agentSwitch("claude"));
      expect(setAgentAskHuman).not.toHaveBeenCalled();

      await act(async () => read.reject(new Error("read failed")));
      expect(screen.getByText("Couldn't read which agents can ask you")).toBeTruthy();
      getPolicy.mockResolvedValueOnce(policy({ askHumanAgents: ["claude"] }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(screen.queryByText("Couldn't read which agents can ask you")).toBeNull();
      expect(agentSwitch("claude").disabled).toBe(false);
      expect(isOn("claude")).toBe(true);
    });

    it("switches one agent at a time, showing what was asked while main saves it", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      const save = deferred<DecisionsPolicy>();
      setAgentAskHuman.mockReturnValueOnce(save.promise);

      fireEvent.click(agentSwitch("claude"));
      expect(setAgentAskHuman).toHaveBeenCalledExactlyOnceWith({
        agentId: "claude",
        enabled: true,
      });
      expect(isOn("claude")).toBe(true);
      expect(agentSwitch("claude").disabled).toBe(true);
      // Another agent isn't held up by it.
      expect(agentSwitch("codex").disabled).toBe(false);

      await act(async () => save.resolve(policy({ askHumanAgents: ["claude"], revision: 1 })));
      expect(isOn("claude")).toBe(true);
      expect(agentSwitch("claude").disabled).toBe(false);

      setAgentAskHuman.mockResolvedValueOnce(policy({ askHumanAgents: [], revision: 2 }));
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: `Switch off ask_human for ${nameOf("claude")}` })
        );
      });
      expect(setAgentAskHuman).toHaveBeenLastCalledWith({ agentId: "claude", enabled: false });
      expect(isOn("claude")).toBe(false);
    });

    it("shows a failed save with Retry, and the switch goes back to what main holds", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      setAgentAskHuman.mockRejectedValueOnce(new Error("store refused"));

      await act(async () => {
        fireEvent.click(agentSwitch("codex"));
      });
      expect(screen.getByText(`Couldn't switch on ask_human for ${nameOf("codex")}`)).toBeTruthy();
      expect(screen.getByText("store refused")).toBeTruthy();
      expect(isOn("codex")).toBe(false);

      setAgentAskHuman.mockResolvedValueOnce(policy({ askHumanAgents: ["codex"], revision: 1 }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(setAgentAskHuman).toHaveBeenLastCalledWith({ agentId: "codex", enabled: true });
      expect(screen.queryByText(`Couldn't switch on ask_human for ${nameOf("codex")}`)).toBeNull();
      expect(isOn("codex")).toBe(true);
    });

    it("saves two agents at once, whatever order main answers in, and asks once per row", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      const claude = deferred<DecisionsPolicy>();
      const codex = deferred<DecisionsPolicy>();
      setAgentAskHuman.mockReturnValueOnce(claude.promise).mockReturnValueOnce(codex.promise);

      // Two clicks on one row before it re-renders ask main once.
      act(() => {
        fireEvent.click(agentSwitch("claude"));
        fireEvent.click(agentSwitch("claude"));
      });
      fireEvent.click(agentSwitch("codex"));
      expect(setAgentAskHuman.mock.calls).toEqual([
        [{ agentId: "claude", enabled: true }],
        [{ agentId: "codex", enabled: true }],
      ]);
      expect([isOn("claude"), isOn("codex")]).toEqual([true, true]);
      expect([agentSwitch("claude").disabled, agentSwitch("codex").disabled]).toEqual([true, true]);

      // Main saved them in turn; the later answer lands first, and the earlier can't roll it back.
      await act(async () =>
        codex.resolve(policy({ askHumanAgents: ["claude", "codex"], revision: 2 }))
      );
      expect([isOn("claude"), isOn("codex")]).toEqual([true, true]);
      expect(agentSwitch("claude").disabled).toBe(true);
      await act(async () => claude.resolve(policy({ askHumanAgents: ["claude"], revision: 1 })));
      expect([isOn("claude"), isOn("codex")]).toEqual([true, true]);
      expect([agentSwitch("claude").disabled, agentSwitch("codex").disabled]).toEqual([
        false,
        false,
      ]);
    });

    it("keeps each agent's failed save until that agent is saved again", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      const claudeFailed = `Couldn't switch on ask_human for ${nameOf("claude")}`;
      const codexFailed = `Couldn't switch on ask_human for ${nameOf("codex")}`;
      setAgentAskHuman
        .mockRejectedValueOnce(new Error("claude refused"))
        .mockRejectedValueOnce(new Error("codex refused"));
      await act(async () => {
        fireEvent.click(agentSwitch("claude"));
        fireEvent.click(agentSwitch("codex"));
      });
      expect([screen.queryByText(claudeFailed), screen.queryByText(codexFailed)]).not.toContain(
        null
      );
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);

      // Saving Codex again clears only its own failure.
      setAgentAskHuman.mockResolvedValueOnce(policy({ askHumanAgents: ["codex"], revision: 1 }));
      await act(async () => {
        fireEvent.click(agentSwitch("codex"));
      });
      expect(screen.queryByText(codexFailed)).toBeNull();
      expect(screen.getByText(claudeFailed)).toBeTruthy();

      setAgentAskHuman.mockResolvedValueOnce(
        policy({ askHumanAgents: ["codex", "claude"], revision: 2 })
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      });
      expect(setAgentAskHuman).toHaveBeenLastCalledWith({ agentId: "claude", enabled: true });
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect([isOn("claude"), isOn("codex")]).toEqual([true, true]);
    });

    it("shows what main holds after a failed save, as read again", async () => {
      setAvailability(INSTALLED);
      await renderSection(CONNECTED);
      const reread = deferred<DecisionsPolicy>();
      getPolicy.mockReturnValueOnce(reread.promise);
      setAgentAskHuman.mockRejectedValueOnce(new Error("store refused"));

      await act(async () => {
        fireEvent.click(agentSwitch("claude"));
      });
      expect(agentSwitch("claude").disabled).toBe(false);
      // Another window switched Codex on meanwhile; the read after the failure shows it.
      await act(async () => reread.resolve(policy({ askHumanAgents: ["codex"], revision: 1 })));
      expect([isOn("claude"), isOn("codex")]).toEqual([false, true]);
    });

    it("lets a row go when Decisions turns off mid-save, and turning on starts from main's answer", async () => {
      setAvailability(INSTALLED);
      const view = await renderSection(CONNECTED);
      const save = deferred<DecisionsPolicy>();
      setAgentAskHuman.mockReturnValueOnce(save.promise);
      fireEvent.click(agentSwitch("claude"));
      expect(agentSwitch("claude").disabled).toBe(true);

      view.rerender(<Section status={CONNECTED} active={false} />);
      view.rerender(<Section status={CONNECTED} />);
      await act(async () => {});
      expect(agentSwitch("claude").disabled).toBe(false);
      expect(isOn("claude")).toBe(false);

      // The old save landing later neither shows its answer nor frees a newer save's row.
      const again = deferred<DecisionsPolicy>();
      setAgentAskHuman.mockReturnValueOnce(again.promise);
      fireEvent.click(agentSwitch("claude"));
      await act(async () => save.resolve(policy({ askHumanAgents: ["codex"], revision: 9 })));
      expect(isOn("codex")).toBe(false);
      expect(agentSwitch("claude").disabled).toBe(true);
      await act(async () => again.resolve(policy({ askHumanAgents: ["claude"], revision: 1 })));
      expect(agentSwitch("claude").disabled).toBe(false);
      expect(isOn("claude")).toBe(true);
    });

    it("drops a save that fails after Decisions turned off and on again, reading nothing for it", async () => {
      setAvailability(INSTALLED);
      const view = await renderSection(CONNECTED);
      const save = deferred<DecisionsPolicy>();
      setAgentAskHuman.mockReturnValueOnce(save.promise);
      fireEvent.click(agentSwitch("claude"));

      view.rerender(<Section status={CONNECTED} active={false} />);
      view.rerender(<Section status={CONNECTED} />);
      await act(async () => {});
      const reads = getPolicy.mock.calls.length;
      await act(async () => save.reject(new Error("refused while off")));

      expect(screen.queryByText(/Couldn't switch on ask_human/)).toBeNull();
      expect(getPolicy).toHaveBeenCalledTimes(reads);
      expect(agentSwitch("claude").disabled).toBe(false);
    });

    it("gives an agent whose id names an object method a working switch", async () => {
      // An object literal can't type a `toString` key against the record, so it goes in by entry.
      const withMethodName = Object.fromEntries([
        ...Object.entries(INSTALLED),
        ["toString", "ready"],
      ]) as CliAvailability;
      setAvailability(withMethodName);
      await renderSection(CONNECTED);
      act(() =>
        registerPluginAgents("acme.agents", [{ ...ACME, id: "toString", name: "To String" }])
      );

      expect(agentSwitch("toString").disabled).toBe(false);
      expect(isOn("toString")).toBe(false);
    });

    it("follows another window's change, and never rolls back to an older read", async () => {
      setAvailability(INSTALLED);
      getPolicy.mockResolvedValue(policy({ askHumanAgents: [], revision: 2 }));
      await renderSection(CONNECTED);

      getPolicy.mockResolvedValueOnce(policy({ askHumanAgents: ["claude"], revision: 3 }));
      await statusPushed();
      expect(isOn("claude")).toBe(true);

      getPolicy.mockResolvedValueOnce(policy({ askHumanAgents: [], revision: 1 }));
      await statusPushed();
      expect(isOn("claude")).toBe(true);
    });

    it("gives a plugin's supported agent a switch of its own", async () => {
      setAvailability({ ...INSTALLED, "acme-agent": "ready", "acme-plain": "ready" });
      await renderSection(CONNECTED);
      act(() => registerPluginAgents("acme.agents", [ACME, PLAIN]));
      setAgentAskHuman.mockResolvedValueOnce(
        policy({ askHumanAgents: ["acme-agent"], revision: 1 })
      );

      await act(async () => {
        fireEvent.click(agentSwitch("acme-agent"));
      });
      expect(setAgentAskHuman).toHaveBeenCalledExactlyOnceWith({
        agentId: "acme-agent",
        enabled: true,
      });
      expect(isOn("acme-agent")).toBe(true);
      expect(screen.queryByRole("switch", { name: "ask_human for Acme Plain" })).toBeNull();
    });

    it("can be switched with no relay connected, to apply once one is", async () => {
      setAvailability(INSTALLED);
      await renderSection(NO_RELAY);
      setAgentAskHuman.mockResolvedValueOnce(policy({ askHumanAgents: ["claude"], revision: 1 }));

      await act(async () => {
        fireEvent.click(agentSwitch("claude"));
      });
      expect(isOn("claude")).toBe(true);
      expect(notice()).toMatch(/No relay is connected/);
    });
  });

  it("shows nothing in a remote window, whose agents are the host's", () => {
    remote.hostName = "build-box";
    setAvailability(INSTALLED);
    const { container } = render(<Section status={CONNECTED} />);

    expect(container.textContent).toBe("");
  });
});
