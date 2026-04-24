import { describe, expect, it } from "vitest";
import { resolveChromeAgentId, isAgentTerminalLive } from "../agentIdentity";

describe("resolveChromeAgentId", () => {
  it("returns detectedAgentId when it is set", () => {
    expect(resolveChromeAgentId("claude", undefined)).toBe("claude");
    expect(resolveChromeAgentId("gemini", "claude")).toBe("gemini");
  });

  it("returns undefined when detectedAgentId is absent — launchAgentId is NOT a chrome fallback", () => {
    expect(resolveChromeAgentId(undefined, "claude")).toBeUndefined();
    expect(resolveChromeAgentId(undefined, "claude", true)).toBeUndefined();
    expect(resolveChromeAgentId(undefined, "claude", false)).toBeUndefined();
  });

  it("returns undefined when neither is present", () => {
    expect(resolveChromeAgentId(undefined, undefined)).toBeUndefined();
  });

  it("panel-form: chrome mirrors detectedAgentId, ignores launchAgentId/everDetectedAgent", () => {
    expect(resolveChromeAgentId({ detectedAgentId: "claude", launchAgentId: undefined })).toBe(
      "claude"
    );
    expect(
      resolveChromeAgentId({
        detectedAgentId: undefined,
        launchAgentId: "claude",
        everDetectedAgent: true,
      })
    ).toBeUndefined();
    expect(
      resolveChromeAgentId({
        detectedAgentId: undefined,
        launchAgentId: "claude",
        everDetectedAgent: false,
      })
    ).toBeUndefined();
  });
});

describe("isAgentTerminalLive", () => {
  it("is true only when detectedAgentId is set", () => {
    expect(isAgentTerminalLive({ detectedAgentId: "claude" })).toBe(true);
    expect(isAgentTerminalLive({ detectedAgentId: undefined, launchAgentId: "claude" })).toBe(
      false
    );
    expect(
      isAgentTerminalLive({
        detectedAgentId: undefined,
        launchAgentId: "claude",
        everDetectedAgent: true,
      })
    ).toBe(false);
    expect(isAgentTerminalLive(undefined)).toBe(false);
  });
});
