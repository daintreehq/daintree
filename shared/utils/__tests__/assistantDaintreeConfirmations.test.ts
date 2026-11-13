import { describe, it, expect } from "vitest";
import {
  assistantPolicySkips,
  assistantSkipsDaintreeConfirmations,
  isHelpAssistantDaintreeConfirmations,
  resolveAssistantAgentSkip,
  resolveAssistantConfirmationPolicy,
} from "../assistantDaintreeConfirmations.js";
import { HOST_SETTINGS_TOOL } from "../../types/hostControl.js";

describe("assistantSkipsDaintreeConfirmations (#12874, #12989)", () => {
  it("follows the agent's skip setting while inheriting", () => {
    expect(assistantSkipsDaintreeConfirmations("inherit", true)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations(undefined, true)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("inherit", false)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("inherit", undefined)).toBe(false);
  });

  it("never skips under always-ask", () => {
    expect(assistantSkipsDaintreeConfirmations("always-ask", true)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations("always-ask", false)).toBe(false);
  });

  it("always skips under never-ask, whatever the global says", () => {
    expect(assistantSkipsDaintreeConfirmations("never-ask", false)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("never-ask", undefined)).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("never-ask", true)).toBe(true);
  });

  it("reads an unrecognised preference as inherit", () => {
    const unknown = "skip" as unknown as "inherit";
    expect(assistantSkipsDaintreeConfirmations(unknown, false)).toBe(false);
    expect(assistantSkipsDaintreeConfirmations(unknown, true)).toBe(true);
  });
});

describe("assistantPolicySkips (#16752)", () => {
  it("asks for everything under ask-except but the delegable ids ticked", () => {
    const policy = resolveAssistantConfirmationPolicy(
      "ask-except",
      ["worktree.deleteOwned", "worktree.delete", 7],
      true
    );
    expect(assistantPolicySkips(policy, "worktree.deleteOwned")).toBe(true);
    expect(assistantPolicySkips(policy, "worktree.delete")).toBe(false);
    expect(assistantPolicySkips(policy, "terminal.closeAll")).toBe(false);
  });

  it("ignores the list in every other mode", () => {
    for (const mode of ["inherit", "always-ask", "never-ask", undefined] as const) {
      const policy = resolveAssistantConfirmationPolicy(mode, ["worktree.deleteOwned"], false);
      expect(policy.delegated.size).toBe(0);
      expect(assistantPolicySkips(policy, "worktree.deleteOwned")).toBe(mode === "never-ask");
    }
  });

  it("skips a host settings change only on its own tick, never under never-ask", () => {
    expect(
      assistantPolicySkips(
        resolveAssistantConfirmationPolicy("never-ask", [], true),
        HOST_SETTINGS_TOOL
      )
    ).toBe(false);
    expect(
      assistantPolicySkips(
        resolveAssistantConfirmationPolicy("inherit", [], true),
        HOST_SETTINGS_TOOL
      )
    ).toBe(false);
    expect(
      assistantPolicySkips(
        resolveAssistantConfirmationPolicy("ask-except", [HOST_SETTINGS_TOOL], false),
        HOST_SETTINGS_TOOL
      )
    ).toBe(true);
  });

  it("reads ask-except as a valid mode that skips nothing on its own", () => {
    expect(isHelpAssistantDaintreeConfirmations("ask-except")).toBe(true);
    expect(assistantSkipsDaintreeConfirmations("ask-except", true)).toBe(false);
  });
});

describe("resolveAssistantAgentSkip (#14141)", () => {
  it("follows an agent set to skip while the global is off", () => {
    const skip = resolveAssistantAgentSkip("claude", {
      agents: { claude: { dangerousMode: "on" } },
      globalSkipPermissions: false,
    });
    expect(skip).toEqual({ skips: true, source: "agent" });
    expect(assistantSkipsDaintreeConfirmations("inherit", skip.skips)).toBe(true);
  });

  it("honours an agent's veto over the global", () => {
    expect(
      resolveAssistantAgentSkip("claude", {
        agents: { claude: { dangerousMode: "off" } },
        globalSkipPermissions: true,
      })
    ).toEqual({ skips: false, source: "agent" });
  });

  it("reads the legacy dangerousEnabled toggle as set on the agent", () => {
    expect(
      resolveAssistantAgentSkip("codex", {
        agents: { codex: { dangerousEnabled: true } },
        globalSkipPermissions: false,
      })
    ).toEqual({ skips: true, source: "agent" });
  });

  it("inherits the global when the agent has no setting of its own", () => {
    expect(
      resolveAssistantAgentSkip("claude", { agents: {}, globalSkipPermissions: true })
    ).toEqual({ skips: true, source: "global" });
    expect(
      resolveAssistantAgentSkip("codex", {
        agents: { codex: { dangerousEnabled: false } },
        globalSkipPermissions: false,
      })
    ).toEqual({ skips: false, source: "global" });
  });

  it("keeps the global away from an agent that can't skip permission prompts", () => {
    expect(
      resolveAssistantAgentSkip("gemini", { agents: {}, globalSkipPermissions: true })
    ).toEqual({ skips: false, source: "unsupported" });
  });

  it("lets an agent set to skip skip, even one the global can't reach", () => {
    expect(
      resolveAssistantAgentSkip("gemini", {
        agents: { gemini: { dangerousMode: "on" } },
        globalSkipPermissions: false,
      })
    ).toEqual({ skips: true, source: "agent" });
  });

  it("never lets the global reach an unknown agent", () => {
    expect(
      resolveAssistantAgentSkip("not-a-real-agent", { agents: {}, globalSkipPermissions: true })
    ).toEqual({ skips: false, source: "unsupported" });
  });

  it("reads missing settings or entries as inheriting an unset global", () => {
    expect(resolveAssistantAgentSkip("claude", null)).toEqual({ skips: false, source: "global" });
    expect(
      resolveAssistantAgentSkip("claude", {
        globalSkipPermissions: true,
      } as unknown as Parameters<typeof resolveAssistantAgentSkip>[1])
    ).toEqual({ skips: true, source: "global" });
  });

  it("follows the global when no agent is chosen", () => {
    expect(resolveAssistantAgentSkip(null, { agents: {}, globalSkipPermissions: true })).toEqual({
      skips: true,
      source: "global",
    });
    expect(resolveAssistantAgentSkip(undefined, undefined)).toEqual({
      skips: false,
      source: "global",
    });
  });
});

describe("isHelpAssistantDaintreeConfirmations", () => {
  it("accepts exactly the three stored values", () => {
    expect(isHelpAssistantDaintreeConfirmations("inherit")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("always-ask")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("never-ask")).toBe(true);
    expect(isHelpAssistantDaintreeConfirmations("skip")).toBe(false);
    expect(isHelpAssistantDaintreeConfirmations(undefined)).toBe(false);
    expect(isHelpAssistantDaintreeConfirmations(true)).toBe(false);
  });
});
