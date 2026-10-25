import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LinkSession } from "../../link/session.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import {
  installHostMcpRelay,
  projectRelayResult,
  THROWAWAY_SHELL_GONE_GRACE_MS,
  type HostMcpRelayDeps,
  type RelayMcpSession,
  type RelayMcpSessionSpec,
} from "../hostMcpRelay.js";
import {
  AssistantLinkMethod,
  MAX_RELAY_NOTICE_STATUS_CALLS,
  MAX_RELAY_RESULT_BYTES,
  ThrowawayCallAnswerSchema,
  ThrowawayCallPayloadSchema,
  type McpCallPayload,
} from "../linkMethods.js";
import { MAX_RELAY_NOTICES_PER_SENDER } from "../relayNoticeOutbox.js";
import { SenderSessions } from "../senderSessions.js";
import type { HostThrowawayExecutor } from "../throwawayRelay.js";

interface FakeLink {
  ctx: MetricsSessionContext;
  call(payload: Partial<McpCallPayload>): Promise<unknown>;
  /** What the Shell asks over the link with any other method. */
  ask(method: string, payload: unknown): Promise<unknown>;
  /** What this host called on the Shell over the link. */
  sent: Array<{ method: string; payload: unknown }>;
}

function fakeLink(sessionId: string): FakeLink {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const sent: FakeLink["sent"] = [];
  const session = {
    isOpen: true,
    call: async (method: string, payload: unknown) => {
      sent.push({ method, payload });
      return null;
    },
    registerCallHandler: (
      method: string,
      schema: { parse(v: unknown): unknown },
      handler: (p: unknown) => unknown
    ) => {
      handlers.set(method, (payload) => handler(schema.parse(payload)));
    },
  } as unknown as LinkSession;
  return {
    sent,
    ask: async (method, payload) => handlers.get(method)!(payload),
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
  let detach: (info: { sessionId: string }) => void = () => {};
  const sessions = fakes.map((link) => link.ctx);
  let onSession: (ctx: MetricsSessionContext) => void = () => {};
  const relay = installHostMcpRelay(
    {
      sessions,
      onSession: (listener) => {
        onSession = listener;
        return () => {};
      },
      onSessionDetached: (listener) => {
        detach = listener;
        return () => {};
      },
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
  /** A link that attaches later, as a Shell's next session does. */
  const attach = (sessionId: string, senderId: string | null): FakeLink => {
    const link = fakeLink(sessionId);
    if (senderId !== null) senders.bind(link.ctx.session, senderId, sessionId);
    fakes.push(link);
    sessions.push(link.ctx);
    onSession(link.ctx);
    return link;
  };
  return {
    relay,
    opened,
    links: fakes,
    attach,
    // A dropped link leaves the server's sessions, though it may still resume.
    detach: (sessionId: string) => {
      const index = sessions.findIndex((ctx) => ctx.sessionId === sessionId);
      if (index >= 0) sessions.splice(index, 1);
      detach({ sessionId });
    },
    // A link expires once its transport is long gone.
    expire: (sessionId: string) => {
      for (const link of fakes) {
        if (link.ctx.sessionId === sessionId) {
          (link.ctx.session as unknown as { isOpen: boolean }).isOpen = false;
        }
      }
      expire({ sessionId });
    },
  };
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
      deliverNotices: expect.any(Function),
      requestApproval: expect.any(Function),
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

  it("never retires a principal while its call still runs, however old or crowded", async () => {
    vi.useFakeTimers();
    let clock = 0;
    let finish!: (result: CallToolResult) => void;
    let first = true;
    const retirePrincipal = vi.fn();
    const { links, opened, relay, expire } = harness(
      [["link-1", "sender-a"]],
      { now: () => clock, idleMs: 60 * 60_000, retirePrincipal },
      () => {
        if (!first) return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
        first = false;
        return new Promise<CallToolResult>((resolve) => (finish = resolve));
      }
    );
    const slow = links[0]!.call({ callId: "slow", helpSessionId: "busy" });
    await vi.waitFor(() => expect(opened[0]?.calls).toHaveLength(1));
    // Its link ends while it runs, so its session is no longer cached as live.
    expire("link-1");
    for (let i = 0; i < 64; i++) {
      await links[0]!.call({ callId: `c${i}`, helpSessionId: `other-${i}` });
      opened.at(-1)!.close();
    }
    clock = 25 * 60 * 60_000;
    vi.advanceTimersByTime(60_000);

    expect(retirePrincipal).not.toHaveBeenCalledWith("sender-a", "busy");
    finish({ content: [{ type: "text", text: "done" }] });
    await slow;
    relay.dispose();
  });

  it("holds a sender to its bound on the sweep too, once its sessions close", async () => {
    vi.useFakeTimers();
    const retirePrincipal = vi.fn();
    const { links, opened, relay } = harness([["link-1", "sender-a"]], { retirePrincipal });
    for (let i = 0; i < 65; i++) {
      await links[0]!.call({ callId: `c${i}`, helpSessionId: `help-${i}` });
    }
    // Every one had a session open when it was added, so none could go then.
    expect(retirePrincipal).not.toHaveBeenCalled();
    for (const session of opened) session.close();
    vi.advanceTimersByTime(60_000);

    expect(retirePrincipal).toHaveBeenCalledTimes(1);
    expect(retirePrincipal).toHaveBeenCalledWith("sender-a", "help-0");
    relay.dispose();
  });

  it("gives up every hold it tracks when the relay goes, since nothing would retire them later", async () => {
    const retirePrincipal = vi.fn();
    const { links, relay } = harness([["link-1", "sender-a"]], { retirePrincipal });
    await links[0]!.call({ callId: "c1", helpSessionId: "help-1" });
    relay.dispose();
    expect(retirePrincipal).toHaveBeenCalledWith("sender-a", "help-1");
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

describe("installHostMcpRelay notices (#13500)", () => {
  const notice = (callId = "call-1") => ({
    helpSessionId: "help-1",
    callId,
    terminalId: "t-1",
    observation: { kind: "closed" as const },
  });
  const notifyCall = { tool: "terminal.notifyWhenIdle", args: { terminalId: "t-1" } };
  const status = (link: FakeLink, calls: Array<{ helpSessionId: string; callId: string }>) =>
    link.ask(AssistantLinkMethod.RELAY_NOTICE_STATUS, { calls });

  it("carries a session's notices back to the sender that made the call, never another Shell", async () => {
    const { links, opened, relay } = harness([
      ["link-1", "sender-a"],
      ["link-2", "sender-b"],
    ]);
    await links[0]!.call({});
    opened[0]!.spec.deliverNotices([notice()]);

    await vi.waitFor(() => expect(links[0]!.sent).toHaveLength(1));
    expect(links[0]!.sent[0]).toMatchObject({
      method: AssistantLinkMethod.RELAY_NOTICES,
      payload: { notices: [expect.objectContaining({ callId: "call-1", terminalId: "t-1" })] },
    });
    expect(links[1]!.sent).toEqual([]);
    relay.dispose();
  });

  it("carries what an expired link's call armed over the Shell's next session (#13930)", async () => {
    const { links, opened, relay, expire, attach } = harness([["link-1", "sender-a"]]);
    await links[0]!.call(notifyCall);
    expire("link-1");
    const next = attach("link-2", "sender-a");
    opened[0]!.spec.deliverNotices([notice()]);

    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
    expect(next.sent[0]).toMatchObject({
      method: AssistantLinkMethod.RELAY_NOTICES,
      payload: { notices: [expect.objectContaining({ callId: "call-1", terminalId: "t-1" })] },
    });
    expect(opened[0]!.closed).toBe(true);
    relay.dispose();
  });

  it("holds them for a new session until it proves the sender, then sends them as it asks", async () => {
    const senders = new SenderSessions();
    const { links, opened, relay, expire, attach } = harness([["link-1", "sender-a"]], {
      senders: () => senders,
    });
    senders.bind(links[0]!.ctx.session, "sender-a", "link-1");
    await links[0]!.call(notifyCall);
    expire("link-1");
    senders.forgetSessionId("link-1");
    const next = attach("link-2", null);
    opened[0]!.spec.deliverNotices([notice()]);
    await Promise.resolve();
    expect(next.sent).toEqual([]);
    await expect(
      status(next, [{ helpSessionId: "help-1", callId: "call-1" }])
    ).rejects.toMatchObject({ code: "PERMISSION" });

    senders.bind(next.ctx.session, "sender-a", "link-2");
    await status(next, [{ helpSessionId: "help-1", callId: "call-1" }]);
    await vi.waitFor(() =>
      expect(next.sent.map((sent) => sent.method)).toEqual([AssistantLinkMethod.RELAY_NOTICES])
    );
    relay.dispose();
  });

  it("says which calls it still watches, which are settled, and which it has no record of", async () => {
    let watching: ReadonlySet<string> = new Set(["call-1"]);
    const { links, relay } = harness([["link-1", "sender-a"]], {
      watchingNoticeCalls: (senderId, helpSessionId) =>
        senderId === "sender-a" && helpSessionId === "help-1" ? watching : new Set(),
    });
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    await links[0]!.call({ ...notifyCall, callId: "call-2" });
    await links[0]!.call({ tool: "terminal.list", callId: "call-3" });
    // A resend of a call this host never ran arms nothing here.
    await links[0]!.call({ ...notifyCall, callId: "call-4", resend: true });

    expect(
      await status(links[0]!, [
        { helpSessionId: "help-1", callId: "call-1" },
        { helpSessionId: "help-1", callId: "call-2" },
        { helpSessionId: "help-1", callId: "call-3" },
        { helpSessionId: "help-1", callId: "call-4" },
        { helpSessionId: "help-2", callId: "call-1" },
      ])
    ).toEqual({
      calls: [
        { helpSessionId: "help-1", callId: "call-1", status: "watching" },
        { helpSessionId: "help-1", callId: "call-2", status: "settled" },
        { helpSessionId: "help-1", callId: "call-3", status: "unknown" },
        { helpSessionId: "help-1", callId: "call-4", status: "unknown" },
        { helpSessionId: "help-2", callId: "call-1", status: "unknown" },
      ],
    });

    watching = new Set();
    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-1" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-1", status: "settled" }],
    });
    relay.dispose();
  });

  it("counts a notice still on its way, or one it can't read, as watched", async () => {
    const { links, relay } = harness([["link-1", "sender-a"]], {
      watchingNoticeCalls: () => {
        throw new Error("service down");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-1" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-1", status: "watching" }],
    });
    warn.mockRestore();
    relay.dispose();

    const unanswered = harness([["link-1", "sender-a"]]);
    (unanswered.links[0]!.ctx.session as unknown as { call: unknown }).call = () =>
      new Promise(() => {});
    await unanswered.links[0]!.call({ ...notifyCall, callId: "call-1" });
    unanswered.opened[0]!.spec.deliverNotices([notice("call-1")]);
    expect(
      await status(unanswered.links[0]!, [{ helpSessionId: "help-1", callId: "call-1" }])
    ).toEqual({ calls: [{ helpSessionId: "help-1", callId: "call-1", status: "watching" }] });
    unanswered.relay.dispose();
  });

  it("answers for a watch still armed even once it has no record of the call", async () => {
    const { links, relay } = harness([["link-1", "sender-a"]], {
      watchingNoticeCalls: () => new Set(["call-x"]),
    });
    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-x" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-x", status: "watching" }],
    });
    relay.dispose();
  });

  it("keeps no record of a call it refused, so refusals never crowd out one it holds", async () => {
    const { links, relay } = harness([["link-1", "sender-a"]], {
      hasProject: async (projectId) => projectId === "project-1",
    });
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    for (let i = 0; i < MAX_RELAY_NOTICE_STATUS_CALLS; i++) {
      await links[0]!.call({ ...notifyCall, callId: `refused-${i}`, projectId: "nope" });
    }
    expect(
      await status(links[0]!, [
        { helpSessionId: "help-1", callId: "call-1" },
        { helpSessionId: "help-1", callId: "refused-0" },
      ])
    ).toEqual({
      calls: [
        { helpSessionId: "help-1", callId: "call-1", status: "settled" },
        { helpSessionId: "help-1", callId: "refused-0", status: "unknown" },
      ],
    });
    relay.dispose();
  });

  it("lets no refusal crowd out a call it holds, even with its records full", async () => {
    const { links, relay } = harness([["link-1", "sender-a"]], {
      hasProject: async (projectId) => projectId === "project-1",
    });
    for (let i = 0; i < MAX_RELAY_NOTICE_STATUS_CALLS; i++) {
      await links[0]!.call({ ...notifyCall, callId: `call-${i}` });
    }
    await links[0]!.call({ ...notifyCall, callId: "refused", projectId: "nope" });
    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-0" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-0", status: "settled" }],
    });
    relay.dispose();
  });

  it("counts a notice that left for its Shell while it read the notice service as watched", async () => {
    let handOff: () => void = () => {};
    const { links, opened, relay } = harness([["link-1", "sender-a"]], {
      watchingNoticeCalls: async () => {
        handOff();
        return new Set();
      },
    });
    // The Shell hasn't answered the notices yet, so they still wait here.
    (links[0]!.ctx.session as unknown as { call: unknown }).call = () => new Promise(() => {});
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    handOff = () => opened[0]!.spec.deliverNotices([notice("call-1")]);
    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-1" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-1", status: "watching" }],
    });
    relay.dispose();
  });

  it("says a call whose notice was crowded out before its Shell took it is gone", async () => {
    const { links, opened, relay } = harness([["link-1", "sender-a"]]);
    (links[0]!.ctx.session as unknown as { call: unknown }).call = () => new Promise(() => {});
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    await links[0]!.call({ ...notifyCall, callId: "call-2" });
    opened[0]!.spec.deliverNotices([
      notice("call-1"),
      ...Array.from({ length: MAX_RELAY_NOTICES_PER_SENDER }, () => notice("call-2")),
    ]);
    expect(
      await status(links[0]!, [
        { helpSessionId: "help-1", callId: "call-1" },
        { helpSessionId: "help-1", callId: "call-2" },
      ])
    ).toEqual({
      calls: [
        { helpSessionId: "help-1", callId: "call-1", status: "unknown" },
        { helpSessionId: "help-1", callId: "call-2", status: "watching" },
      ],
    });
    relay.dispose();
  });

  it("forgets a retired principal's calls, so its Shell hears their notices are gone", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const { links, relay } = harness([["link-1", "sender-a"]], {
      now: () => clock,
      idleMs: 60 * 60_000,
      retirePrincipal: () => {},
    });
    await links[0]!.call({ ...notifyCall, callId: "call-1" });
    clock = 25 * 60 * 60_000;
    vi.advanceTimersByTime(60_000);

    expect(await status(links[0]!, [{ helpSessionId: "help-1", callId: "call-1" }])).toEqual({
      calls: [{ helpSessionId: "help-1", callId: "call-1", status: "unknown" }],
    });
    relay.dispose();
  });
});

