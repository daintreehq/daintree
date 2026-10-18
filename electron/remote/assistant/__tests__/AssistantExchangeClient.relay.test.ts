import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import type { AssistantExchangeJournal } from "../../exchange/AssistantExchangeJournal.js";
import type { LinkSession } from "../../link/session.js";
import { AssistantExchangeClient } from "../AssistantExchangeClient.js";
import { AssistantLinkMethod, type McpCallPayload } from "../linkMethods.js";

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
  const relay = new AssistantExchangeClient({
    journal: { credential: () => CREDENTIAL } as unknown as AssistantExchangeJournal,
    session: async () => session,
    onSessionOpened: () => () => {},
  });
  return { relay, calls };
}

describe("AssistantExchangeClient.relayCall (#13493)", () => {
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
