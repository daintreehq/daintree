import { describe, it, expect } from "vitest";
import {
  AssistantHostEventSchema,
  AssistantHostSessionDescriptorSchema,
  parseAssistantHostEvent,
  parseAssistantHostCommand,
  parseAssistantHostSessionDescriptor,
  ASSISTANT_HOST_PROTOCOL_VERSION,
} from "../ipc.js";
import type {
  AssistantHostEvent,
  AssistantHostCommand,
  AssistantHostCommandType,
  AssistantHostSessionDescriptor,
} from "../../../shared/types/ipc/assistantHost.js";

// One valid representative for every event variant — keeps the discriminated
// union honest: if a variant is added to the type without a schema arm (or
// vice versa), the round-trip below stops covering it.
//
// `seq` is on every one because v3 stamps it on every frame; it is what makes a lost
// frame detectable rather than silent, so an event without it is not a v3 event.
const VALID_EVENTS: AssistantHostEvent[] = [
  {
    type: "host:ready",
    sessionId: "s1",
    seq: 1,
    protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
    version: "daintree-70ee3d8",
    autoApprove: false,
  },
  { type: "turn:start", sessionId: "s1", seq: 2, turnId: "t1", role: "assistant", startedAt: 100 },
  { type: "turn:token", sessionId: "s1", seq: 3, turnId: "t1", chunk: "hello" },
  {
    type: "turn:end",
    sessionId: "s1",
    seq: 4,
    turnId: "t1",
    endedAt: 200,
    outcome: "answered",
    content: "hello there",
  },
  { type: "turn:phase", sessionId: "s1", seq: 5, turnId: "t1", phase: "generating" },
  { type: "turn:reasoning", sessionId: "s1", seq: 6, turnId: "t1", text: "considering options" },
  { type: "turn:interjection", sessionId: "s1", seq: 7, turnId: "t1", text: "actually, skip that" },
  {
    type: "tool:batch",
    sessionId: "s1",
    seq: 8,
    turnId: "t1",
    calls: [{ toolCallId: "c1", toolId: "fs.read", argsSummary: "<object>", danger: false }],
  },
  { type: "tool:state", sessionId: "s1", seq: 9, toolCallId: "c1", state: "waiting" },
  { type: "tool:progress", sessionId: "s1", seq: 10, toolCallId: "c1", message: "reading" },
  {
    type: "tool:started",
    sessionId: "s1",
    seq: 11,
    toolCallId: "c1",
    toolId: "fs.read",
    argsSummary: "<object>",
    startedAt: 150,
    danger: false,
  },
  {
    type: "tool:settled",
    sessionId: "s1",
    seq: 12,
    toolCallId: "c1",
    toolId: "fs.read",
    durationMs: 12,
    result: "success",
    severity: "info",
  },
  {
    type: "usage",
    sessionId: "s1",
    seq: 13,
    turnId: "t1",
    promptTokens: 900,
    completionTokens: 120,
    totalTokens: 1020,
    contextTokens: 31200,
    contextThreshold: 120000,
    contextWindow: 200000,
  },
  { type: "cost", sessionId: "s1", seq: 14, turnId: "t1", total: 0.0132, complete: false },
  { type: "notice", sessionId: "s1", seq: 15, level: "warning", message: "MCP degraded" },
  { type: "model:rate-limited", sessionId: "s1", seq: 16, turnId: "t1" },
  {
    type: "approval:requested",
    sessionId: "s1",
    seq: 17,
    approvalId: "a1",
    toolId: "git.push",
    summary: "push to origin/main",
    requestedAt: 300,
    riskClass: "git",
    needsTypedConfirm: true,
  },
  {
    type: "approval:decided",
    sessionId: "s1",
    seq: 18,
    approvalId: "a1",
    decision: "approved",
    decidedAt: 320,
  },
  {
    type: "host:error",
    sessionId: "s1",
    seq: 19,
    code: "MCP_UNREACHABLE",
    message: "no transport",
  },
  { type: "host:shutdown", sessionId: "s1", seq: 20, reason: "hibernate", resumeSessionId: "r9" },
];

