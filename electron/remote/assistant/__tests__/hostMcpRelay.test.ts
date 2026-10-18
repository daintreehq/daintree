import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import {
  installHostMcpRelay,
  projectRelayResult,
  type HostMcpRelayDeps,
  type RelayMcpSession,
  type RelayMcpSessionSpec,
} from "../hostMcpRelay.js";
import {
  AssistantLinkMethod,
  MAX_RELAY_RESULT_BYTES,
  type McpCallPayload,
} from "../linkMethods.js";
import { SenderSessions } from "../senderSessions.js";

interface FakeLink {
  ctx: MetricsSessionContext;
  call(payload: Partial<McpCallPayload>): Promise<unknown>;
}

function fakeLink(sessionId: string): FakeLink {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const session = {
    isOpen: true,
    registerCallHandler: (
      method: string,
      schema: { parse(v: unknown): unknown },
      handler: (p: unknown) => unknown
    ) => {
      handlers.set(method, (payload) => handler(schema.parse(payload)));
    },
  } as unknown as LinkSession;
  return {
    ctx: {
      session,
      sessionId,
      client: { clientName: "greg-mbp" },
    } as unknown as MetricsSessionContext,
    call: async (payload) =>
      handlers.get(AssistantLinkMethod.MCP_CALL)!({
        helpSessionId: "help-1",
        projectId: "project-1",
        tier: "core",
        callId: "call-1",
        resend: false,
        tool: "terminal.list",
        args: {},
        runMs: 90_000,
        ...payload,
      }),
  };
}

interface FakeMcpSession extends RelayMcpSession {
  spec: RelayMcpSessionSpec;
  closed: boolean;
  calls: Array<{ tool: string; args: Record<string, unknown>; timeoutMs: number; callId: string }>;
}

