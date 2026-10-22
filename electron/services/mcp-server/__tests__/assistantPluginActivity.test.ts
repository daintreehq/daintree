import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { PluginMcpGrant } from "../../pluginAgentMcp/grantRegistry.js";
import {
  observeAssistantPluginToolCall,
  type AssistantPluginActivityDeps,
  type AssistantPluginLane,
} from "../assistantPluginActivity.js";

const PROJECT = "a".repeat(64);

function grant(overrides: Partial<PluginMcpGrant> = {}): PluginMcpGrant {
  return {
    credentialId: "cred-1",
    bearerSha256: "digest",
    pluginInstanceId: "acme.ledger",
    scope: { databases: true },
    serverName: "daintree-ledger",
    projectId: PROJECT,
    terminalId: "help-term",
    consumer: "assistant",
    issuedAt: 0,
    ...overrides,
  };
}

function harness(lanes: Array<AssistantPluginLane | null> = []) {
  const lane: AssistantPluginLane = { helpSessionId: "help-1", webContentsId: 7, tier: "core" };
  const sent: Array<{ webContentsId: number; channel: string; payload: unknown }> = [];
  let clock = 1_000;
  const resolveLane = vi.fn((_terminalId: string) => (lanes.length > 0 ? lanes.shift()! : lane));
  const appendAuditRecord = vi.fn();
  const deps: AssistantPluginActivityDeps = {
    resolveLane,
    getCurrentTurnId: () => "turn-9",
    appendAuditRecord,
    send: (webContentsId, channel, buildPayload) =>
      sent.push({ webContentsId, channel, payload: buildPayload() }),
    now: () => clock,
  };
  return {
    deps,
    sent,
    appendAuditRecord,
    resolveLane,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("observeAssistantPluginToolCall", () => {
  it("observes nothing for a grant issued to an agent the user launched", () => {
    const h = harness();
    const { consumer: _consumer, ...terminalGrant } = grant();
    expect(
      observeAssistantPluginToolCall(h.deps, terminalGrant, "entries", ["month"])
    ).toBeUndefined();
    expect(h.resolveLane).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it("observes nothing once the terminal no longer serves a lane", () => {
    const h = harness([null]);
    expect(observeAssistantPluginToolCall(h.deps, grant(), "entries", [])).toBeUndefined();
    expect(h.sent).toHaveLength(0);
    expect(h.appendAuditRecord).not.toHaveBeenCalled();
  });

  it("pushes the start and the settle to the lane's view, named by server key and tool", () => {
    const h = harness();
    const settle = observeAssistantPluginToolCall(h.deps, grant(), "entries", ["month", "limit"]);
    expect(h.sent).toEqual([
      {
        webContentsId: 7,
        channel: CHANNELS.MCP_TOOL_CALL_STARTED,
        payload: {
          sessionId: "help-1",
          toolId: "daintree-ledger.entries",
          argsSummary: "month, limit",
          startedAt: 1_000,
          danger: false,
          turnId: "turn-9",
        },
      },
    ]);

    h.advance(250);
    settle!("ok");
    expect(h.sent[1]).toEqual({
      webContentsId: 7,
      channel: CHANNELS.MCP_TOOL_CALL_SETTLED,
      payload: {
        sessionId: "help-1",
        toolId: "daintree-ledger.entries",
        durationMs: 250,
        result: "success",
        severity: expect.any(String),
        turnId: "turn-9",
      },
    });
  });

  it("records the call against the help session, with argument names and no values", () => {
    const h = harness();
    observeAssistantPluginToolCall(h.deps, grant(), "database_query", ["sql"])!("ok");
    expect(h.appendAuditRecord).toHaveBeenCalledTimes(1);
    const record = h.appendAuditRecord.mock.calls[0]![0];
    expect(record).toMatchObject({
      toolId: "daintree-ledger.database_query",
      sessionId: "cred-1",
      helpSessionId: "help-1",
      tier: "core",
      argsSummary: "sql",
      turnId: "turn-9",
      startedAt: 1_000,
    });
    expect(record.args).toBeUndefined();
  });

  it("settles a tool error as an error, once", () => {
    const h = harness();
    const settle = observeAssistantPluginToolCall(h.deps, grant(), "entries", [])!;
    settle("error");
    settle("ok");
    const settled = h.sent.filter((s) => s.channel === CHANNELS.MCP_TOOL_CALL_SETTLED);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({ result: "error", errorCode: "EXECUTION_ERROR" });
    expect(h.appendAuditRecord).toHaveBeenCalledTimes(1);
  });

  it("settles to the view the lane moved to while the call ran", () => {
    const moved: AssistantPluginLane = { helpSessionId: "help-1", webContentsId: 12, tier: "core" };
    const h = harness([{ helpSessionId: "help-1", webContentsId: 7, tier: "core" }, moved]);
    observeAssistantPluginToolCall(h.deps, grant(), "entries", [])!("ok");
    expect(h.sent.map((s) => s.webContentsId)).toEqual([7, 12]);
  });

  it("keeps the settle on the session it started in when the terminal now serves another", () => {
    const other: AssistantPluginLane = { helpSessionId: "help-2", webContentsId: 12, tier: "full" };
    const h = harness([{ helpSessionId: "help-1", webContentsId: 7, tier: "core" }, other]);
    observeAssistantPluginToolCall(h.deps, grant(), "entries", [])!("ok");
    const settled = h.sent[1]!;
    expect(settled.webContentsId).toBe(7);
    expect(settled.payload).toMatchObject({ sessionId: "help-1" });
    expect(h.appendAuditRecord.mock.calls[0]![0]).toMatchObject({ helpSessionId: "help-1" });
  });
});
