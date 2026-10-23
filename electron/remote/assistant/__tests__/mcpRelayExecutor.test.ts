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
        return {
          isOpen: () => !session.closed,
          callTool: () => (hooks.answer ?? (async () => ANSWER))(),
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

  it("keeps another help session's sessions and hold", async () => {
    const { executor, sessions, retired } = harness({});
    await executor.call(SPEC, PAYLOAD);

    executor.endPrincipal("local", "help-2");

    expect(sessions[0]!.closed).toBe(false);
    expect(retired).toEqual([]);
  });
});
