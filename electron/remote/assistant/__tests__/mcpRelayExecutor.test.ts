import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpCallPayload } from "../linkMethods.js";
import {
  createMcpRelayExecutor,
  type McpRelayExecutor,
  type RelayMcpSessionSpec,
} from "../mcpRelayExecutor.js";

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
