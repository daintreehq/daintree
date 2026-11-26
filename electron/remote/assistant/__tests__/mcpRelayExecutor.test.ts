import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpCallPayload } from "../linkMethods.js";
import {
  createMcpRelayExecutor,
  type McpRelayExecutor,
  type RelayMcpSessionSpec,
} from "../mcpRelayExecutor.js";
import { setPluginAssistantReachSource } from "../../../services/plugin/pluginAssistantReach.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const SPEC: RelayMcpSessionSpec = {
  linkSessionId: "local",
  senderId: "local",
  helpSessionId: "help-1",
  projectId: "proj-2",
  tier: "core",
  shellName: "greg-mbp",
  local: true,
  deliverNotices: () => {},
  requestApproval: async () => ({ decision: "unavailable" }),
};

const PAYLOAD: McpCallPayload = {
  helpSessionId: "help-1",
  projectId: "proj-2",
  tier: "core",
  callId: "call-1",
  resend: false,
  tool: "terminal.list",
  args: {},
  runMs: 90_000,
};

const ANSWER: CallToolResult = { content: [], structuredContent: { terminals: [] } };

describe("createMcpRelayExecutor ending a caller (#14024)", () => {
  let executor: McpRelayExecutor | undefined;

  afterEach(() => executor?.dispose());

  function harness(hooks: {
    hasProject?: () => Promise<boolean>;
    opened?: Promise<void>;
    answer?: () => Promise<CallToolResult>;
  }) {
    const sessions: Array<{ closed: boolean }> = [];
    const retired: Array<[string, string]> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: hooks.hasProject ?? (async () => true),
      openSession: async () => {
        const session = { closed: false };
        sessions.push(session);
        await hooks.opened;
        return {
          isOpen: () => !session.closed,
          callTool: async () => {
            if (session.closed) throw new Error("called on a closed session");
            return (hooks.answer ?? (async () => ANSWER))();
          },
          close: () => {
            session.closed = true;
          },
        };
      },
      retirePrincipal: (senderId, helpSessionId) => retired.push([senderId, helpSessionId]),
    });
    return { executor, sessions, retired };
  }

  it("lets a call running when its caller ended finish, then closes its session and ends its hold", async () => {
    const tool = deferred<CallToolResult>();
    const { executor, sessions, retired } = harness({ answer: () => tool.promise });
    const call = executor.call(SPEC, PAYLOAD);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    executor.endPrincipal("local", "help-1");
    expect(retired).toEqual([]);
    expect(sessions[0]!.closed).toBe(false);

    tool.resolve(ANSWER);
    await expect(call).resolves.toMatchObject({ status: "done" });
    expect(sessions[0]!.closed).toBe(true);
    expect(retired).toEqual([["local", "help-1"]]);
  });

  it("closes the session a call still being admitted opens once it ends, and ends the hold", async () => {
    const admitted = deferred<boolean>();
    const { executor, sessions, retired } = harness({ hasProject: () => admitted.promise });
    const call = executor.call(SPEC, PAYLOAD);

    executor.endPrincipal("local", "help-1");
    admitted.resolve(true);

    await expect(call).resolves.toMatchObject({ status: "done" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(true);
    expect(retired).toEqual([["local", "help-1"]]);
  });

  it("serves a call whose session was still opening when its caller ended, then closes it", async () => {
    const opened = deferred<void>();
    const { executor, sessions, retired } = harness({ opened: opened.promise });
    const call = executor.call(SPEC, PAYLOAD);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    executor.endPrincipal("local", "help-1");
    expect(retired).toEqual([]);
    opened.resolve();

    await expect(call).resolves.toMatchObject({ status: "done", result: { isError: false } });
    expect(sessions[0]!.closed).toBe(true);
    expect(retired).toEqual([["local", "help-1"]]);
  });

  it("closes the session a cancelled call was opening when its caller ended meanwhile (#17985)", async () => {
    const opened = deferred<void>();
    const { executor, sessions, retired } = harness({ opened: opened.promise });
    const call = executor.call(SPEC, PAYLOAD);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    expect(executor.cancel(SPEC.senderId, PAYLOAD.helpSessionId, PAYLOAD.callId)).toBe("aborted");
    executor.endPrincipal("local", "help-1");
    opened.resolve();

    await expect(call).resolves.toEqual({ status: "cancelled", dispatch: "before" });
    expect(sessions[0]!.closed).toBe(true);
    expect(retired).toEqual([["local", "help-1"]]);
  });

  it("ends the hold once the last of several running calls settles", async () => {
    const first = deferred<CallToolResult>();
    const second = deferred<CallToolResult>();
    const answers = [first.promise, second.promise];
    const { executor, retired } = harness({ answer: () => answers.shift()! });
    const one = executor.call(SPEC, PAYLOAD);
    const two = executor.call(SPEC, { ...PAYLOAD, callId: "call-2" });
    await vi.waitFor(() => expect(answers).toHaveLength(0));

    executor.endPrincipal("local", "help-1");
    first.resolve(ANSWER);
    await one;
    expect(retired).toEqual([]);

    second.resolve(ANSWER);
    await two;
    expect(retired).toEqual([["local", "help-1"]]);
  });

  it("keeps another help session's sessions and hold", async () => {
    const { executor, sessions, retired } = harness({});
    await executor.call(SPEC, PAYLOAD);

    executor.endPrincipal("local", "help-2");

    expect(sessions[0]!.closed).toBe(false);
    expect(retired).toEqual([]);
  });
});

