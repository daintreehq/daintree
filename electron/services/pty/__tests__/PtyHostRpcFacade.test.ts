import { describe, expect, it, vi } from "vitest";
import { sendPtyHostRpc } from "../PtyHostRpcFacade.js";
import type { PtyShard } from "../PtyShard.js";

/** Minimal shard double — the facade only touches `broker` and `send`. */
function makeShard(overrides: { registerResult?: unknown; registerError?: Error } = {}) {
  const calls: string[] = [];
  const registerArgs: unknown[] = [];
  const sentRequests: unknown[] = [];
  const shard = {
    broker: {
      generateId: vi.fn((suffix?: string) => {
        calls.push("generateId");
        return suffix ? `req-1-${suffix}` : "req-1";
      }),
      register: vi.fn((_requestId: string, options?: unknown) => {
        calls.push("register");
        registerArgs.push(options);
        if (overrides.registerError) {
          return Promise.reject(overrides.registerError);
        }
        return Promise.resolve(overrides.registerResult);
      }),
    },
    send: vi.fn((request: unknown) => {
      calls.push("send");
      sentRequests.push(request);
    }),
  };
  return { shard: shard as unknown as PtyShard, calls, registerArgs, sentRequests };
}

describe("sendPtyHostRpc", () => {
  it("generates the request id via the suffix, registers, then sends — in that order", async () => {
    const { shard, calls, sentRequests } = makeShard({ registerResult: { ok: true } });

    const result = await sendPtyHostRpc<{ ok: boolean }>(shard, "my-suffix", (requestId) => ({
      type: "get-terminal",
      id: "t1",
      requestId,
    }));

    expect(result).toEqual({ ok: true });
    expect(shard.broker.generateId).toHaveBeenCalledWith("my-suffix");
    // Register must be called before send — the host can resolve synchronously
    // on some paths, so listeners must be live before the message goes out (#5434).
    expect(calls).toEqual(["generateId", "register", "send"]);
    expect(sentRequests).toEqual([
      { type: "get-terminal", id: "t1", requestId: "req-1-my-suffix" },
    ]);
  });

  it("forwards register options (method/timeoutMs) to the broker", async () => {
    const { shard, registerArgs } = makeShard({ registerResult: null });

    await sendPtyHostRpc(
      shard,
      "graceful-kill-t1",
      (requestId) => ({ type: "graceful-kill", id: "t1", requestId }),
      { method: "graceful-kill", timeoutMs: 5000 }
    );

    expect(registerArgs).toEqual([{ method: "graceful-kill", timeoutMs: 5000 }]);
  });

  it("leaves rejection handling to the caller — does not swallow broker errors", async () => {
    const { shard } = makeShard({ registerError: new Error("boom") });

    await expect(
      sendPtyHostRpc(shard, "will-fail", (requestId) => ({
        type: "get-terminal",
        id: "t1",
        requestId,
      }))
    ).rejects.toThrow("boom");
  });
});
