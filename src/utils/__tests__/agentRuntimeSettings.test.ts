import { describe, it, expect } from "vitest";
import { applyPresetBehaviorOverrides } from "../agentRuntimeSettings";
import { resolveEffectiveBypass } from "@shared/types";
import type { AgentPreset } from "@/config/agents";

const preset = (over: Partial<AgentPreset>): AgentPreset => ({
  id: "user-1",
  name: "Preset",
  ...over,
});

describe("applyPresetBehaviorOverrides — tri-state bypass", () => {
  it("returns the entry untouched when there is no preset", () => {
    const entry = { dangerousMode: "off" as const };
    expect(applyPresetBehaviorOverrides(entry, undefined)).toBe(entry);
  });

  it("bakes the combined mode so a preset 'off' vetoes an agent 'on'", () => {
    const merged = applyPresetBehaviorOverrides(
      { dangerousMode: "on" },
      preset({ dangerousMode: "off" })
    );
    expect(merged.dangerousMode).toBe("off");
    // Mirrored legacy boolean tracks the resolved 'on' state only.
    expect(merged.dangerousEnabled).toBe(false);
    expect(resolveEffectiveBypass(merged, "claude", true)).toBe(false);
  });

  it("lets a preset 'on' override an agent 'off'", () => {
    const merged = applyPresetBehaviorOverrides(
      { dangerousMode: "off" },
      preset({ dangerousMode: "on" })
    );
    expect(merged.dangerousMode).toBe("on");
    expect(merged.dangerousEnabled).toBe(true);
    expect(resolveEffectiveBypass(merged, "claude", false)).toBe(true);
  });

  it("inherits the agent mode when the preset defers (inherit/absent)", () => {
    const merged = applyPresetBehaviorOverrides({ dangerousMode: "off" }, preset({}));
    expect(merged.dangerousMode).toBe("off");
    expect(resolveEffectiveBypass(merged, "claude", true)).toBe(false);
  });

  it("treats a legacy preset dangerousEnabled:true as 'on'", () => {
    const merged = applyPresetBehaviorOverrides({}, preset({ dangerousEnabled: true }));
    expect(merged.dangerousMode).toBe("on");
  });
});