describe("createMcpRelayExecutor timing a call from when it arrived (#15699)", () => {
  let executor: McpRelayExecutor | undefined;

  afterEach(() => executor?.dispose());

  function harness(admission: Promise<boolean>, clock: { at: number }) {
    const timeouts: number[] = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: () => admission,
      now: () => clock.at,
      openSession: async () => ({
        isOpen: () => true,
        callTool: async (_tool, _args, options) => {
          timeouts.push(options.timeoutMs);
          return ANSWER;
        },
        close: () => {},
      }),
    });
    return { executor, timeouts };
  }

  it("takes the time spent admitting it out of its run", async () => {
    const clock = { at: 1_000 };
    const admitted = deferred<boolean>();
    const { executor, timeouts } = harness(admitted.promise, clock);

    const call = executor.call(SPEC, PAYLOAD);
    clock.at += 20_000;
    admitted.resolve(true);

    await expect(call).resolves.toMatchObject({ status: "done" });
    expect(timeouts).toEqual([PAYLOAD.runMs - 20_000]);
  });

  it("runs nothing once admitting it used up its time", async () => {
    const clock = { at: 1_000 };
    const admitted = deferred<boolean>();
    const { executor, timeouts } = harness(admitted.promise, clock);

    const call = executor.call(SPEC, PAYLOAD);
    clock.at += PAYLOAD.runMs;
    admitted.resolve(true);

    await expect(call).resolves.toMatchObject({ status: "done", result: { isError: true } });
    expect(timeouts).toEqual([]);
  });
});

