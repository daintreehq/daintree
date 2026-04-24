import { describe, expect, it } from "vitest";
import { resolveChromeAgentId } from "../agentIdentity";

describe("resolveChromeAgentId", () => {
  it("prefers detectedAgentId when both are present", () => {
    expect(resolveChromeAgentId("gemini", "claude")).toBe("gemini");
  });

  it("falls back to agentId when detectedAgentId is absent", () => {
    expect(resolveChromeAgentId(undefined, "claude")).toBe("claude");
  });

  it("returns detectedAgentId when agentId is absent", () => {
    expect(resolveChromeAgentId("claude", undefined)).toBe("claude");
  });

  it("returns undefined when neither is present", () => {
    expect(resolveChromeAgentId(undefined, undefined)).toBeUndefined();
  });

  it("empty-string launchAgentId passes through when detectedAgentId is absent", () => {
    // launchAgentId is string-typed so "" is valid at the type level; the caller
    // is responsible for treating empty strings as absent if needed.
    expect(resolveChromeAgentId(undefined, "")).toBe("");
  });

  it("ignores the runtime-detected identity when it is explicitly null-ish", () => {
    // Callers that clear `detectedAgentId` on exit must get the launch-time
    // fallback back, not a stale detection.
    expect(resolveChromeAgentId(undefined, "claude")).toBe("claude");
    expect(resolveChromeAgentId(null as unknown as undefined, "claude")).toBe("claude");
  });
});