/** The relay over links already attached, each with the sender it proved (null: none). */
function harness(
  links: Array<[sessionId: string, senderId: string | null]>,
  overrides: Partial<HostMcpRelayDeps> = {},
  answer: () => Promise<CallToolResult> = async () => ({ content: [{ type: "text", text: "ok" }] })
) {
  const senders = new SenderSessions();
  const fakes = links.map(([sessionId, senderId]) => {
    const link = fakeLink(sessionId);
    if (senderId !== null) senders.bind(link.ctx.session, senderId);
    return link;
  });
  const opened: FakeMcpSession[] = [];
  let expire: (info: { sessionId: string }) => void = () => {};
  const relay = installHostMcpRelay(
    {
      sessions: fakes.map((link) => link.ctx),
      onSession: () => () => {},
      onSessionExpired: (listener) => {
        expire = listener;
        return () => {};
      },
    },
    {
      senders: () => senders,
      acceptsRemoteControl: () => true,
      hasProject: async () => true,
      openSession: async (spec) => {
        const session: FakeMcpSession = {
          spec,
          closed: false,
          calls: [],
          isOpen: () => !session.closed,
          callTool: async (tool, args, options) => {
            session.calls.push({ tool, args, ...options });
            return answer();
          },
          close: () => {
            session.closed = true;
          },
        };
        opened.push(session);
        return session;
      },
      ...overrides,
    }
  );
  return { relay, opened, links: fakes, expire: (sessionId: string) => expire({ sessionId }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installHostMcpRelay", () => {
  it("refuses a link session that never proved a sender", async () => {
    const { links, relay } = harness([["link-1", null]]);
    await expect(links[0]!.call({})).rejects.toMatchObject({ code: "PERMISSION" });
    relay.dispose();
  });

  it("runs the tool in a session opened for the sender, help session, project and tier", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]]);
    const answer = await links[0]!.call({ tool: "terminal.list", args: { owned: true } });

    expect(answer).toEqual({
      status: "done",
      result: { isError: false, structured: null, text: "ok" },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.spec).toEqual({
      linkSessionId: "link-1",
      senderId: "sender-a",
      helpSessionId: "help-1",
      projectId: "project-1",
      tier: "core",
      shellName: "greg-mbp",
    });
    expect(opened[0]!.calls).toEqual([
      { tool: "terminal.list", args: { owned: true }, timeoutMs: 90_000, callId: "call-1" },
    ]);
    relay.dispose();
  });

  it("never runs a call twice when its answer was lost and it is sent again", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]]);
    const payload = { callId: "launch-1", tool: "agent.launch", args: { agentId: "claude" } };
    const first = await links[0]!.call(payload);
    const resend = await links[0]!.call({ ...payload, resend: true });

    expect(resend).toEqual(first);
    expect(opened[0]!.calls).toHaveLength(1);
    relay.dispose();
  });

  it("answers unknown for a resend it holds no record of, and conflict for a reused id", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]]);

    await expect(links[0]!.call({ callId: "lost", resend: true })).resolves.toEqual({
      status: "unknown",
    });
    await links[0]!.call({ callId: "used", args: { a: 1 } });
    await expect(links[0]!.call({ callId: "used", args: { a: 2 } })).resolves.toEqual({
      status: "conflict",
    });
    expect(opened.flatMap((session) => session.calls)).toHaveLength(1);
    relay.dispose();
  });

  it("follows a call across the Shell's links by its sender, not the link it came on", async () => {
    const { links, opened, relay } = harness([
      ["link-1", "sender-a"],
      ["link-2", "sender-a"],
    ]);
    await links[0]!.call({ callId: "launch-1" });
    await links[1]!.call({ callId: "launch-1", resend: true });

    expect(opened.flatMap((session) => session.calls)).toHaveLength(1);
    relay.dispose();
  });

  it("keeps two Shells' call ids apart", async () => {
    const { links, opened, relay } = harness([
      ["link-1", "sender-a"],
      ["link-2", "sender-b"],
    ]);
    await links[0]!.call({ callId: "same" });
    await expect(links[1]!.call({ callId: "same", resend: true })).resolves.toEqual({
      status: "unknown",
    });
    expect(opened.flatMap((session) => session.calls)).toHaveLength(1);
    relay.dispose();
  });

  it("refuses before anything runs while this host's own setting is off", async () => {
    const openSession = vi.fn();
    const { links, relay } = harness([["link-1", "sender-a"]], {
      acceptsRemoteControl: () => false,
      openSession,
    });
    await expect(links[0]!.call({})).resolves.toEqual({ status: "refused", reason: "control-off" });
    expect(openSession).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("refuses a project the host doesn't have, and a server that is off", async () => {
    const missing = harness([["link-1", "sender-a"]], { hasProject: async () => false });
    await expect(missing.links[0]!.call({})).resolves.toEqual({
      status: "refused",
      reason: "no-project",
    });
    missing.relay.dispose();

    const off = harness([["link-1", "sender-a"]], { openSession: async () => null });
    await expect(off.links[0]!.call({})).resolves.toEqual({
      status: "refused",
      reason: "server-off",
    });
    off.relay.dispose();
  });

  it("answers a tool that throws as that tool's error, kept for its resend", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]], {}, async () => {
      throw new Error("Request timed out");
    });
    const answer = await links[0]!.call({ callId: "slow" });

    expect(answer).toEqual({
      status: "done",
      result: {
        isError: true,
        structured: null,
        text: JSON.stringify({ code: "EXECUTION_ERROR", message: "Request timed out" }),
      },
    });
    await expect(links[0]!.call({ callId: "slow", resend: true })).resolves.toEqual(answer);
    expect(opened[0]!.calls).toHaveLength(1);
    relay.dispose();
  });

  it("keeps one session per principal, project and tier, and closes them all on dispose", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]]);
    await links[0]!.call({ callId: "c1" });
    await links[0]!.call({ callId: "c2" });
    await links[0]!.call({ callId: "c3", helpSessionId: "help-2" });
    await links[0]!.call({ callId: "c4", tier: "full" });

    expect(opened).toHaveLength(3);
    expect(opened[0]!.calls).toHaveLength(2);
    relay.dispose();
    expect(opened.every((session) => session.closed)).toBe(true);
  });

  it("closes an unused session once idle, and opens a fresh one for the next call", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { links, opened, relay } = harness([["link-1", "sender-a"]], {
      now: () => clock,
      idleMs: 1_000,
    });
    await links[0]!.call({ callId: "c1" });
    clock = 5_000;
    vi.advanceTimersByTime(60_000);
    expect(opened[0]!.closed).toBe(true);

    await links[0]!.call({ callId: "c2" });
    expect(opened).toHaveLength(2);
    relay.dispose();
  });

  it("closes a link's sessions once it can't be resumed, after a call still running settles", async () => {
    let finish!: (result: CallToolResult) => void;
    const { links, opened, relay, expire } = harness(
      [["link-1", "sender-a"]],
      {},
      () => new Promise<CallToolResult>((resolve) => (finish = resolve))
    );
    const call = links[0]!.call({ callId: "slow" });
    await vi.waitFor(() => expect(opened[0]?.calls).toHaveLength(1));
    expire("link-1");
    expect(opened[0]!.closed).toBe(false);

    finish({ content: [{ type: "text", text: "done" }] });
    await expect(call).resolves.toMatchObject({ status: "done" });
    expect(opened[0]!.closed).toBe(true);
    relay.dispose();
  });
});

