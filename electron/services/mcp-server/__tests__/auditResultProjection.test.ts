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
    nextCursor: "CURSOR-SENTINEL",
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

describe("projectAuditResult — handback carriers (#12488)", () => {
  const HANDBACK_TEXT = "HANDBACK-SENTINEL fixed the auth bug";
  const handback = {
    message: HANDBACK_TEXT,
    observedAt: 1_700_000_000_000,
    submissionToken: "tok-1",
    truncated: false,
  };
  const reduced = {
    messageChars: HANDBACK_TEXT.length,
    observedAt: 1_700_000_000_000,
    submissionToken: "tok-1",
    truncated: false,
  };

  it("reduces the handback on each status row and keeps everything else", () => {
    const result = {
      terminals: [
        { terminalId: "t1", agentState: "waiting", lastHandback: handback },
        { terminalId: "t2", agentState: "working" },
      ],
      source: "renderer",
      unavailableFields: [],
    };

    const projected = projectAuditResult("terminal.getStatus", result);

    expect(projected).toEqual({
      terminals: [
        { terminalId: "t1", agentState: "waiting", lastHandback: reduced },
        { terminalId: "t2", agentState: "working" },
      ],
      source: "renderer",
      unavailableFields: [],
    });
    expect(JSON.stringify(projected)).not.toContain("SENTINEL");
  });

  it("reduces the handback on a single wait and on each batched row", () => {
    const single = projectAuditResult("terminal.waitUntilIdle", {
      terminalId: "t1",
      busyState: "idle",
      trackingState: "tracked",
      timedOut: false,
      lastHandback: handback,
    });
    const batch = projectAuditResult("terminal.waitUntilIdleBatch", {
      mode: "first",
      results: [{ terminalId: "t1", settled: true, lastHandback: handback }],
      settledTerminalIds: ["t1"],
      timedOut: false,
    });

    expect(single).toMatchObject({ terminalId: "t1", lastHandback: reduced });
    expect(batch).toMatchObject({ results: [{ terminalId: "t1", lastHandback: reduced }] });
    expect(JSON.stringify([single, batch])).not.toContain("SENTINEL");
  });

  it("records a bare handback as having no message", () => {
    const projected = projectAuditResult("terminal.waitUntilIdle", {
      terminalId: "t1",
      lastHandback: { message: null, observedAt: 5, truncated: false },
    });

    expect(projected).toEqual({
      terminalId: "t1",
      lastHandback: {
        messageChars: null,
        observedAt: 5,
        submissionToken: undefined,
        truncated: false,
      },
    });
  });

  it("leaves a result without a handback untouched", () => {
    const result = {
      terminalId: "t1",
      busyState: "idle",
      trackingState: "tracked",
      timedOut: false,
    };
    expect(projectAuditResult("terminal.waitUntilIdle", result)).toEqual(result);
  });
});
