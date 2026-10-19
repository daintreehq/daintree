import { describe, expect, it } from "vitest";
import {
  auditVerbatimArgKeys,
  projectAuditArgs,
  projectAuditResult,
  projectRelayedAuditArgs,
} from "../auditResultProjection.js";
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

describe("another assistant's reply read off its screen (#13496)", () => {
  it("keeps its source and size, never its words", () => {
    const projected = projectAuditResult(TOOL, {
      status: "observed",
      source: "handback",
      text: PROSE,
      truncated: false,
    });
    expect(projected).toEqual({
      status: "observed",
      source: "handback",
      textChars: PROSE.length,
      truncated: false,
    });
    expect(JSON.stringify(summarizeMcpResult(projected))).not.toContain("PROSE-SENTINEL");
  });

  it("drops a source it doesn't know", () => {
    expect(
      projectAuditResult(TOOL, { status: "observed", source: PROSE, text: "x" })
    ).toMatchObject({ source: null, textChars: 1 });
  });
});

describe("host.list audit projection (#13493)", () => {
  it("names hosts by id and counts their projects, never naming one", () => {
    const projected = projectAuditResult("host.list", {
      hosts: [
        {
          hostId: "studio",
          name: "Greg's studio",
          projects: [{ projectId: "p-1", name: "PROJECT-SENTINEL" }],
        },
        { hostId: "laptop", name: "laptop", projects: null },
      ],
    });
    expect(projected).toEqual({
      hostCount: 2,
      hostIds: ["studio", "laptop"],
      projectCounts: [1, null],
    });
    expect(JSON.stringify(projected)).not.toContain("PROJECT-SENTINEL");
  });
});

describe("plugin.capturePanel audit projection (#13384)", () => {
  it("records the capture's size and message count, never the pixels or the messages", () => {
    const data = Buffer.from("PIXEL-SENTINEL").toString("base64");
    const projected = projectAuditResult("plugin.capturePanel", {
      panelId: "p1",
      pluginId: "acme.dashboard",
      image: { mimeType: "image/png", data, width: 300, height: 200 },
      consoleScope: "plugin",
      consoleMessages: [{ level: "error", message: "MESSAGE-SENTINEL" }],
    });

    expect(projected).toEqual({
      width: 300,
      height: 200,
      imageBytes: Buffer.byteLength(data, "base64"),
      consoleMessageCount: 1,
    });
    const audited = JSON.stringify(summarizeMcpResult(projected));
    expect(audited).not.toContain(data);
    expect(audited).not.toContain("MESSAGE-SENTINEL");
  });

  it("reduces a result of another shape to a marker", () => {
    expect(projectAuditResult("plugin.capturePanel", { pngBase64: "x" })).toEqual({
      status: "unrecognized",
    });
  });
});

describe("project.runCommand audit entries keep the command, never its output (#13495)", () => {
  const OUTPUT = "OUTPUT-SENTINEL token=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const COMMAND = "git -C /repo/worktrees/feature-a log --oneline -20 --decorate --no-color";
  const scrub = (value: string) => value;

  it("keeps a command longer than the inline limit whole in the summary", () => {
    const summary = summarizeMcpArgs(
      projectAuditArgs("project.runCommand", {
        projectId: "proj-1",
        command: COMMAND,
        cwd: "/repo",
        stray: "x".repeat(80),
      }),
      scrub,
      auditVerbatimArgKeys("project.runCommand")
    );

    expect(COMMAND.length).toBeGreaterThan(50);
    expect(JSON.parse(summary)).toEqual({
      projectId: "proj-1",
      command: COMMAND,
      cwd: "/repo",
      timeoutMs: null,
    });
  });

  it("records how a run ended and how much it printed, never what", () => {
    const projected = projectAuditResult("project.runCommand", {
      projectId: "proj-1",
      cwd: "/repo",
      exitCode: 1,
      signalName: null,
      durationMs: 42,
      timedOut: false,
      aborted: false,
      output: OUTPUT,
      outputTruncated: true,
    });

    expect(JSON.stringify(projected)).not.toContain("SENTINEL");
    expect(summarizeMcpResult(projected)).not.toContain("SENTINEL");
    expect(projected).toEqual({
      exitCode: 1,
      signalName: null,
      timedOut: false,
      aborted: false,
      durationMs: 42,
      outputChars: OUTPUT.length,
      outputTruncated: true,
    });
  });

  it("reduces a result of another shape to a marker", () => {
    expect(projectAuditResult("project.runCommand", OUTPUT)).toEqual({ status: "unrecognized" });
  });

  it("keeps every other tool's long strings collapsed", () => {
    expect(auditVerbatimArgKeys("terminal.sendCommand")).toBeUndefined();
  });
});

