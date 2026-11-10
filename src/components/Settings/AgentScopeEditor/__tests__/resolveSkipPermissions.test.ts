import { describe, it, expect } from "vitest";
import type { AgentPreset } from "@/config/agents";
import type { DangerousMode } from "@shared/types";
import { resolveSkipPermissions } from "../scopeUtils";

const MODES: DangerousMode[] = ["inherit", "on", "off"];
const preset = (dangerousMode: DangerousMode) =>
  ({ id: "p", name: "P", dangerousMode }) as AgentPreset;

describe("resolveSkipPermissions", () => {
  it("lets the most specific explicit choice win: preset, then agent, then global", () => {
    for (const agentMode of MODES) {
      for (const presetMode of MODES) {
        for (const global of [true, false]) {
          const got = resolveSkipPermissions(
            "claude",
            { dangerousMode: agentMode },
            preset(presetMode),
            global
          );
          const decider = presetMode !== "inherit" ? presetMode : agentMode;
          const want = decider === "inherit" ? global : decider === "on";
          expect(got, `${agentMode}/${presetMode}/${global}`).toBe(want);
        }
      }
    }
  });

  it("follows the global switch for agents with a terminal bypass flag but no assistant bypass (#16414)", () => {
    for (const agentId of ["antigravity", "gemini", "grok", "cursor", "aider", "kiro"]) {
      expect(resolveSkipPermissions(agentId, {}, undefined, true), agentId).toBe(true);
      expect(resolveSkipPermissions(agentId, {}, undefined, false), agentId).toBe(false);
      expect(
        resolveSkipPermissions(agentId, {}, preset("off"), true),
        `${agentId} preset off`
      ).toBe(false);
    }
  });

  it("never follows the global switch for an agent that has no bypass flag", () => {
    for (const agentId of ["opencode", "copilot"]) {
      expect(resolveSkipPermissions(agentId, {}, undefined, true), agentId).toBe(false);
    }
  });
});
