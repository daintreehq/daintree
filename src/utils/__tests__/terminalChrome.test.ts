import { afterEach, describe, expect, it } from "vitest";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import { PROCESS_TOOL_REGISTRY } from "@shared/config/processToolRegistry";
import {
  deriveTerminalChrome,
  deriveTerminalRuntimeIdentity,
  terminalChromeDescriptorsEqual,
  terminalRuntimeIdentitiesEqual,
} from "../terminalChrome";

describe("deriveTerminalRuntimeIdentity", () => {
  it("promotes detected agents to the canonical runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedAgentId: "claude",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      kind: "agent",
      id: "claude",
      iconId: "claude",
      agentId: "claude",
      processId: "npm",
    });
  });

  it("prefers fresh detected agent evidence over stale process runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedAgentId: "claude",
        detectedProcessId: "claude",
        runtimeIdentity: {
          kind: "process",
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      })
    ).toMatchObject({
      kind: "agent",
      id: "claude",
      iconId: "claude",
      agentId: "claude",
      processId: "claude",
    });
  });

  it("prefers fresh detected process evidence over stale agent runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedProcessId: "npm",
        runtimeIdentity: {
          kind: "agent",
          id: "claude",
          iconId: "claude",
          agentId: "claude",
        },
      })
    ).toEqual({
      kind: "process",
      id: "npm",
      iconId: "npm",
      processId: "npm",
    });
  });

  it("uses process identity when no agent is detected", () => {
    expect(deriveTerminalRuntimeIdentity({ detectedProcessId: "NPM" })).toEqual({
      kind: "process",
      id: "npm",
      iconId: "npm",
      processId: "npm",
    });
  });

  it("returns null when no live identity exists", () => {
    expect(deriveTerminalRuntimeIdentity({})).toBeNull();
    expect(deriveTerminalRuntimeIdentity(undefined)).toBeNull();
  });
});

describe("deriveTerminalChrome", () => {
  it("labels every process tool from the registry rather than echoing its icon id", () => {
    // A missing label used to surface the raw icon id as the tab's text.
    const echoed = Object.keys(PROCESS_TOOL_REGISTRY).filter(
      (iconId) => deriveTerminalChrome({ detectedProcessId: iconId }).label === iconId
    );
    // `npm`, `tmux` and friends legitimately label themselves lowercase, so
    // compare against the registry rather than asserting they always differ.
    const expected = Object.entries(PROCESS_TOOL_REGISTRY)
      .filter(([iconId, config]) => config.label === iconId)
      .map(([iconId]) => iconId);
    expect(echoed.sort()).toEqual(expected.sort());
  });

  it("returns generic terminal chrome for empty runtime state", () => {
    expect(deriveTerminalChrome()).toMatchObject({
      iconId: null,
      label: "Terminal",
      isAgent: false,
      agentId: null,
      processId: null,
      runtimeKind: "none",
    });
  });

  it("returns panel chrome for review kind (not terminal)", () => {
    // Regression guard: review must take the non-PTY panel-chrome branch so it
    // does not inherit terminal/agent restart buttons or activity badges.
    expect(deriveTerminalChrome({ kind: "review" })).toMatchObject({
      iconId: "git-pull-request",
      label: "Review",
      isAgent: false,
      agentId: null,
      processId: null,
      runtimeKind: "panel",
      hasExited: false,
    });
  });

  describe("registered plugin kinds (#11228)", () => {
    afterEach(() => {
      unregisterPanelKind("acme.dashboard");
      unregisterPanelKind("acme.shell");
    });

    it("takes the panel branch for a registered non-PTY plugin kind, keeping its manifest icon", () => {
      // The generalized allowlist (`!hasPty`) must cover plugin kinds, not just
      // the four built-ins — otherwise a plugin panel's new header renders with
      // no icon and a "Terminal" label from the fall-through branch.
      registerPanelKind({
        id: "acme.dashboard",
        name: "Acme Dashboard",
        iconId: "gauge",
        color: "#abcdef",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        extensionId: "acme",
      });

      expect(deriveTerminalChrome({ kind: "acme.dashboard" })).toMatchObject({
        iconId: "gauge",
        label: "Acme Dashboard",
        isAgent: false,
        runtimeKind: "panel",
        hasExited: false,
      });
    });

    it("does NOT take the panel branch for a registered PTY plugin kind", () => {
      // A PTY-backed plugin kind is a real terminal — it must fall through to
      // the agent/process/none derivation, not the panel branch.
      registerPanelKind({
        id: "acme.shell",
        name: "Acme Shell",
        iconId: "terminal",
        color: "#abcdef",
        hasPty: true,
        canRestart: true,
        canConvert: false,
        extensionId: "acme",
      });

      expect(deriveTerminalChrome({ kind: "acme.shell" })).toMatchObject({
        runtimeKind: "none",
      });
    });

    it("falls through to generic chrome for an unknown (unregistered) kind", () => {
      // The `?? false` safety property: a plugin that has gone missing leaves an
      // unregistered kind, which must not be mistaken for a panel and must stay
      // on the safe fall-through path.
      expect(deriveTerminalChrome({ kind: "gone.missing" })).toMatchObject({
        iconId: null,
        runtimeKind: "none",
      });
    });
  });

  it("returns agent chrome from live detection", () => {
    expect(deriveTerminalChrome({ detectedAgentId: "claude" })).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("uses stored agentPresetColor when direct panel data is passed", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "claude",
        agentPresetColor: "#3366ff",
      }).color
    ).toBe("#3366ff");
  });

  it("lets explicit presetColor override stored agentPresetColor", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "claude",
        agentPresetColor: "#3366ff",
        presetColor: "#ff6600",
      }).color
    ).toBe("#ff6600");
  });

  it("returns agent chrome from durable launch affinity until explicit exit", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "working",
      })
    ).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("demotes launch affinity to plain terminal after explicit agent exit", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "exited",
      })
    ).toMatchObject({
      iconId: null,
      label: "Terminal",
      isAgent: false,
      agentId: null,
      runtimeKind: "none",
    });
  });

  it("keeps launch-agent chrome when sticky detection clears without explicit exit", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        everDetectedAgent: true,
      })
    ).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("shows a process icon after a launch-affinity terminal has explicitly exited", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "exited",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      iconId: "npm",
      label: "npm",
      isAgent: false,
      agentId: null,
      processId: "npm",
      runtimeKind: "process",
    });
  });

  it("returns process chrome without agent capability", () => {
    expect(deriveTerminalChrome({ detectedProcessId: "npm" })).toMatchObject({
      iconId: "npm",
      label: "npm",
      isAgent: false,
      agentId: null,
      processId: "npm",
      runtimeKind: "process",
    });
  });

  it("agent identity wins when agent and process are both present", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "codex",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      iconId: "codex",
      isAgent: true,
      agentId: "codex",
      processId: "npm",
    });
  });
});

