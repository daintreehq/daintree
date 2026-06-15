import { describe, expect, it } from "vitest";
import { titleFor, warningLabelFor } from "../PluginMcpConfirmDialog";
import type { PluginMcpConsentReason } from "@shared/types/pluginMcpConsent";

// Reasons that mean "you approved this before, but something changed" — each
// must re-prompt with a distinct, non-first-use framing so a user can tell a
// rug-pull re-prompt apart from a routine first-time approval.
const REPROMPT_REASONS: PluginMcpConsentReason[] = [
  "raw-changed",
  "schema-changed",
  "annotation-changed",
  "revoked",
];

describe("PluginMcpConfirmDialog copy", () => {
  it("gives first-use a plain allow prompt with no warning badge", () => {
    expect(titleFor("first-use", "do_thing")).toBe("Allow 'do_thing' to run?");
    expect(warningLabelFor("first-use")).toBeNull();
  });

  it("frames every re-prompt reason distinctly from first-use", () => {
    const firstUse = titleFor("first-use", "do_thing");
    for (const reason of REPROMPT_REASONS) {
      expect(titleFor(reason, "do_thing")).not.toBe(firstUse);
    }
  });

  it("gives every re-prompt reason its own warning badge", () => {
    const labels = REPROMPT_REASONS.map((r) => warningLabelFor(r));
    // Each is present...
    expect(labels.every((l) => typeof l === "string" && l.length > 0)).toBe(true);
    // ...and distinct, so the badge names what actually changed.
    expect(new Set(labels).size).toBe(REPROMPT_REASONS.length);
  });

  it("does NOT let annotation-changed fall through to the generic first-use copy", () => {
    // This is the security-critical case: a server raising a pinned tool's
    // danger tier must re-prompt with a danger-specific framing, not a prompt
    // indistinguishable from approving the tool for the first time.
    expect(titleFor("annotation-changed", "do_thing")).not.toBe(titleFor("first-use", "do_thing"));
    expect(titleFor("annotation-changed", "do_thing").toLowerCase()).toContain("danger");
    expect(warningLabelFor("annotation-changed")).toBe("Danger level changed");
  });

  it("interpolates the tool name into re-prompt titles", () => {
    expect(titleFor("annotation-changed", "delete_repo")).toContain("delete_repo");
    expect(titleFor("raw-changed", "delete_repo")).toContain("delete_repo");
  });
});