describe("installHostMcpRelay approvals (#13501)", () => {
  it("puts a call's confirmation to the Shell over the link it came in on, about that call", async () => {
    const { links, opened, relay } = harness([
      ["link-1", "a".repeat(64)],
      ["link-2", "b".repeat(64)],
    ]);
    await links[0]!.call({ projectId: "project-1", helpSessionId: "help-1" });
    const spec = opened[0]!.spec;

    // The Shell's answer here is a stub's null: nothing approved.
    const decision = await spec.requestApproval({
      callId: "call-1",
      actionId: "worktree.delete",
      args: { worktreeId: "/wt/feature" },
      lines: ["No uncommitted changes."],
    });

    expect(decision).toEqual({ decision: "unavailable" });
    expect(links[1]!.sent).toEqual([]);
    expect(links[0]!.sent).toEqual([
      {
        method: AssistantLinkMethod.RELAY_APPROVE,
        payload: expect.objectContaining({
          helpSessionId: "help-1",
          callId: "call-1",
          projectId: "project-1",
          actionId: "worktree.delete",
          args: { worktreeId: "/wt/feature" },
        }),
      },
    ]);
    relay.dispose();
  });
});

describe("throwaway calls on a host that doesn't run them yet (#14444)", () => {
  const THROWAWAY = {
    helpSessionId: "help-1",
    tier: "core",
    callId: "call-1",
    resend: false,
    call: { tool: "throwaway.launch", args: { agentId: "claude" } },
    runMs: 90_000,
  };

  it("tells an authenticated sender they are off, touching no project or session", async () => {
    const hasProject = vi.fn(async () => true);
    const { links, opened, relay } = harness([["link-1", "sender-a"]], { hasProject });
    await expect(links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, THROWAWAY)).resolves.toEqual({
      status: "refused",
      reason: "throwaway-off",
    });
    expect(hasProject).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
    relay.dispose();
  });

  it("answers control-off while the person refuses remote control, and nothing to a stranger", async () => {
    const off = harness([["link-1", "sender-a"]], { acceptsRemoteControl: () => false });
    await expect(off.links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, THROWAWAY)).resolves.toEqual(
      { status: "refused", reason: "control-off" }
    );
    off.relay.dispose();
    const stranger = harness([["link-1", null]]);
    await expect(
      stranger.links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, THROWAWAY)
    ).rejects.toMatchObject({ code: "PERMISSION" });
    stranger.relay.dispose();
  });

  it("carries no project, and a newer host's unknown refusal reads as turned off", () => {
    expect(ThrowawayCallPayloadSchema.safeParse(THROWAWAY).success).toBe(true);
    expect(
      ThrowawayCallPayloadSchema.safeParse({ ...THROWAWAY, projectId: "project-1" }).success
    ).toBe(false);
    expect(
      ThrowawayCallPayloadSchema.safeParse({
        ...THROWAWAY,
        call: { tool: "terminal.list", args: {} },
      }).success
    ).toBe(false);
    expect(ThrowawayCallAnswerSchema.parse({ status: "refused", reason: "busy" })).toEqual({
      status: "refused",
      reason: "throwaway-off",
    });
    // Every reason this Shell knows keeps its own meaning.
    for (const reason of ["control-off", "throwaway-off", "expiry-unsupported"]) {
      expect(ThrowawayCallAnswerSchema.parse({ status: "refused", reason })).toEqual({
        status: "refused",
        reason,
      });
    }
    const run = {
      runId: "run-1",
      agentId: "claude",
      startedAt: 1_000,
      ageMs: 0,
      timeLimitMs: null,
      expiresAt: null,
      state: "running",
      endedAt: null,
      endReason: null,
    };
    for (const answer of [
      { status: "done", result: { tool: "throwaway.launch", run } },
      { status: "failed", reason: "not-found" },
      { status: "unknown" },
      { status: "conflict" },
    ]) {
      expect(ThrowawayCallAnswerSchema.parse(answer)).toEqual(answer);
    }
    expect(ThrowawayCallAnswerSchema.safeParse({ status: "failed", reason: "busy" }).success).toBe(
      false
    );
  });
});

