import { describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => loggerMock,
}));
import { AppError } from "../../../utils/errorTypes.js";
import type { LinkSession } from "../../link/session.js";
import { HostControlLinkClient, type RelayNoticeReceiver } from "../HostControlLinkClient.js";
import {
  AssistantLinkMethod,
  type McpCallPayload,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayNoticeStatusAnswer,
  type RelayNoticesPayload,
  type ThrowawayCallPayload,
} from "../linkMethods.js";

const CREDENTIAL = "C".repeat(43);
const PAYLOAD: McpCallPayload = {
  helpSessionId: "help-1",
  projectId: "p",
  tier: "core",
  callId: "call-1",
  resend: false,
  tool: "terminal.list",
  args: {},
  runMs: 90_000,
};

function client(answer: (method: string, payload: unknown) => unknown) {
  const calls: Array<{ method: string; payload: unknown; timeoutMs: number | undefined }> = [];
  const session = {
    isOpen: true,
    call: vi.fn(async (method: string, payload: unknown, options?: { timeoutMs?: number }) => {
      calls.push({ method, payload, timeoutMs: options?.timeoutMs });
      return answer(method, payload);
    }),
  } as unknown as LinkSession;
  const relay = new HostControlLinkClient({
    credential: () => CREDENTIAL,
    session: async () => session,
    onSessionOpened: () => () => {},
  });
  return { relay, calls };
}