describe("createMcpRelayExecutor reads (#16191)", () => {
  let executor: McpRelayExecutor | undefined;

  afterEach(() => executor?.dispose());

  it("admits a read as a call is admitted, runs it each time, and refuses one that would arm a notice", async () => {
    let consent = true;
    const calls: Array<{ tool: string; callId: string }> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => consent,
      hasProject: async (projectId) => projectId === "proj-2",
      openSession: async () => ({
        isOpen: () => true,
        callTool: async (tool, _args, { callId }) => {
          calls.push({ tool, callId });
          return ANSWER;
        },
        close: () => {},
      }),
    });
    const read = { tool: "terminal.getStatus", args: { terminalIds: ["t-1"] }, runMs: 5_000 };

    await expect(executor.read(SPEC, read)).resolves.toMatchObject({ status: "done" });
    await expect(executor.read(SPEC, read)).resolves.toMatchObject({ status: "done" });
    // No record to answer a resend from: each read runs, under its own id.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.callId).not.toBe(calls[1]!.callId);

    await expect(executor.read({ ...SPEC, projectId: "proj-9" }, read)).resolves.toEqual({
      status: "refused",
      reason: "no-project",
    });
    await expect(
      executor.read(SPEC, { ...read, args: { ...read.args, notify: true } })
    ).resolves.toMatchObject({ status: "done", result: { isError: true } });
    consent = false;
    await expect(executor.read(SPEC, read)).resolves.toEqual({
      status: "refused",
      reason: "control-off",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("createMcpRelayExecutor and a caller's conversation (#17919)", () => {
  let executor: McpRelayExecutor | undefined;
  const DAY = 24 * 60 * 60_000;

  afterEach(() => {
    executor?.dispose();
    executor = undefined;
    vi.useRealTimers();
  });

  function harness(clock: { now: number }, hasProject: () => Promise<boolean> = async () => true) {
    const opened: RelayMcpSessionSpec[] = [];
    const retired: Array<[string, string, ...unknown[]]> = [];
    const forgotten: Array<[string, string]> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject,
      openSession: async (spec) => {
        opened.push(spec);
        return { isOpen: () => true, callTool: async () => ANSWER, close: () => {} };
      },
      retirePrincipal: (...args) => retired.push(args),
      forgetConversation: (senderId, conversationId) => forgotten.push([senderId, conversationId]),
      now: () => clock.now,
    });
    return { executor, opened, retired, forgotten };
  }

  const spec = (helpSessionId: string, conversationId?: string): RelayMcpSessionSpec => ({
    ...SPEC,
    helpSessionId,
    ...(conversationId !== undefined ? { conversationId } : {}),
  });
  const payload = (helpSessionId: string, callId = `call-${helpSessionId}`): McpCallPayload => ({
    ...PAYLOAD,
    helpSessionId,
    callId,
  });

  it("keeps an ended caller's conversation for a day from its last call, then forgets it", async () => {
    vi.useFakeTimers();
    const clock = { now: 5_000 };
    const { executor, retired, forgotten } = harness(clock);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    clock.now = 9_000;

    executor.endPrincipal("local", "help-1");
    expect(retired).toEqual([["local", "help-1", true]]);

    clock.now = 5_000 + DAY - 1;
    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([]);
    clock.now = 5_000 + DAY + 1;
    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("forgets the conversation of a hold that aged out, and keeps nothing for one that named none", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const { executor, retired, forgotten } = harness(clock);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    await executor.call(spec("help-2"), payload("help-2"));
    executor.endPrincipal("local", "help-2");

    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);

    expect(retired).toEqual([
      ["local", "help-2"],
      ["local", "help-1"],
    ]);
    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("gives an ended conversation back to its resumed caller, which holds it from then on", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const { executor, retired, forgotten } = harness(clock);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    executor.endPrincipal("local", "help-1");
    expect(retired).toEqual([["local", "help-1", true]]);

    clock.now = DAY / 2;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));
    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);

    expect(forgotten).toEqual([]);
  });

  it("forgets an ended conversation resumed after its day ran out, before the sweep did", async () => {
    const clock = { now: 0 };
    const { executor, forgotten } = harness(clock);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    executor.endPrincipal("local", "help-1");

    clock.now = DAY + 1;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("forgets the conversation of a resume refused before it ran, once its hold goes", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    let known = true;
    const { executor, forgotten } = harness(clock, async () => known);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    executor.endPrincipal("local", "help-1");
    known = false;
    await expect(executor.call(spec("help-2", "conv-1"), payload("help-2"))).resolves.toEqual({
      status: "refused",
      reason: "no-project",
    });

    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("forgets the conversation a caller leaves for another", async () => {
    const { executor, forgotten } = harness({ now: 0 });
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));

    await executor.call(spec("help-1", "conv-2"), payload("help-1", "call-2"));

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("leaves a conversation another of the sender's callers is still on to that caller", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const { executor, forgotten } = harness(clock);
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    clock.now = DAY / 2;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));
    executor.endPrincipal("local", "help-1");

    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);

    expect(forgotten).toEqual([]);
  });

  it("counts ended conversations with live holds against the sender's bound", async () => {
    const clock = { now: 0 };
    const { executor, forgotten } = harness(clock);
    for (let i = 0; i < 64; i += 1) {
      clock.now = i;
      await executor.call(spec(`help-${i}`, `conv-${i}`), payload(`help-${i}`));
      executor.endPrincipal("local", `help-${i}`);
    }
    expect(forgotten).toEqual([]);

    clock.now = 64;
    await executor.call(spec("help-64", "conv-64"), payload("help-64"));

    expect(forgotten).toEqual([["local", "conv-0"]]);
  });

  it("crowds out the ended conversation whose last call is oldest, whatever order they ended in", async () => {
    const clock = { now: 0 };
    const { executor, forgotten } = harness(clock);
    await executor.call(spec("help-a", "conv-a"), payload("help-a"));
    clock.now = 1;
    await executor.call(spec("help-b", "conv-b"), payload("help-b"));
    executor.endPrincipal("local", "help-b");
    executor.endPrincipal("local", "help-a");
    for (let i = 0; i < 63; i += 1) {
      clock.now = 10 + i;
      await executor.call(spec(`help-${i}`), payload(`help-${i}`));
    }

    expect(forgotten).toEqual([["local", "conv-a"]]);
  });

  it("forgets every ended conversation it holds when the relay goes", async () => {
    const { executor, forgotten } = harness({ now: 0 });
    await executor.call(spec("help-1", "conv-1"), payload("help-1"));
    executor.endPrincipal("local", "help-1");

    executor.dispose();

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("opens a session naming the conversation even after a read opened one without it", async () => {
    const { executor, opened } = harness({ now: 0 });
    await executor.read(SPEC, { tool: "terminal.list", args: {}, runMs: 5_000 });
    await executor.call(spec("help-1", "conv-1"), PAYLOAD);
    await executor.call(spec("help-1", "conv-1"), { ...PAYLOAD, callId: "call-2" });

    expect(opened.map((opening) => opening.conversationId)).toEqual([undefined, "conv-1"]);
  });

  it("takes a callId resent naming another conversation as another call", async () => {
    const { executor } = harness({ now: 0 });
    await executor.call(spec("help-1", "conv-1"), PAYLOAD);

    await expect(
      executor.call(spec("help-1", "conv-2"), { ...PAYLOAD, resend: true })
    ).resolves.toEqual({ status: "conflict" });
  });
});

describe("createMcpRelayExecutor and conversations a restart kept (#16845)", () => {
  let executor: McpRelayExecutor | undefined;
  const DAY = 24 * 60 * 60_000;

  afterEach(() => {
    executor?.dispose();
    executor = undefined;
    vi.useRealTimers();
  });

  function harness(
    clock: { now: number },
    kept: () => Array<{ senderId: string; conversationId: string; usedAt: number }> | null
  ) {
    const forgotten: Array<[string, string]> = [];
    const calls: Array<[string, string, number]> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: async () => true,
      openSession: async () => ({
        isOpen: () => true,
        callTool: async () => ANSWER,
        close: () => {},
      }),
      forgetConversation: (senderId, conversationId) => forgotten.push([senderId, conversationId]),
      keptConversations: kept,
      noteConversationCall: (...args) => calls.push(args),
      now: () => clock.now,
    });
    return { executor, forgotten, calls };
  }

  const spec = (helpSessionId: string, conversationId: string): RelayMcpSessionSpec => ({
    ...SPEC,
    helpSessionId,
    conversationId,
  });
  const payload = (helpSessionId: string): McpCallPayload => ({
    ...PAYLOAD,
    helpSessionId,
    callId: `call-${helpSessionId}`,
  });

  it("holds a kept conversation as an ended caller's, a day from its last call", () => {
    vi.useFakeTimers();
    const clock = { now: 10 * DAY };
    const { forgotten } = harness(clock, () => [
      { senderId: "local", conversationId: "conv-1", usedAt: 10 * DAY - DAY / 2 },
      { senderId: "local", conversationId: "conv-old", usedAt: 10 * DAY - DAY - 1 },
    ]);

    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([["local", "conv-old"]]);
    clock.now = 10 * DAY + DAY / 2 + 1;
    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([
      ["local", "conv-old"],
      ["local", "conv-1"],
    ]);
  });

  it("forgets a kept conversation resumed after its day ran out, before its call runs", async () => {
    const clock = { now: 0 };
    const { executor, forgotten } = harness(clock, () => [
      { senderId: "local", conversationId: "conv-1", usedAt: 0 },
    ]);
    clock.now = DAY + 1;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("gives a kept conversation resumed within its day to its caller, which holds it from then on", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    const { executor, forgotten, calls } = harness(clock, () => [
      { senderId: "local", conversationId: "conv-1", usedAt: 0 },
    ]);
    clock.now = DAY / 2;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));
    // Past the kept conversation's own day, within its caller's.
    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);

    expect(forgotten).toEqual([]);
    // When the call began and when it settled, which an ended caller's day runs from.
    expect(calls).toEqual([
      ["local", "conv-1", DAY / 2],
      ["local", "conv-1", DAY / 2],
    ]);
  });

  it("notes when a call settles, which is where an ended caller's day starts", async () => {
    const clock = { now: 0 };
    let finish: (() => void) | undefined;
    const calls: Array<[string, string, number]> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: async () => true,
      openSession: async () => ({
        isOpen: () => true,
        callTool: () =>
          new Promise<CallToolResult>((resolve) => {
            finish = () => resolve(ANSWER);
          }),
        close: () => {},
      }),
      keptConversations: () => [],
      noteConversationCall: (...args) => calls.push(args),
      now: () => clock.now,
    });
    const running = executor.call(spec("help-1", "conv-1"), payload("help-1"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    clock.now = 5_000;
    finish!();
    await running;

    expect(calls).toEqual([
      ["local", "conv-1", 0],
      ["local", "conv-1", 5_000],
    ]);
  });

  it("credits a call's settling to the conversation it ran under, though its caller moved on", async () => {
    const clock = { now: 0 };
    const finishes: Array<() => void> = [];
    const calls: Array<[string, string, number]> = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: async () => true,
      openSession: async () => ({
        isOpen: () => true,
        callTool: () =>
          new Promise<CallToolResult>((resolve) => {
            finishes.push(() => resolve(ANSWER));
          }),
        close: () => {},
      }),
      keptConversations: () => [],
      noteConversationCall: (...args) => calls.push(args),
      now: () => clock.now,
    });
    const first = executor.call(spec("help-1", "conv-a"), payload("help-1"));
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    clock.now = 1_000;
    const second = executor.call(spec("help-1", "conv-b"), {
      ...payload("help-1"),
      callId: "call-b",
    });
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    clock.now = 2_000;
    finishes[1]!();
    await second;
    clock.now = 3_000;
    finishes[0]!();
    await first;

    expect(calls).toEqual([
      ["local", "conv-a", 0],
      ["local", "conv-b", 1_000],
      ["local", "conv-b", 2_000],
      ["local", "conv-a", 3_000],
    ]);
  });

  it("forgets a kept conversation resumed after its day ran out, though it was fresh when taken in", async () => {
    const clock = { now: DAY / 2 };
    const { executor, forgotten } = harness(clock, () => [
      { senderId: "local", conversationId: "conv-1", usedAt: 0 },
    ]);
    await executor.call(spec("help-1", "conv-other"), payload("help-1"));
    expect(forgotten).toEqual([]);

    clock.now = DAY + 1;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));

    expect(forgotten).toEqual([["local", "conv-1"]]);
  });

  it("leaves a kept conversation a caller already runs to that caller, when the records load late", async () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    let loaded = false;
    const { executor, forgotten } = harness(clock, () =>
      loaded ? [{ senderId: "local", conversationId: "conv-1", usedAt: 0 }] : null
    );
    clock.now = DAY - 1_000;
    await executor.call(spec("help-2", "conv-1"), payload("help-2"));
    loaded = true;
    clock.now = DAY + 1_000;
    vi.advanceTimersByTime(60_000);

    expect(forgotten).toEqual([]);
  });

  it("asks again until the kept records have loaded", () => {
    vi.useFakeTimers();
    const clock = { now: 0 };
    let loaded = false;
    const { forgotten } = harness(clock, () =>
      loaded ? [{ senderId: "local", conversationId: "conv-1", usedAt: 0 }] : null
    );
    clock.now = DAY + 1;
    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([]);
    loaded = true;
    vi.advanceTimersByTime(60_000);
    expect(forgotten).toEqual([["local", "conv-1"]]);
  });
});