describe("throwaway calls on a host that runs them (#14446)", () => {
  const RUN = {
    runId: "run-1",
    agentId: "claude",
    startedAt: 1_000,
    ageMs: 0,
    timeLimitMs: null,
    expiresAt: null,
    state: "running" as const,
    endedAt: null,
    endReason: null,
  };
  const LAUNCH = {
    helpSessionId: "help-1",
    tier: "core",
    callId: "call-1",
    resend: false,
    call: { tool: "throwaway.launch", args: { agentId: "claude" } },
    runMs: 90_000,
  };

  it("runs them for the proven sender and help session, opening no project session", async () => {
    const hasProject = vi.fn(async () => true);
    const run = vi.fn(async () => ({
      status: "done" as const,
      result: { tool: "throwaway.launch" as const, run: RUN },
    }));
    const { links, opened, relay } = harness([["link-1", "sender-a"]], {
      hasProject,
      throwawayRuns: () => ({ run, endOwner: vi.fn() }),
    });
    await expect(links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH)).resolves.toEqual({
      status: "done",
      result: { tool: "throwaway.launch", run: RUN },
    });
    expect(run).toHaveBeenCalledWith(
      { senderId: "sender-a", helpSessionId: "help-1" },
      LAUNCH.call,
      { callId: "call-1", timeoutMs: 90_000 }
    );
    expect(hasProject).not.toHaveBeenCalled();
    expect(opened).toHaveLength(0);
    relay.dispose();
  });

  it("answers a resend over the Shell's next session from the first send, launching once", async () => {
    const run = vi.fn(async () => ({
      status: "done" as const,
      result: { tool: "throwaway.launch" as const, run: RUN },
    }));
    const { links, attach, relay } = harness([["link-1", "sender-a"]], {
      throwawayRuns: () => ({ run, endOwner: vi.fn() }),
    });
    const first = await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    const next = attach("link-2", "sender-a");
    await expect(
      next.ask(AssistantLinkMethod.THROWAWAY_CALL, { ...LAUNCH, resend: true })
    ).resolves.toEqual(first);
    // Another Shell's sender under the same id is its own call: no record to resend.
    const other = attach("link-3", "sender-b");
    await expect(
      other.ask(AssistantLinkMethod.THROWAWAY_CALL, { ...LAUNCH, resend: true })
    ).resolves.toEqual({ status: "unknown" });
    expect(run).toHaveBeenCalledTimes(1);
    await other.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(
      { senderId: "sender-b", helpSessionId: "help-1" },
      LAUNCH.call,
      expect.anything()
    );
    relay.dispose();
  });

  it("refuses them while the person refuses remote control, before the executor is read", async () => {
    const throwawayRuns = vi.fn(() => ({ run: vi.fn(), endOwner: vi.fn() }));
    const { links, relay } = harness([["link-1", "sender-a"]], {
      acceptsRemoteControl: () => false,
      throwawayRuns,
    });
    await expect(links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH)).resolves.toEqual({
      status: "refused",
      reason: "control-off",
    });
    expect(throwawayRuns).not.toHaveBeenCalled();
    relay.dispose();
  });
});

