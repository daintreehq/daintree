import { describe, it, expect } from "vitest";
import type { AgentPreset } from "@/config/agents";
import { isAgentBypassSupported, type DangerousMode } from "@shared/types";
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
          const want =
            decider === "inherit" ? global && isAgentBypassSupported("claude") : decider === "on";
          expect(got, `${agentMode}/${presetMode}/${global}`).toBe(want);
        }
      }
    }
  });

  it("never follows the global switch for an agent that has no bypass", () => {
    const unsupported = ["claude", "codex", "gemini", "aider", "copilot", "crush"].find(
      (id) => !isAgentBypassSupported(id)
    );
    if (!unsupported) return;
    expect(resolveSkipPermissions(unsupported, {}, undefined, true)).toBe(false);
  });
});
