import { describe, expect, it } from "vitest";
import type { AgentPreset } from "@shared/config/agentRegistry";
import { ownFallbackChainRoot, type FallbackChainPresets } from "../fallbackChainStep";

const preset = (id: string, fallbacks?: string[]): AgentPreset => ({
  id,
  name: id,
  ...(fallbacks ? { fallbacks } : {}),
});

// An empty CCR bucket replaces the built-in one, so only what a test names exists.
const presets = (
  custom: AgentPreset[],
  extra: Omit<FallbackChainPresets, "customPresets"> = {}
): FallbackChainPresets => ({ customPresets: custom, ccrPresets: [], ...extra });

describe("ownFallbackChainRoot (#17917)", () => {
  const own = presets([preset("a", ["b", "c"]), preset("b", ["x"]), preset("c"), preset("x")]);

  it("takes the next step of a custom preset's chain from the pane's root", () => {
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "b", own)).toBe("a");
    expect(
      ownFallbackChainRoot("claude", { agentPresetId: "a", originalPresetId: "a" }, "b", own)
    ).toBe("a");
  });

  it("walks one chain the way usage-limit hops do, never the step's own", () => {
    const afterOne = { agentPresetId: "b", originalPresetId: "a", fallbackChainIndex: 1 };
    expect(ownFallbackChainRoot("claude", afterOne, "c", own)).toBe("a");
    // `b`'s own chain names `x`, which isn't the chain the pane walks.
    expect(ownFallbackChainRoot("claude", afterOne, "x", own)).toBeNull();
    // Nor does a step repeat or skip ahead.
    expect(ownFallbackChainRoot("claude", afterOne, "b", own)).toBeNull();
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "c", own)).toBeNull();
  });

  it("stops at the end of the chain", () => {
    const exhausted = { agentPresetId: "c", originalPresetId: "a", fallbackChainIndex: 2 };
    expect(ownFallbackChainRoot("claude", exhausted, "x", own)).toBeNull();
    expect(ownFallbackChainRoot("claude", { agentPresetId: "c" }, "a", own)).toBeNull();
  });

  it("asks when the pane isn't where the chain says it is", () => {
    // Moved to `c` some other way while the cursor still says one hop.
    expect(
      ownFallbackChainRoot(
        "claude",
        { agentPresetId: "c", originalPresetId: "a", fallbackChainIndex: 1 },
        "c",
        own
      )
    ).toBeNull();
    // A hopped pane with no root on record.
    expect(
      ownFallbackChainRoot("claude", { agentPresetId: "b", fallbackChainIndex: 1 }, "c", own)
    ).toBeNull();
    for (const fallbackChainIndex of [-1, 0.5, Number.NaN]) {
      expect(
        ownFallbackChainRoot(
          "claude",
          { agentPresetId: "a", originalPresetId: "a", fallbackChainIndex },
          "b",
          own
        )
      ).toBeNull();
    }
    expect(ownFallbackChainRoot("claude", { originalPresetId: "a" }, "b", own)).toBeNull();
  });

  it("never follows a chain on a project preset", () => {
    const shared = presets([preset("b"), preset("c")], {
      projectPresets: [preset("team", ["b", "c"])],
    });
    expect(ownFallbackChainRoot("claude", { agentPresetId: "team" }, "b", shared)).toBeNull();
  });

  it("follows a custom preset that shadows a project one of the same id", () => {
    const shadowed = presets([preset("a", ["b"]), preset("b")], {
      projectPresets: [preset("a", ["c"]), preset("c")],
    });
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "b", shadowed)).toBe("a");
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "c", shadowed)).toBeNull();
  });

  it("asks for a project preset as the step, and steps past nothing to reach the next", () => {
    const mixed = presets([preset("a", ["team", "c"]), preset("c")], {
      projectPresets: [preset("team")],
    });
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "team", mixed)).toBeNull();
    // `c` is still the second step: reaching it means first being on `team`.
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "c", mixed)).toBeNull();
    expect(
      ownFallbackChainRoot(
        "claude",
        { agentPresetId: "team", originalPresetId: "a", fallbackChainIndex: 1 },
        "c",
        mixed
      )
    ).toBe("a");
  });

  it("asks when a project preset takes over a built-in id the chain names", () => {
    const builtIn = {
      customPresets: [preset("a", ["shared-id"])],
      ccrPresets: [preset("shared-id")],
    };
    expect(ownFallbackChainRoot("claude", { agentPresetId: "a" }, "shared-id", builtIn)).toBe("a");
    expect(
      ownFallbackChainRoot("claude", { agentPresetId: "a" }, "shared-id", {
        ...builtIn,
        projectPresets: [preset("shared-id")],
      })
    ).toBeNull();
  });
});