const VALID_COMMANDS: AssistantHostCommand[] = [
  { type: "prompt", sessionId: "s1", text: "how do I rebase?" },
  { type: "approval:decide", sessionId: "s1", approvalId: "a1", decision: "rejected" },
  { type: "command", sessionId: "s1", line: "/status" },
  { type: "question:answer", sessionId: "s1", questionId: "q1", choiceIndex: 0 },
  { type: "operations", sessionId: "s1" },
  { type: "timers", sessionId: "s1" },
  { type: "timer:cancel", sessionId: "s1", timerId: "tmr_1" },
  { type: "interject:retract", sessionId: "s1" },
  { type: "interrupt", sessionId: "s1" },
  { type: "hibernate", sessionId: "s1" },
  { type: "shutdown", sessionId: "s1" },
];

/**
 * Every command type, as a compile-time exhaustive map.
 *
 * The TS union and the Zod schema are two separate declarations of one contract, and
 * nothing forced them to agree: `timers` and `timer:cancel` were added to the union
 * and to the engine, and the schema was missed. The union type-checked, the engine
 * accepted them, and the command was rejected at the IPC boundary and silently never
 * sent — a feature that fails only in the built app, where no unit test was looking.
 *
 * This map fails to COMPILE when a type joins the union without being listed, and the
 * test below fails when a listed type has no fixture or the schema rejects it.
 */
const ALL_COMMAND_TYPES: Record<AssistantHostCommandType, true> = {
  prompt: true,
  "approval:decide": true,
  "question:answer": true,
  command: true,
  operations: true,
  timers: true,
  "timer:cancel": true,
  "interject:retract": true,
  interrupt: true,
  hibernate: true,
  shutdown: true,
};

describe("AssistantHostEventSchema", () => {
  it.each(VALID_EVENTS)("round-trips the $type event unchanged", (event) => {
    const parsed = parseAssistantHostEvent(event);
    expect(parsed).toEqual(event);
  });

  it("rejects an unknown event type instead of guessing", () => {
    expect(parseAssistantHostEvent({ type: "turn:middle", sessionId: "s1" })).toBeNull();
  });

  it("rejects any event missing sessionId (delivery cannot be pinned without it)", () => {
    for (const event of VALID_EVENTS) {
      const { sessionId: _omit, ...withoutSession } = event as { sessionId: string };
      expect(AssistantHostEventSchema.safeParse(withoutSession).success).toBe(false);
    }
  });

  it("rejects an empty sessionId", () => {
    expect(parseAssistantHostEvent({ ...VALID_EVENTS[0], sessionId: "" })).toBeNull();
  });

  it("rejects a tool:settled result outside the audit vocabulary", () => {
    const base = VALID_EVENTS.find((e) => e.type === "tool:settled")!;
    expect(parseAssistantHostEvent({ ...base, result: "maybe" })).toBeNull();
  });

  it("rejects an approval decision outside the confirmation vocabulary", () => {
    const base = VALID_EVENTS.find((e) => e.type === "approval:decided")!;
    expect(parseAssistantHostEvent({ ...base, decision: "later" })).toBeNull();
  });

  it("drops a turn:end with an out-of-vocabulary outcome", () => {
    const base = VALID_EVENTS.find((e) => e.type === "turn:end")!;
    expect(parseAssistantHostEvent({ ...base, outcome: "vibes" })).toBeNull();
  });
});

describe("AssistantHostCommandSchema", () => {
  it.each(VALID_COMMANDS)("round-trips the $type command unchanged", (command) => {
    expect(parseAssistantHostCommand(command)).toEqual(command);
  });

  it("rejects an unknown command type", () => {
    expect(parseAssistantHostCommand({ type: "selfdestruct", sessionId: "s1" })).toBeNull();
  });

  it("rejects an approval:decide carrying an invalid decision", () => {
    expect(
      parseAssistantHostCommand({
        type: "approval:decide",
        sessionId: "s1",
        approvalId: "a1",
        decision: "perhaps",
      })
    ).toBeNull();
  });

  // The guard that would have caught `timers` / `timer:cancel` reaching the union and
  // the engine but never the schema.
  it("accepts every command type the union declares", () => {
    const covered = new Set(VALID_COMMANDS.map((c) => c.type));
    for (const type of Object.keys(ALL_COMMAND_TYPES) as AssistantHostCommandType[]) {
      expect(covered.has(type), `${type} has no fixture — it is validated by nothing`).toBe(true);
    }
    for (const command of VALID_COMMANDS) {
      expect(
        parseAssistantHostCommand(command),
        `${command.type} is in the union but the schema rejects it — it would be dropped at the IPC boundary and never sent`
      ).not.toBeNull();
    }
  });

  it("event and command discriminants do not overlap", () => {
    const eventTypes = new Set(VALID_EVENTS.map((e) => e.type));
    const commandTypes = VALID_COMMANDS.map((c) => c.type);
    for (const t of commandTypes) {
      // approval:decide (command) is distinct from approval:requested/decided (events)
      expect(eventTypes.has(t as never)).toBe(false);
    }
  });
});