describe("terminalRuntimeIdentitiesEqual", () => {
  it("compares canonical runtime identity fields", () => {
    const left = deriveTerminalRuntimeIdentity({ detectedAgentId: "claude" });
    const right = deriveTerminalRuntimeIdentity({ detectedAgentId: "claude" });
    const other = deriveTerminalRuntimeIdentity({ detectedProcessId: "npm" });

    expect(terminalRuntimeIdentitiesEqual(left, right)).toBe(true);
    expect(terminalRuntimeIdentitiesEqual(left, other)).toBe(false);
  });
});

describe("terminalChromeDescriptorsEqual", () => {
  it("detects hasExited differences (post-exit spinner suppression)", () => {
    // Race: exitCode arrives before agentState transitions to "exited". Both
    // descriptors share identity fields; only hasExited diverges. The equality
    // check must catch this or the memo gate keeps the working spinner alive
    // after the process has died.
    const live = deriveTerminalChrome({
      kind: "terminal",
      launchAgentId: "claude",
      agentState: "working",
    });
    const exited = deriveTerminalChrome({
      kind: "terminal",
      launchAgentId: "claude",
      agentState: "working",
      exitCode: 0,
    });

    expect(live.hasExited).toBe(false);
    expect(exited.hasExited).toBe(true);
    expect(terminalChromeDescriptorsEqual(live, exited)).toBe(false);
  });

  it("returns true for two equivalent descriptors", () => {
    const a = deriveTerminalChrome({ kind: "terminal", launchAgentId: "claude" });
    const b = deriveTerminalChrome({ kind: "terminal", launchAgentId: "claude" });
    expect(terminalChromeDescriptorsEqual(a, b)).toBe(true);
  });

  it("returns true for identical references", () => {
    const a = deriveTerminalChrome({ kind: "browser" });
    expect(terminalChromeDescriptorsEqual(a, a)).toBe(true);
  });

  it("returns false when one side is undefined", () => {
    const a = deriveTerminalChrome({ kind: "terminal" });
    expect(terminalChromeDescriptorsEqual(a, undefined)).toBe(false);
    expect(terminalChromeDescriptorsEqual(undefined, a)).toBe(false);
  });

  it("returns true when both sides are undefined", () => {
    expect(terminalChromeDescriptorsEqual(undefined, undefined)).toBe(true);
  });
});