describe("HostControlLinkClient.relayCall (#13493)", () => {
  it("proves the sender once per session, then sends the call with its own timeout", async () => {
    const { relay, calls } = client((method) =>
      method === AssistantLinkMethod.MCP_CALL
        ? { status: "done", result: { isError: false, structured: null, text: "ok" } }
        : null
    );

    await expect(relay.relayCall("studio", PAYLOAD, 105_000)).resolves.toEqual({
      status: "done",
      result: { isError: false, structured: null, text: "ok" },
    });
    await relay.relayCall("studio", { ...PAYLOAD, callId: "call-2" }, 105_000);

    expect(calls.map((call) => call.method)).toEqual([
      AssistantLinkMethod.AUTHENTICATE,
      AssistantLinkMethod.MCP_CALL,
      AssistantLinkMethod.MCP_CALL,
    ]);
    expect(calls[0]!.payload).toEqual({ credential: CREDENTIAL });
    expect(calls[1]).toMatchObject({ payload: PAYLOAD, timeoutMs: 105_000 });
  });

  it("reports a proof that got no answer as never sent, sending nothing of the call", async () => {
    const { relay, calls } = client((method) => {
      if (method === AssistantLinkMethod.AUTHENTICATE) {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "no answer" });
      }
      return null;
    });

    await expect(relay.relayCall("studio", PAYLOAD, 105_000)).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(calls.map((call) => call.method)).toEqual([AssistantLinkMethod.AUTHENTICATE]);
  });

  it("passes a refused proof through as the refusal it is", async () => {
    const { relay } = client((method) => {
      if (method === AssistantLinkMethod.AUTHENTICATE) {
        throw new AppError({ code: "PERMISSION", message: "another sender" });
      }
      return null;
    });
    await expect(relay.relayCall("studio", PAYLOAD, 105_000)).rejects.toMatchObject({
      code: "PERMISSION",
    });
  });

  it("names a host without the call as unsupported, and an unreadable answer as invalid", async () => {
    const old = client((method) => {
      if (method === AssistantLinkMethod.MCP_CALL) {
        throw new AppError({ code: "UNSUPPORTED", message: "Unknown method" });
      }
      return null;
    });
    await expect(old.relay.relayCall("studio", PAYLOAD, 105_000)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });

    const garbled = client((method) =>
      method === AssistantLinkMethod.MCP_CALL ? { status: "maybe" } : null
    );
    await expect(garbled.relay.relayCall("studio", PAYLOAD, 105_000)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("HostControlLinkClient.throwawayCall (#14446)", () => {
  const THROWAWAY: ThrowawayCallPayload = {
    helpSessionId: "help-1",
    tier: "core",
    callId: "call-1",
    resend: false,
    call: { tool: "throwaway.status", args: { runId: "run-1" } },
    runMs: 90_000,
  };

  it("proves the sender once, then sends the call over its own method with its own timeout", async () => {
    const { relay, calls } = client((method) =>
      method === AssistantLinkMethod.THROWAWAY_CALL
        ? { status: "failed", reason: "not-found" }
        : null
    );
    await expect(relay.throwawayCall("studio", THROWAWAY, 105_000)).resolves.toEqual({
      status: "failed",
      reason: "not-found",
    });
    await relay.throwawayCall("studio", { ...THROWAWAY, callId: "call-2" }, 105_000);
    expect(calls.map((call) => call.method)).toEqual([
      AssistantLinkMethod.AUTHENTICATE,
      AssistantLinkMethod.THROWAWAY_CALL,
      AssistantLinkMethod.THROWAWAY_CALL,
    ]);
    expect(calls[1]).toMatchObject({ payload: THROWAWAY, timeoutMs: 105_000 });
  });

  it("reports a proof that got no answer as never sent, sending nothing of the call", async () => {
    const { relay, calls } = client((method) => {
      if (method === AssistantLinkMethod.AUTHENTICATE) {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "no answer" });
      }
      return null;
    });
    await expect(relay.throwawayCall("studio", THROWAWAY, 105_000)).rejects.toMatchObject({
      code: "HOST_DISCONNECTED",
    });
    expect(calls.map((call) => call.method)).toEqual([AssistantLinkMethod.AUTHENTICATE]);
  });

  it("names a host from before throwaway agents unsupported, and an unreadable answer invalid", async () => {
    const old = client((method) => {
      if (method === AssistantLinkMethod.THROWAWAY_CALL) {
        throw new AppError({ code: "UNSUPPORTED", message: "Unknown method" });
      }
      return null;
    });
    await expect(old.relay.throwawayCall("studio", THROWAWAY, 105_000)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const garbled = client((method) =>
      method === AssistantLinkMethod.THROWAWAY_CALL ? { status: "failed", reason: "busy" } : null
    );
    await expect(garbled.relay.throwawayCall("studio", THROWAWAY, 105_000)).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("HostControlLinkClient.agents (#14455)", () => {
  const DIRECTORY = { coverage: "ok", observedAt: 7, complete: true, omitted: 0, entries: [] };

  it("proves the sender, then asks for the host's agents with the filter and timeout given", async () => {
    const { relay, calls } = client((method) =>
      method === AssistantLinkMethod.AGENTS ? { status: "done", directory: DIRECTORY } : null
    );

    await expect(relay.agents("studio", { projectId: "p" }, 5_000)).resolves.toEqual({
      status: "done",
      directory: DIRECTORY,
    });
    expect(calls.map((call) => call.method)).toEqual([
      AssistantLinkMethod.AUTHENTICATE,
      AssistantLinkMethod.AGENTS,
    ]);
    expect(calls[1]).toMatchObject({ payload: { projectId: "p" }, timeoutMs: 5_000 });
  });

  it("reads a refusal it doesn't know as control off", async () => {
    const { relay } = client((method) =>
      method === AssistantLinkMethod.AGENTS ? { status: "refused", reason: "later" } : null
    );
    await expect(relay.agents("studio", {})).resolves.toEqual({
      status: "refused",
      reason: "control-off",
    });
  });

  it("names a host from before it unsupported, and an unreadable answer invalid", async () => {
    const old = client((method) => {
      if (method === AssistantLinkMethod.AGENTS) {
        throw new AppError({ code: "UNSUPPORTED", message: "Unknown method" });
      }
      return null;
    });
    await expect(old.relay.agents("studio", {})).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const garbled = client((method) =>
      method === AssistantLinkMethod.AGENTS
        ? { status: "done", directory: { ...DIRECTORY, coverage: "everything" } }
        : null
    );
    await expect(garbled.relay.agents("studio", {})).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("HostControlLinkClient relay notices (#13500)", () => {
  type Receiver = RelayNoticeReceiver;

  function receiver(calls: ReturnType<Receiver["noticeCalls"]> = []) {
    return {
      receiveNotices: vi.fn((_hostId: string, _payload: RelayNoticesPayload): null => null),
      noticeCalls: vi.fn((_hostId: string) => calls),
      receiveNoticeStatus: vi.fn((_hostId: string, _answer: RelayNoticeStatusAnswer) => {}),
    } satisfies Receiver;
  }

  function opened(
    taker?: Receiver,
    answer: (method: string, payload: unknown) => unknown = () => null
  ) {
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const calls: Array<{ method: string; payload: unknown }> = [];
    const session = {
      isOpen: true,
      call: vi.fn(async (method: string, payload: unknown) => {
        calls.push({ method, payload });
        return answer(method, payload);
      }),
      registerCallHandler: (
        method: string,
        schema: { parse(v: unknown): unknown },
        handler: (p: unknown) => unknown
      ) => {
        handlers.set(method, (payload) => handler(schema.parse(payload)));
      },
    } as unknown as LinkSession;
    let open: (hostId: string, session: LinkSession) => void = () => {};
    const relay = new HostControlLinkClient({
      credential: () => CREDENTIAL,
      session: async () => session,
      onSessionOpened: (listener) => {
        open = listener;
        return () => {};
      },
      noticeStatusDelayMs: 1_000,
      ...(taker ? { noticeReceiver: () => taker } : {}),
    });
    relay.start();
    open("studio", session);
    return { relay, handlers, calls };
  }

  const PAYLOAD_NOTICES = {
    notices: [
      {
        noticeId: "n-1",
        helpSessionId: "help-1",
        callId: "call-1",
        terminalId: "t-1",
        observation: { kind: "closed" },
      },
    ],
  };
  const AWAITED = [{ helpSessionId: "help-1", callId: "call-1" }];
  const STATUS: RelayNoticeStatusAnswer = {
    calls: [{ helpSessionId: "help-1", callId: "call-1", status: "unknown" }],
  };
  const statusAnswer = (method: string) =>
    method === AssistantLinkMethod.RELAY_NOTICE_STATUS ? STATUS : null;

  it("hands a host's notices on with the host the connection names", () => {
    const taker = receiver();
    const { relay, handlers } = opened(taker);
    expect(handlers.get(AssistantLinkMethod.RELAY_NOTICES)!(PAYLOAD_NOTICES)).toBeNull();
    expect(taker.receiveNotices).toHaveBeenCalledWith("studio", PAYLOAD_NOTICES);
    relay.dispose();
  });

  it("drops them quietly with nobody to take them", () => {
    const { relay, handlers } = opened();
    expect(handlers.get(AssistantLinkMethod.RELAY_NOTICES)!(PAYLOAD_NOTICES)).toBeNull();
    relay.dispose();
  });

  it("proves its sender on a new session and asks after the calls it still awaits (#13930)", async () => {
    const taker = receiver(AWAITED);
    const { relay, calls } = opened(taker, statusAnswer);

    await vi.waitFor(() =>
      expect(taker.receiveNoticeStatus).toHaveBeenCalledWith("studio", STATUS)
    );
    expect(calls).toEqual([
      { method: AssistantLinkMethod.AUTHENTICATE, payload: { credential: CREDENTIAL } },
      { method: AssistantLinkMethod.RELAY_NOTICE_STATUS, payload: { calls: AWAITED } },
    ]);
    relay.dispose();
  });

  it("asks nothing of a new session while it awaits no notices there", async () => {
    const taker = receiver();
    const { relay, calls } = opened(taker);
    await Promise.resolve();
    expect(taker.noticeCalls).toHaveBeenCalledWith("studio");
    expect(calls).toEqual([]);
    relay.dispose();
  });

  it("asks once after a burst of notices, a little later", async () => {
    vi.useFakeTimers();
    try {
      const taker = receiver();
      const { relay, handlers, calls } = opened(taker, statusAnswer);
      await vi.advanceTimersByTimeAsync(0);
      taker.noticeCalls.mockReturnValue(AWAITED);
      handlers.get(AssistantLinkMethod.RELAY_NOTICES)!(PAYLOAD_NOTICES);
      handlers.get(AssistantLinkMethod.RELAY_NOTICES)!(PAYLOAD_NOTICES);
      expect(calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.map((call) => call.method)).toEqual([
        AssistantLinkMethod.AUTHENTICATE,
        AssistantLinkMethod.RELAY_NOTICE_STATUS,
      ]);
      expect(taker.receiveNoticeStatus).toHaveBeenCalledTimes(1);
      relay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks a little after a call that asked for notices answers", async () => {
    vi.useFakeTimers();
    try {
      const taker = receiver();
      const { relay, calls } = opened(taker, (method) => {
        if (method === AssistantLinkMethod.MCP_CALL) {
          return { status: "done", result: { isError: false, structured: null, text: "ok" } };
        }
        return statusAnswer(method);
      });
      await vi.advanceTimersByTimeAsync(0);
      await relay.relayCall("studio", { ...PAYLOAD, tool: "terminal.list" }, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(taker.noticeCalls).toHaveBeenCalledTimes(1);

      taker.noticeCalls.mockReturnValue(AWAITED);
      await relay.relayCall(
        "studio",
        { ...PAYLOAD, tool: "terminal.notifyWhenIdle", args: { terminalId: "t-1" } },
        1_000
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.at(-1)).toEqual({
        method: AssistantLinkMethod.RELAY_NOTICE_STATUS,
        payload: { calls: AWAITED },
      });
      expect(taker.receiveNoticeStatus).toHaveBeenCalledWith("studio", STATUS);
      relay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an older host that can't say alone, and holds nothing it couldn't read", async () => {
    const warn = loggerMock.warn;
    warn.mockClear();
    try {
      const old = receiver(AWAITED);
      const unsupported = opened(old, (method) => {
        if (method === AssistantLinkMethod.RELAY_NOTICE_STATUS) {
          throw new AppError({ code: "UNSUPPORTED", message: "no such method" });
        }
        return null;
      });
      await vi.waitFor(() => expect(unsupported.calls).toHaveLength(2));
      await Promise.resolve();
      expect(old.receiveNoticeStatus).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      unsupported.relay.dispose();

      const garbled = receiver(AWAITED);
      const invalid = opened(garbled, (method) =>
        method === AssistantLinkMethod.RELAY_NOTICE_STATUS ? { calls: "nope" } : null
      );
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(garbled.receiveNoticeStatus).not.toHaveBeenCalled();
      invalid.relay.dispose();
    } finally {
      warn.mockClear();
    }
  });
});

describe("HostControlLinkClient relay approvals (#13501)", () => {
  const ASK = {
    approvalId: "approval-1",
    helpSessionId: "help-1",
    callId: "call-1",
    projectId: "p",
    actionId: "worktree.delete",
    args: { worktreeId: "/wt/feature" },
    argsHash: "a".repeat(64),
    lines: ["No uncommitted changes."],
  };

  function opened(receiver?: {
    receiveApproval(hostId: string, payload: RelayApprovePayload): Promise<RelayApproveAnswer>;
  }) {
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const session = {
      isOpen: true,
      call: vi.fn(async () => null),
      registerCallHandler: (
        method: string,
        schema: { parse(v: unknown): unknown },
        handler: (p: unknown) => unknown
      ) => {
        handlers.set(method, (payload) => handler(schema.parse(payload)));
      },
    } as unknown as LinkSession;
    let open: (hostId: string, session: LinkSession) => void = () => {};
    const relay = new HostControlLinkClient({
      credential: () => CREDENTIAL,
      session: async () => session,
      onSessionOpened: (listener) => {
        open = listener;
        return () => {};
      },
      ...(receiver ? { approvalReceiver: () => receiver } : {}),
    });
    relay.start();
    open("studio", session);
    return { relay, handlers };
  }

  it("hands a host's ask on with the host the connection names", async () => {
    const receiveApproval = vi.fn(
      async (_hostId: string, payload: RelayApprovePayload): Promise<RelayApproveAnswer> => ({
        approvalId: payload.approvalId,
        argsHash: payload.argsHash,
        decision: "approved",
      })
    );
    const { relay, handlers } = opened({ receiveApproval });

    await expect(handlers.get(AssistantLinkMethod.RELAY_APPROVE)!(ASK)).resolves.toEqual({
      approvalId: "approval-1",
      argsHash: ASK.argsHash,
      decision: "approved",
    });
    expect(receiveApproval).toHaveBeenCalledWith("studio", ASK);
    relay.dispose();
  });

  it("refuses an ask with nobody to put it to, approving nothing", async () => {
    const { relay, handlers } = opened();
    expect(await handlers.get(AssistantLinkMethod.RELAY_APPROVE)!(ASK)).toMatchObject({
      decision: "refused",
    });
    relay.dispose();
  });

  it("refuses to read an ask with unbounded preview lines", () => {
    const { relay, handlers } = opened();
    expect(() =>
      handlers.get(AssistantLinkMethod.RELAY_APPROVE)!({
        ...ASK,
        lines: new Array(201).fill("row"),
      })
    ).toThrow();
    relay.dispose();
  });
});
