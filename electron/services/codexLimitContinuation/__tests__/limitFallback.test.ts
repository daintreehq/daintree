import { describe, expect, it } from "vitest";
import type { AgentPreset } from "../../../../shared/config/agentRegistry.js";
import { decideLimitFallback, type LimitFallbackRun } from "../limitFallback.js";

const preset = (id: string, extra: Partial<AgentPreset> = {}): AgentPreset => ({
  id,
  name: id,
  ...extra,
});

const work = preset("work", { fallbacks: ["spare", "last"], fallbackOnRateLimit: true });
const custom = [work, preset("spare"), preset("last")];

const run = (extra: Partial<LimitFallbackRun> = {}): LimitFallbackRun => ({
  agentId: "codex",
  presetId: "work",
  originalPresetId: "work",
  chainIndex: undefined,
  ...extra,
});

describe("decideLimitFallback (#17909)", () => {
  it("waits for a pane launched with no preset: it has nowhere to fall back to", () => {
    expect(decideLimitFallback(run({ presetId: undefined }), null, null)).toBe("none");
  });

  it("waits when the user's own preset didn't opt in to falling back on limits", () => {
    const optedOut = [preset("work", { fallbacks: ["spare"] }), preset("spare")];
    expect(decideLimitFallback(run(), optedOut, undefined)).toBe("none");
  });

  it("never takes a team-shared project preset's opt-in for the user's", () => {
    expect(decideLimitFallback(run(), [], [work, preset("spare")])).toBe("none");
  });

  it("falls back while the chain has a preset at the hops taken", () => {
    expect(decideLimitFallback(run(), custom, undefined)).toBe("fallback");
    expect(decideLimitFallback(run({ presetId: "spare", chainIndex: 1 }), custom, undefined)).toBe(
      "fallback"
    );
  });

  it("waits once the chain is spent", () => {
    expect(decideLimitFallback(run({ presetId: "last", chainIndex: 2 }), custom, undefined)).toBe(
      "none"
    );
  });

  it("reads the chain at the hops the launch reported, not where the preset sits now", () => {
    // Hopped once to `spare`, then the chain was edited so `spare` is last.
    const edited = [
      preset("work", { fallbacks: ["other", "last", "spare"], fallbackOnRateLimit: true }),
      preset("other"),
      preset("last"),
      preset("spare"),
    ];
    expect(decideLimitFallback(run({ presetId: "spare", chainIndex: 1 }), edited, undefined)).toBe(
      "fallback"
    );
  });

  it("keeps a fallback to a project preset in the chain", () => {
    const ownWork = preset("work", { fallbacks: ["team"], fallbackOnRateLimit: true });
    expect(decideLimitFallback(run(), [ownWork], [preset("team")])).toBe("fallback");
  });

  it("can't tell when a fallback the preset names wasn't among the presets read", () => {
    // A project preset file that failed to read looks just like a deleted one.
    const ownWork = preset("work", { fallbacks: ["team", "spare"], fallbackOnRateLimit: true });
    expect(
      decideLimitFallback(
        run({ presetId: "spare", chainIndex: 2 }),
        [ownWork, preset("spare")],
        undefined
      )
    ).toBe("unknown");
  });

  it("can't tell when a source it needs went unread, or a hop wasn't reported", () => {
    expect(decideLimitFallback(run(), null, undefined)).toBe("unknown");
    expect(decideLimitFallback(run(), custom, null)).toBe("unknown");
    expect(decideLimitFallback(run({ presetId: "spare" }), custom, undefined)).toBe("unknown");
  });
});