describe("throwaway runs of an owner that is gone (#14447)", () => {
  const LAUNCH = {
    helpSessionId: "help-1",
    tier: "core",
    callId: "call-1",
    resend: false,
    call: { tool: "throwaway.launch", args: { agentId: "claude" } },
    runMs: 90_000,
  };

  function withRuns(links: Array<[string, string | null]>) {
    const endOwner = vi.fn<HostThrowawayExecutor["endOwner"]>();
    const run = vi.fn<HostThrowawayExecutor["run"]>(async () => ({
      status: "failed",
      reason: "launch-failed",
    }));
    return { endOwner, ...harness(links, { throwawayRuns: () => ({ run, endOwner }) }) };
  }

  it("closes one help session's runs when its Shell says it ended, for the proven sender only", async () => {
    const { links, endOwner, relay } = withRuns([
      ["link-1", "sender-a"],
      ["link-2", null],
    ]);
    await expect(
      links[0]!.ask(AssistantLinkMethod.THROWAWAY_RELEASE, { helpSessionId: "help-1" })
    ).resolves.toEqual({});
    expect(endOwner).toHaveBeenCalledWith(
      { senderId: "sender-a", helpSessionId: "help-1" },
      "session-ended"
    );
    await expect(
      links[1]!.ask(AssistantLinkMethod.THROWAWAY_RELEASE, { helpSessionId: "help-1" })
    ).rejects.toMatchObject({ code: "PERMISSION" });
    expect(endOwner).toHaveBeenCalledTimes(1);
    relay.dispose();
  });

  it("closes a sender's runs once its last link has been gone past the grace", async () => {
    vi.useFakeTimers();
    const { links, endOwner, relay, detach } = withRuns([["link-1", "sender-a"]]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    detach("link-1");
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS - 1);
    expect(endOwner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(endOwner).toHaveBeenCalledWith({ senderId: "sender-a" }, "shell-gone");
    relay.dispose();
  });

  it("keeps a sender's runs while another of its links is open, or one comes back in time", async () => {
    vi.useFakeTimers();
    const { links, endOwner, relay, detach, attach } = withRuns([
      ["link-1", "sender-a"],
      ["link-2", "sender-a"],
    ]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    detach("link-1");
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS);
    expect(endOwner).not.toHaveBeenCalled();

    await links[1]!.ask(AssistantLinkMethod.THROWAWAY_CALL, { ...LAUNCH, callId: "call-2" });
    detach("link-2");
    attach("link-3", "sender-a");
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS);
    expect(endOwner).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("counts a last link that never made a throwaway call", async () => {
    vi.useFakeTimers();
    const { links, endOwner, relay, detach } = withRuns([
      ["link-1", "sender-a"],
      ["link-2", "sender-a"],
    ]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    detach("link-1");
    detach("link-2");
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS);
    expect(endOwner).toHaveBeenCalledWith({ senderId: "sender-a" }, "shell-gone");
    relay.dispose();
  });

  it("gives each last link gone the whole grace, however recently another went", async () => {
    vi.useFakeTimers();
    const { links, endOwner, relay, detach, attach } = withRuns([["link-1", "sender-a"]]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    detach("link-1");
    await vi.advanceTimersByTimeAsync(10_000);
    // Back without a throwaway call, then gone again.
    attach("link-2", "sender-a");
    await vi.advanceTimersByTimeAsync(10_000);
    detach("link-2");
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS - 1);
    expect(endOwner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(endOwner).toHaveBeenCalledTimes(1);
    relay.dispose();
  });

  it("closes them at once when the Shell's last link expires, even after its sender was forgotten", async () => {
    const { links, endOwner, relay, expire } = withRuns([
      ["link-1", "sender-a"],
      ["link-2", "sender-b"],
    ]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    expire("link-2");
    expect(endOwner).not.toHaveBeenCalledWith({ senderId: "sender-a" }, "shell-gone");
    expire("link-1");
    expect(endOwner).toHaveBeenCalledWith({ senderId: "sender-a" }, "shell-gone");
    relay.dispose();
  });

  it("arms nothing once disposed", async () => {
    vi.useFakeTimers();
    const { links, endOwner, relay, detach } = withRuns([["link-1", "sender-a"]]);
    await links[0]!.ask(AssistantLinkMethod.THROWAWAY_CALL, LAUNCH);
    detach("link-1");
    relay.dispose();
    await vi.advanceTimersByTimeAsync(THROWAWAY_SHELL_GONE_GRACE_MS);
    expect(endOwner).not.toHaveBeenCalled();
  });
});
