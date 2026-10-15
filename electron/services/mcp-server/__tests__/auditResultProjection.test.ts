import { describe, expect, it } from "vitest";
import { projectAuditArgs, projectAuditResult } from "../auditResultProjection.js";
import { summarizeMcpArgs, summarizeMcpResult } from "../../../../shared/utils/mcpArgsSummary.js";

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

describe("assistant messaging audit entries carry no body (#13335)", () => {
  const SHORT = "BODY-SENTINEL ok";
  const LONG = `BODY-SENTINEL ${"x".repeat(10_000)}`;
  const HOST = "HOST-SENTINEL";
  const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it.each([SHORT, LONG])("summarizes a reply's arguments without its text", (text) => {
    const summary = summarizeMcpArgs(
      projectAuditArgs("assistant.reply", { taskId: TASK, state: "completed", text })
    );
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(JSON.parse(summary)).toEqual({
      taskId: TASK,
      state: "completed",
      textChars: text.length,
    });
  });

  it("drops a task id that is not one the store mints, however id-shaped", () => {
    const summary = summarizeMcpArgs(
      projectAuditArgs("assistant.reply", {
        taskId: "BODY-SENTINEL",
        state: "completed",
        text: "x",
      })
    );
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(JSON.parse(summary).taskId).toBeNull();
  });

  it("measures, never keeps, a malformed reply's fields", () => {
    const summary = summarizeMcpArgs(
      projectAuditArgs("assistant.reply", {
        taskId: "BODY-SENTINEL smuggled in an id",
        state: "BODY-SENTINEL",
        text: 42,
        extra: SHORT,
      })
    );
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(JSON.parse(summary)).toEqual({ taskId: null, state: null, textChars: null });
  });

  it("summarizes an inbox page by its size, without bodies or sender labels", () => {
    const result = {
      messages: [SHORT, LONG].map((body, i) => ({
        taskId: i === 0 ? TASK : "not-a-uuid",
        messageId: `msg-${i}`,
        contextId: "ctx",
        state: "submitted",
        receivedAt: 1,
        provenance: { sendingHost: HOST, sendingLane: HOST, hopCount: 1 },
        bodyChars: body.length,
        untrustedBody: body,
      })),
      cursor: 2,
      hasMore: false,
    };
    const summary = summarizeMcpResult(projectAuditResult("assistant.getInbox", result));
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(summary).not.toContain("HOST-SENTINEL");
    expect(projectAuditResult("assistant.getInbox", result)).toEqual({
      messageCount: 2,
      bodyChars: SHORT.length + LONG.length,
      taskIds: [TASK, null],
      cursor: 2,
      hasMore: false,
    });
    expect(projectAuditResult("assistant.getInbox", { text: SHORT })).toEqual({
      status: "unrecognized",
    });
  });

  it.each([SHORT, LONG])("measures, never keeps, what a lane sends the hub (#13338)", (text) => {
    const summary = summarizeMcpArgs(
      projectAuditArgs("assistant.sendMessage", {
        text,
        contextId: "BODY-SENTINEL as a context",
        referenceTaskIds: [TASK, "BODY-SENTINEL"],
      })
    );
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(JSON.parse(summary)).toEqual({
      contextId: null,
      referenceTaskIds: 2,
      textChars: text.length,
    });
    expect(
      projectAuditResult("assistant.sendMessage", {
        messageId: TASK,
        contextId: TASK,
        hopCount: 1,
        state: "waiting-for-hub",
      })
    ).toEqual({ messageId: TASK, contextId: TASK, hopCount: 1, state: "waiting-for-hub" });
  });

  it("summarizes the sent view by state and reply size, never the hub's words (#13338)", () => {
    const result = {
      messages: [],
      sent: [
        {
          messageId: TASK,
          contextId: "ctx",
          hopCount: 1,
          state: "completed",
          refusal: null,
          sentAt: 1,
          expiresAt: 2,
          replies: [{ state: "completed", at: 1, untrustedText: LONG }],
        },
        {
          messageId: "BODY-SENTINEL",
          contextId: "ctx",
          hopCount: 2,
          state: "BODY-SENTINEL",
          refusal: "hop_limit",
          sentAt: 1,
          expiresAt: 2,
          replies: [],
        },
      ],
      cursor: 4,
      hasMore: false,
    };
    const summary = summarizeMcpResult(projectAuditResult("assistant.getInbox", result));
    expect(summary).not.toContain("BODY-SENTINEL");
    expect(projectAuditResult("assistant.getInbox", result)).toEqual({
      messageCount: 0,
      bodyChars: 0,
      taskIds: [],
      sentCount: 2,
      sent: [
        { messageId: TASK, state: "completed", refusal: null },
        { messageId: null, state: null, refusal: "hop_limit" },
      ],
      replyCount: 1,
      replyChars: LONG.length,
      cursor: 4,
      hasMore: false,
    });
  });

  it("leaves other tools' arguments to the generic summarizer", () => {
    const args = { url: "https://daintree.org/a.png" };
    expect(projectAuditArgs("help.displayImage", args)).toBe(args);
  });
});