describe("host.call audit projection (#13493)", () => {
  const CALL_ID = "8f14e45f-ceea-467a-9b2c-5a1f6a2b9c11";

  it("keeps the host, tool and callId, and the tool's own arguments flat, never short prompts", () => {
    const projected = projectAuditArgs("host.call", {
      hostId: "studio-01",
      projectId: "not a uuid",
      tool: "agent.launch",
      callId: CALL_ID,
      args: { agentId: "claude", prompt: "rm -rf now", notify: false },
    });

    expect(projected).toEqual({
      hostId: "studio-01",
      projectId: null,
      tool: "agent.launch",
      callId: CALL_ID,
      "args.agentId": "claude",
      "args.prompt": "<string: 10 chars>",
      "args.notify": false,
    });
    expect(summarizeMcpArgs(projected)).not.toContain("rm -rf");
  });

  it("applies the relayed tool's own projection, and keeps what it names to its length", () => {
    const projected = projectAuditArgs("host.call", {
      hostId: "studio-01",
      tool: "project.runCommand",
      args: { projectId: "p", command: "COMMAND-SENTINEL", timeoutMs: 5, extra: "dropped" },
    }) as Record<string, unknown>;

    expect(projected["args.command"]).toBe(`<string: ${"COMMAND-SENTINEL".length} chars>`);
    expect(projected["args.timeoutMs"]).toBe(5);
    expect(Object.hasOwn(projected, "args.extra")).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("COMMAND-SENTINEL");
  });

  it("drops a tool name that isn't one, and never projects a relay of a relay", () => {
    expect(
      projectAuditArgs("host.call", {
        hostId: "studio-01",
        tool: "say hello to the team",
        args: { prompt: "x" },
      })
    ).toEqual({ hostId: "studio-01", projectId: null, tool: null, callId: null });
    expect(
      projectAuditArgs("host.call", {
        hostId: "studio-01",
        tool: "host.call",
        args: { tool: "agent.launch", args: { prompt: "nested" } },
      })
    ).toEqual({ hostId: "studio-01", projectId: null, tool: "host.call", callId: null });
  });

  it("keeps nothing anyone wrote when the host audits a call relayed to it, however short", () => {
    const projected = projectRelayedAuditArgs("agent.launch", {
      agentId: "claude",
      prompt: "fix it",
      notify: false,
    });

    expect(projected).toEqual({
      agentId: "claude",
      prompt: "<string: 6 chars>",
      notify: false,
    });
    expect(
      projectRelayedAuditArgs("agent.launch", { systemPrompt: "be terse", title: "Fix login" })
    ).toEqual({ systemPrompt: "<string: 8 chars>", title: "<string: 9 chars>" });
    expect(projectRelayedAuditArgs("terminal.sendKeys", { choose: "2" })).toEqual({
      choose: "<string: 1 chars>",
    });
    // A tool with a projection of its own keeps it, and its text to its length.
    expect(
      projectRelayedAuditArgs("project.runCommand", { projectId: "p", command: "ls", extra: "x" })
    ).toEqual({ projectId: "p", command: "<string: 2 chars>", cwd: null, timeoutMs: null });
  });

  it("records only the outcome, callId and whether the tool failed, never its result", () => {
    const projected = projectAuditResult("host.call", {
      outcome: "ok",
      detail: null,
      retryAfterMs: null,
      callId: CALL_ID,
      result: { isError: false, structured: { output: "OUTPUT-SENTINEL" }, text: null },
    });

    expect(projected).toEqual({ outcome: "ok", callId: CALL_ID, isError: false });
    expect(JSON.stringify(summarizeMcpResult(projected))).not.toContain("OUTPUT-SENTINEL");
    expect(projectAuditResult("host.call", "nope")).toEqual({ status: "unrecognized" });
  });
});
