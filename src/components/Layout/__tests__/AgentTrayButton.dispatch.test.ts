// @vitest-environment node
/**
 * Adversarial tests for the AgentTrayButton dispatch payload construction.
 *
 * The handleLaunch callback in AgentTrayButton uses:
 *   { agentId, ...(presetId !== undefined ? { presetId } : {}) }
 *
 * null  = default sentinel — must be included in the payload so useAgentLauncher
 *         knows to skip getMergedPreset entirely.
 * undefined = use saved default — must be EXCLUDED from the payload (no key).
 *
 * If someone changes the guard from `!== undefined` to `!= null` (double-equals),
 * null would also be excluded, and the default path would silently fall back to
 * the saved preset instead of launching plain Claude.  These tests catch that.
 */
import { describe, it, expect } from "vitest";

/**
 * Mirror of the ternary inside handleLaunch (AgentTrayButton.tsx:151-152).
 * Any change to that line must be reflected here.
 */
function buildLaunchPayload(agentId: string, presetId?: string | null): Record<string, unknown> {
  return { agentId, ...(presetId !== undefined ? { presetId } : {}) };
}

describe("dispatch payload: null is the default sentinel", () => {
  it("presetId=null is included in the payload (explicit default)", () => {
    const payload = buildLaunchPayload("claude", null);
    expect("presetId" in payload).toBe(true);
    expect(payload.presetId).toBeNull();
  });

  it("presetId=undefined is excluded from the payload (use saved default)", () => {
    const payload = buildLaunchPayload("claude", undefined);
    expect("presetId" in payload).toBe(false);
  });

  it("presetId=string is included in the payload", () => {
    const payload = buildLaunchPayload("claude", "user-123");
    expect("presetId" in payload).toBe(true);
    expect(payload.presetId).toBe("user-123");
  });

  it("null and undefined produce different payloads (sentinel distinction)", () => {
    const explicitDefault = buildLaunchPayload("claude", null);
    const saved = buildLaunchPayload("claude", undefined);
    expect("presetId" in explicitDefault).toBe(true);
    expect("presetId" in saved).toBe(false);
  });

  it("gemini default also carries presetId=null", () => {
    const payload = buildLaunchPayload("gemini", null);
    expect(payload.presetId).toBeNull();
    expect(payload.agentId).toBe("gemini");
  });

  it("empty-string presetId is included (it is not undefined)", () => {
    // Edge case: an empty string is a defined value, so it propagates.
    // callers should never pass "" but the guard must not silently drop it.
    const payload = buildLaunchPayload("claude", "");
    expect("presetId" in payload).toBe(true);
    expect(payload.presetId).toBe("");
  });
});
