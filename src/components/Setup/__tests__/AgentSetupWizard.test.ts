import { describe, expect, it } from "vitest";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import {
  buildInitialState,
  FEATURED_AGENT_IDS,
  flowSteps,
  MORE_AGENT_IDS,
  sortTierByInstalled,
  wizardReducer,
} from "../AgentSetupWizard";
import type { CliAvailability } from "@shared/types";

describe("sortTierByInstalled", () => {
  const tier = ["claude", "gemini", "codex"] as const;

  it("preserves original order when all uninstalled", () => {
    const result = sortTierByInstalled(tier, {} as CliAvailability);
    expect(result).toEqual(["claude", "gemini", "codex"]);
  });

  it("preserves original order when all installed", () => {
    const result = sortTierByInstalled(tier, {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    } as CliAvailability);
    expect(result).toEqual(["claude", "gemini", "codex"]);
  });

  it("floats installed agents to the front, preserving relative order", () => {
    const result = sortTierByInstalled(tier, {
      claude: "missing",
      gemini: "ready",
      codex: "installed",
    } as CliAvailability);
    expect(result).toEqual(["gemini", "codex", "claude"]);
  });

  it("handles single installed agent", () => {
    const result = sortTierByInstalled(tier, { codex: "ready" } as CliAvailability);
    expect(result).toEqual(["codex", "claude", "gemini"]);
  });

  it("treats missing and undefined availability the same", () => {
    const withMissing = sortTierByInstalled(tier, {
      claude: "missing",
      gemini: "ready",
      codex: "missing",
    } as CliAvailability);
    const withUndefined = sortTierByInstalled(tier, { gemini: "ready" } as CliAvailability);
    expect(withMissing).toEqual(withUndefined);
  });

  it("works with the more-agents tier", () => {
    const moreTier = ["opencode", "cursor", "kiro"] as const;
    const result = sortTierByInstalled(moreTier, {
      cursor: "installed",
      kiro: "missing",
    } as CliAvailability);
    expect(result).toEqual(["cursor", "opencode", "kiro"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortTierByInstalled([], {} as CliAvailability)).toEqual([]);
  });

  it("ignores extra availability keys not in the tier", () => {
    const result = sortTierByInstalled(
      ["claude"] as const,
      { claude: "ready", gemini: "ready" } as CliAvailability
    );
    expect(result).toEqual(["claude"]);
  });
});

describe("tier partition completeness", () => {
  it("FEATURED + MORE covers all BUILT_IN_AGENT_IDS with no overlap", () => {
    const combined = [...FEATURED_AGENT_IDS, ...MORE_AGENT_IDS].sort();
    const expected = [...LAUNCHABLE_AGENT_IDS].sort();
    expect(combined).toEqual(expected);

    const overlap = FEATURED_AGENT_IDS.filter((id) => MORE_AGENT_IDS.includes(id));
    expect(overlap).toEqual([]);
  });
});

describe("flowSteps", () => {
  it("includes the permissions step on first run, after cli and before complete", () => {
    const steps = flowSteps(true);
    expect(steps).toContain("permissions");
    expect(steps.indexOf("permissions")).toBeGreaterThan(steps.indexOf("cli"));
    expect(steps.indexOf("permissions")).toBeLessThan(steps.indexOf("complete"));
  });

  it("omits the permissions step for returning users", () => {
    expect(flowSteps(false)).not.toContain("permissions");
  });
});

describe("AgentSetupWizard reducer", () => {
  const emptyAvail = {} as CliAvailability;
  const partialAvail = {
    claude: "ready",
    gemini: "missing",
    codex: "missing",
  } as CliAvailability;

  it("starts at the appearance step on first run", () => {
    const state = buildInitialState(emptyAvail, true);
    expect(state.step).toEqual({ type: "appearance" });
    expect(state.history).toEqual([]);
    expect(state.isFirstRun).toBe(true);
  });

  it("starts at the agents step when not first run", () => {
    const state = buildInitialState(emptyAvail);
    expect(state.step).toEqual({ type: "agents" });
    expect(state.history).toEqual([]);
    expect(state.isFirstRun).toBe(false);
  });

  it("advances from appearance to agents on first run", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    expect(state.step).toEqual({ type: "agents" });
    expect(state.history).toEqual([{ type: "appearance" }]);
  });

  it("advances from agents to privacy on first run regardless of install state", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "privacy" });
  });

  it("advances from agents to cli (non-first-run) when not all installed", () => {
    let state = buildInitialState(partialAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true, codex: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("skips to complete (non-first-run) when all selected agents are installed", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
    expect(state.history).toEqual([{ type: "agents" }]);
  });

  it("privacy advances to cli when not all installed", () => {
    const partial = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(partial, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("privacy routes first-run to permissions (not complete) when all selected agents are installed", () => {
    // cli is skipped (nothing to install) but the global permissions consent
    // gate must still fire on first run before the summary.
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });
  });

  it("privacy routes first-run to permissions when only selected agents are installed (unselected missing)", () => {
    const avail = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(avail, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: false },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });
  });

  it("permissions still fires on first run when all agents pre-installed, then advances to complete", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });

    state = wizardReducer(state, { type: "PERMISSIONS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    // BACK from complete returns to permissions, not cli (cli was skipped).
    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "permissions" });
  });

  it("BACK from complete returns to the prior step, preserving history", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "agents" });
    expect(state.history).toEqual([]);
  });

  it("routes installed-but-not-launchable agents (installed/blocked) to cli, not complete", () => {
    // `installed` and `blocked` pass isAgentInstalled but fail isAgentLaunchable
    // — the binary exists yet still needs setup, so the cli step must run.
    const avail = { claude: "installed", gemini: "blocked" } as CliAvailability;
    let state = buildInitialState(avail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("treats unauthenticated agents as launchable and skips to complete", () => {
    const avail = { claude: "unauthenticated" } as CliAvailability;
    let state = buildInitialState(avail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("goes to cli when availability changes after init to mark agent uninstalled", () => {
    const allInstalled = { claude: "ready", gemini: "ready" } as CliAvailability;
    let state = buildInitialState(allInstalled);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, {
      type: "SET_AVAILABILITY",
      payload: { claude: "ready", gemini: "missing" } as CliAvailability,
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("advances from cli to complete (non-first-run, no permissions step)", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("advances from cli to permissions on first run", () => {
    const partial = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(partial, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });
  });

  it("advances from permissions to complete", () => {
    let state = buildInitialState(emptyAvail, true);
    state.step = { type: "permissions" };
    state = wizardReducer(state, { type: "PERMISSIONS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });
  });

  it("BACK from permissions returns to cli", () => {
    const partial = { claude: "ready", gemini: "missing" } as CliAvailability;
    let state = buildInitialState(partial, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "cli" });
  });

  it("follows full first-run flow: appearance -> agents -> privacy -> cli -> permissions -> complete", () => {
    let state = buildInitialState(emptyAvail, true);

    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });
    expect(state.step).toEqual({ type: "agents" });

    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "privacy" });

    state = wizardReducer(state, { type: "PRIVACY_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "CLI_CONTINUE" });
    expect(state.step).toEqual({ type: "permissions" });

    state = wizardReducer(state, { type: "PERMISSIONS_CONTINUE" });
    expect(state.step).toEqual({ type: "complete" });

    expect(state.history).toEqual([
      { type: "appearance" },
      { type: "agents" },
      { type: "privacy" },
      { type: "cli" },
      { type: "permissions" },
    ]);
  });

  it("navigates back through history", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "agents" });

    // Back from the entry step does nothing (empty history)
    const unchanged = wizardReducer(state, { type: "BACK" });
    expect(unchanged.step).toEqual({ type: "agents" });
  });

  it("toggles agent selection", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false, gemini: false },
    });
    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "claude", checked: true });
    expect(state.selections.claude).toBe(true);
    expect(state.selections.gemini).toBe(false);

    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "claude", checked: false });
    expect(state.selections.claude).toBe(false);
  });

  it("updates availability without changing selections", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: false },
    });
    state = wizardReducer(state, {
      type: "SET_AVAILABILITY",
      payload: { claude: "ready" } as CliAvailability,
    });
    expect(state.availability.claude).toBe("ready");
    expect(state.selections.claude).toBe(false);
  });

  it("resets to the first-run entry step when isFirstRun is true", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });

    const reset = wizardReducer(state, {
      type: "RESET",
      availability: partialAvail,
      isFirstRun: true,
    });
    expect(reset.step).toEqual({ type: "appearance" });
    expect(reset.history).toEqual([]);
    expect(reset.selections).toEqual({});
    expect(reset.availability).toBe(partialAvail);
    expect(reset.isFirstRun).toBe(true);
  });

  it("resets to the agents step when isFirstRun is false", () => {
    let state = buildInitialState(emptyAvail, true);
    state = wizardReducer(state, { type: "APPEARANCE_CONTINUE" });

    const reset = wizardReducer(state, {
      type: "RESET",
      availability: partialAvail,
      isFirstRun: false,
    });
    expect(reset.step).toEqual({ type: "agents" });
    expect(reset.history).toEqual([]);
    expect(reset.isFirstRun).toBe(false);
  });

  it("navigates back from cli to agents and re-confirms", () => {
    let state = buildInitialState(emptyAvail);
    state = wizardReducer(state, {
      type: "INIT_SELECTIONS",
      payload: { claude: true, gemini: true },
    });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });

    state = wizardReducer(state, { type: "BACK" });
    expect(state.step).toEqual({ type: "agents" });

    state = wizardReducer(state, { type: "TOGGLE_SELECTION", agentId: "gemini", checked: false });
    state = wizardReducer(state, { type: "AGENTS_CONTINUE" });
    expect(state.step).toEqual({ type: "cli" });
    expect(state.selections.gemini).toBe(false);
  });
});