describe("AssistantHostSessionDescriptorSchema", () => {
  const descriptor: AssistantHostSessionDescriptor = {
    sessionId: "s1",
    windowId: 3,
    projectId: "proj-1",
    cwd: "/tmp/worktree",
    tier: "workbench",
    protocolVersion: ASSISTANT_HOST_PROTOCOL_VERSION,
  };

  it("accepts a valid descriptor and an optional resume handle", () => {
    expect(parseAssistantHostSessionDescriptor(descriptor)).toEqual(descriptor);
    expect(
      parseAssistantHostSessionDescriptor({ ...descriptor, resumeSessionId: "r1" })
    ).toMatchObject({ resumeSessionId: "r1" });
  });

  it("rejects a descriptor that smuggles a bearer token (secrets travel via env, not messages)", () => {
    expect(
      parseAssistantHostSessionDescriptor({ ...descriptor, token: "secret-bearer" })
    ).toBeNull();
  });

  it("rejects a descriptor that smuggles an mcpUrl field", () => {
    expect(
      parseAssistantHostSessionDescriptor({ ...descriptor, mcpUrl: "http://127.0.0.1:9000" })
    ).toBeNull();
  });

  it("rejects a non-integer windowId", () => {
    expect(
      AssistantHostSessionDescriptorSchema.safeParse({ ...descriptor, windowId: 1.5 }).success
    ).toBe(false);
  });

  it("rejects a non-positive protocol version", () => {
    expect(
      AssistantHostSessionDescriptorSchema.safeParse({ ...descriptor, protocolVersion: 0 }).success
    ).toBe(false);
  });

  it("rejects a negative windowId (matches the >= 0 invariant the service enforces)", () => {
    expect(
      AssistantHostSessionDescriptorSchema.safeParse({ ...descriptor, windowId: -1 }).success
    ).toBe(false);
  });

  it("rejects a whitespace-only sessionId (would fail delivery pinning)", () => {
    expect(parseAssistantHostSessionDescriptor({ ...descriptor, sessionId: "   " })).toBeNull();
  });
});

describe("numeric and blank-id bounds on events", () => {
  const turnEnd = VALID_EVENTS.find((e) => e.type === "turn:end")!;
  const toolSettled = VALID_EVENTS.find((e) => e.type === "tool:settled")!;
  const turnStart = VALID_EVENTS.find((e) => e.type === "turn:start")!;

  it("rejects a negative timestamp", () => {
    expect(parseAssistantHostEvent({ ...turnEnd, endedAt: -1 })).toBeNull();
  });

  it("rejects a non-finite timestamp", () => {
    expect(
      parseAssistantHostEvent({ ...turnStart, startedAt: Number.POSITIVE_INFINITY })
    ).toBeNull();
    expect(parseAssistantHostEvent({ ...turnStart, startedAt: Number.NaN })).toBeNull();
  });

  it("rejects a negative tool durationMs", () => {
    expect(parseAssistantHostEvent({ ...toolSettled, durationMs: -50 })).toBeNull();
  });

  it("rejects a whitespace-only turnId", () => {
    expect(parseAssistantHostEvent({ ...turnEnd, turnId: "  " })).toBeNull();
  });

  it("strips an extra field rather than forwarding it (secrets never ride an event)", () => {
    const base = VALID_EVENTS.find((e) => e.type === "host:error")!;
    const parsed = parseAssistantHostEvent({ ...base, token: "secret-bearer" }) as Record<
      string,
      unknown
    > | null;
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("token");
  });
});

describe("AssistantHostCommandSchema / EventSchema separation", () => {
  it("a command does not parse as an event", () => {
    expect(parseAssistantHostEvent({ type: "prompt", sessionId: "s1", text: "hi" })).toBeNull();
  });

  it("an event does not parse as a command", () => {
    expect(
      parseAssistantHostCommand({ type: "turn:token", sessionId: "s1", turnId: "t1", chunk: "x" })
    ).toBeNull();
  });
});