// #18255: a call its Shell could only send as a plugin action runs here only as one.
describe("createMcpRelayExecutor and a call sent as a plugin action (#18255)", () => {
  const REACH = "acme.stages.resume";
  let executor: McpRelayExecutor | undefined;
  let uninstall: () => void = () => {};

  afterEach(() => {
    executor?.dispose();
    uninstall();
  });

  function harness() {
    const calls: string[] = [];
    executor = createMcpRelayExecutor({
      acceptsRemoteControl: () => true,
      hasProject: async () => true,
      openSession: async () => ({
        isOpen: () => true,
        callTool: async (tool) => {
          calls.push(tool);
          return ANSWER;
        },
        close: () => {},
      }),
    });
    return { executor, calls };
  }

  const REMOTE: RelayMcpSessionSpec = {
    linkSessionId: "link-1",
    senderId: "sender-a",
    helpSessionId: "help-1",
    projectId: "proj-2",
    tier: "core",
    shellName: "studio",
    global: true,
    deliverNotices: () => {},
    requestApproval: async () => ({ decision: "unavailable" }),
  };
  const { global: _global, ...NOT_GLOBAL } = REMOTE;
  const SENT = { ...PAYLOAD, tool: REACH, pluginAction: true as const };

  it("runs it while this host's registry offers it to the assistant", async () => {
    uninstall = setPluginAssistantReachSource({ has: (id) => id === REACH, ids: () => [REACH] });
    const { executor, calls } = harness();

    await expect(executor.call(REMOTE, SENT)).resolves.toMatchObject({
      status: "done",
      result: { isError: false },
    });
    expect(calls).toEqual([REACH]);
  });

  it.each([
    ["a built-in this host has under that id", "terminal.list", REMOTE],
    ["a plugin action this host doesn't offer the assistant", "acme.stages.other", REMOTE],
    ["an assistant that isn't a global one", REACH, NOT_GLOBAL],
  ])("runs nothing for %s", async (_label, tool, spec) => {
    uninstall = setPluginAssistantReachSource({ has: (id) => id === REACH, ids: () => [REACH] });
    const { executor, calls } = harness();

    const answer = await executor.call(spec, { ...SENT, tool, callId: `call-${tool}` });

    expect(answer).toMatchObject({ status: "done", result: { isError: true } });
    expect(JSON.stringify(answer)).toContain("Nothing was run");
    expect(calls).toEqual([]);
  });
});