describe("installHostMcpRelay races and retention", () => {
  it("closes a session opened for a link that ended while its call was being admitted", async () => {
    let admit!: (found: boolean) => void;
    const { links, opened, relay, expire } = harness([["link-1", "sender-a"]], {
      hasProject: () => new Promise<boolean>((resolve) => (admit = resolve)),
    });
    const call = links[0]!.call({ callId: "late" });
    await vi.waitFor(() => expect(admit).toBeTypeOf("function"));
    expire("link-1");
    admit(true);

    await expect(call).resolves.toMatchObject({ status: "done" });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.closed).toBe(true);
    relay.dispose();
  });

  it("leaves no unhandled rejection when a session still opening fails after teardown", async () => {
    let fail!: (error: Error) => void;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { links, relay } = harness([["link-1", "sender-a"]], {
        openSession: () => new Promise<RelayMcpSession | null>((_, reject) => (fail = reject)),
      });
      const call = links[0]!.call({ callId: "c1" });
      await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
      relay.dispose();
      fail(new Error("server stopped"));

      await expect(call).resolves.toEqual({ status: "refused", reason: "server-off" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("retires a help session's hold here once unused for a day, never one with a session open", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const retirePrincipal = vi.fn();
    const { links, relay } = harness([["link-1", "sender-a"]], {
      now: () => clock,
      idleMs: 60 * 60_000,
      retirePrincipal,
    });
    await links[0]!.call({ callId: "c1", helpSessionId: "old" });
    clock = 25 * 60 * 60_000;
    await links[0]!.call({ callId: "c2", helpSessionId: "fresh" });
    vi.advanceTimersByTime(60_000);

    expect(retirePrincipal).toHaveBeenCalledWith("sender-a", "old");
    expect(retirePrincipal).not.toHaveBeenCalledWith("sender-a", "fresh");
    relay.dispose();
  });

  it("retires the least recent help sessions past a sender's bound", async () => {
    const retirePrincipal = vi.fn();
    const { links, opened, relay } = harness([["link-1", "sender-a"]], { retirePrincipal });
    for (let i = 0; i < 65; i++) {
      await links[0]!.call({ callId: `c${i}`, helpSessionId: `help-${i}` });
      // Each closed once used, as the idle sweep would, so its hold may go.
      opened.at(-1)!.close();
    }

    expect(retirePrincipal).toHaveBeenCalledTimes(1);
    expect(retirePrincipal).toHaveBeenCalledWith("sender-a", "help-0");
    relay.dispose();
  });
});

describe("projectRelayResult", () => {
  it("fits a cut result as it is carried, escaping and all", () => {
    const escaping = '"\\\n'.repeat(MAX_RELAY_RESULT_BYTES);
    const projected = projectRelayResult({ content: [{ type: "text", text: escaping }] });

    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      MAX_RELAY_RESULT_BYTES
    );
    expect(projected.text).toMatch(/^\[The host's result was cut to fit/);
  });

  it("carries the structured half when there is one, else the text", () => {
    expect(
      projectRelayResult({
        content: [{ type: "text", text: '{"a":1}' }],
        structuredContent: { a: 1 },
      })
    ).toEqual({ isError: false, structured: { a: 1 }, text: null });
    expect(
      projectRelayResult({
        content: [
          { type: "text", text: "line one" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: true,
      })
    ).toEqual({ isError: true, structured: null, text: "line one\n[image content omitted]" });
  });

  it("cuts a result too large to carry, saying the call ran", () => {
    const big = "x".repeat(MAX_RELAY_RESULT_BYTES * 2);
    const projected = projectRelayResult({ content: [{ type: "text", text: big }] });

    expect(projected.structured).toBeNull();
    expect(projected.text).toMatch(
      /^\[The host's result was cut to fit: \d+ of \d+ bytes shown\. The call ran/
    );
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(
      MAX_RELAY_RESULT_BYTES
    );
  });
});
