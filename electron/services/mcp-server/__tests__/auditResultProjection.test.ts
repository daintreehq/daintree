import { describe, expect, it } from "vitest";
import { projectAuditResult } from "../auditResultProjection.js";

const TOOL = "terminal.readLastMessageOwned";
const PROSE = "PROSE-SENTINEL the agent's private hand-off";
const QUESTION = "QUESTION-SENTINEL which database?";

const OK_RESULT = {
  status: "ok",
  provider: "claude",
  message: {
    id: "msg_1",
    text: PROSE,
    truncated: false,
    recordedAt: 1,
    stopReason: "end_turn",
  },
  unansweredToolUses: [
    { id: "toolu_q", name: "AskUserQuestion", input: { questions: [{ question: QUESTION }] } },
    { id: "toolu_b", name: "Bash" },
  ],
  newerRecordsFollow: false,
  fileUpdatedAt: 1,
};

describe("projectAuditResult — terminal.readLastMessageOwned (#12479)", () => {
  it("keeps the shape of a reply and none of its content", () => {
    const projected = projectAuditResult(TOOL, OK_RESULT);

    expect(projected).toEqual({
      status: "ok",
      provider: "claude",
      messageChars: PROSE.length,
      unansweredToolNames: ["AskUserQuestion", "Bash"],
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("SENTINEL");
    expect(serialized).not.toContain("msg_1");
  });

  it("keeps an unavailable result's reason", () => {
    expect(projectAuditResult(TOOL, { status: "unavailable", reason: "store-unknown" })).toEqual({
      status: "unavailable",
      reason: "store-unknown",
    });
  });

  it("reports a reply with no text as no characters rather than zero", () => {
    const projected = projectAuditResult(TOOL, { ...OK_RESULT, message: null });

    expect(projected).toMatchObject({ messageChars: null });
  });

  // A projection that fell back to the raw value on an unexpected shape would
  // put the text straight back in the moment the shape drifted.
  it("reduces a result of any other shape to a marker, never the raw value", () => {
    for (const odd of [PROSE, null, [PROSE], { text: PROSE }, { status: "weird", text: PROSE }]) {
      expect(projectAuditResult(TOOL, odd)).toEqual({ status: "unrecognized" });
    }
    expect(
      projectAuditResult(TOOL, { status: "unavailable", reason: PROSE, detail: PROSE })
    ).toEqual({ status: "unavailable", reason: null });
    expect(
      JSON.stringify(
        projectAuditResult(TOOL, {
          ...OK_RESULT,
          provider: PROSE,
          unansweredToolUses: [{ name: 42, input: PROSE }, PROSE],
        })
      )
    ).not.toContain("SENTINEL");
  });

  it("passes every other tool's result through unchanged", () => {
    const result = { text: PROSE };

    expect(projectAuditResult("terminal.getOutput", result)).toBe(result);
    // A lookup table that inherited from Object would treat these as tools.
    expect(projectAuditResult("constructor", result)).toBe(result);
    expect(projectAuditResult("__proto__", result)).toBe(result);
  });
});
