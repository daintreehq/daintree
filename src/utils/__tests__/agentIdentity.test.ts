import { describe, expect, it } from "vitest";
import { resolveEffectiveAgentId } from "../agentIdentity";

describe("resolveEffectiveAgentId", () => {
  it("prefers detectedAgentId when both are present", () => {
    expect(resolveEffectiveAgentId("gemini", "claude")).toBe("gemini");
  });

  it("falls back to agentId when detectedAgentId is absent", () => {
    expect(resolveEffectiveAgentId(undefined, "claude")).toBe("claude");
  });

  it("returns detectedAgentId when agentId is absent", () => {
    expect(resolveEffectiveAgentId("claude", undefined)).toBe("claude");
  });

  it("returns undefined when neither is present", () => {
    expect(resolveEffectiveAgentId(undefined, undefined)).toBeUndefined();
  });

  it("preserves empty-string identities (??  only short-circuits on nullish)", () => {
    // Guards against accidental truthiness-based trimming at call sites:
    // the helper uses `??`, so "" survives. If a caller wants to treat empty
    // strings as absent, it must do so explicitly after resolution.
    expect(resolveEffectiveAgentId("", "claude")).toBe("");
    expect(resolveEffectiveAgentId(undefined, "")).toBe("");
  });

  it("ignores the runtime-detected identity when it is explicitly null-ish", () => {
    // Callers that clear `detectedAgentId` on exit must get the launch-time
    // fallback back, not a stale detection.
    expect(resolveEffectiveAgentId(undefined, "claude")).toBe("claude");
    expect(resolveEffectiveAgentId(null as unknown as undefined, "claude")).toBe("claude");
  });
});