describe("hub messaging audit entries carry no message or reply text (#13336)", () => {
  const TEXT = "rebase it now";

  it("measures, never keeps, what a send says", () => {
    const projected = projectAuditArgs("host.sendMessage", {
      hostId: "studio",
      projectId: "proj-2",
      slot: 1,
      generation: "gen",
      text: TEXT,
      taskId: "my words here",
      referenceTaskIds: ["a", "b"],
      waitMs: 500,
    });
    expect(JSON.stringify(projected)).not.toContain("rebase");
    expect(JSON.stringify(projected)).not.toContain("my words");
    expect(projected).toMatchObject({
      hostId: "studio",
      slot: 1,
      taskId: null,
      referenceTaskIds: 2,
      waitMs: 500,
      textChars: TEXT.length,
    });
  });

  it("reduces a task's replies to their count and size", () => {
    const taskId = "0b6b7c2e-1d55-4f6f-9a3a-4f3d2b1c0a99";
    const projected = projectAuditResult("host.getTask", {
      outcome: "ok",
      detail: null,
      retryAfterMs: null,
      task: { taskId, state: "completed" },
      observedAt: 1,
      replies: [{ state: "completed", at: 1, untrustedText: TEXT }],
      repliesOmitted: 0,
    });
    expect(JSON.stringify(projected)).not.toContain("rebase");
    expect(projected).toEqual({
      outcome: "ok",
      taskId,
      state: "completed",
      replyCount: 1,
      replyChars: TEXT.length,
      repliesOmitted: 0,
    });
  });

  it("keeps only a known outcome, and summarizes a host list by its ids", () => {
    expect(projectAuditResult("host.cancelTask", { outcome: TEXT, hostId: "h" })).toMatchObject({
      outcome: null,
    });
    expect(
      projectAuditResult("host.list", { hosts: [{ hostId: "studio", name: "Greg's studio" }] })
    ).toEqual({ hostCount: 1, hostIds: ["studio"] });
  });

  it("counts a host's projects and assistants, never naming either", () => {
    const projected = projectAuditResult("host.listAssistants", {
      outcome: "ok",
      detail: null,
      retryAfterMs: null,
      projects: [
        {
          projectId: "p-secret",
          name: "acquisition-plans",
          path: "/Users/someone/acquisition-plans",
          assistants: [
            { slot: 0, agentId: "claude", generation: "g", available: true },
            { slot: 1, agentId: "claude", generation: null, available: false },
          ],
        },
        { projectId: "p-2", name: "notes", path: "/Users/someone/notes", assistants: [] },
      ],
      projectsOmitted: 7,
    });
    expect(projected).toMatchObject({
      outcome: "ok",
      projectCount: 2,
      assistantCount: 2,
      projectsOmitted: 7,
    });
    expect(JSON.stringify(projected)).not.toMatch(/acquisition|notes|someone|p-secret/);
  });
});
