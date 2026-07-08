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

  it("threads the generated request id into the built request", async () => {
    const { shard, sentRequests } = makeShard({ registerResult: [] });

    await sendPtyHostRpc(shard, "terminals-proj-1", (requestId) => ({
      type: "get-terminals-for-project",
      projectId: "proj-1",
      requestId,
    }));

    expect(sentRequests).toEqual([
      {
        type: "get-terminals-for-project",
        projectId: "proj-1",
        requestId: "req-1-terminals-proj-1",
      },
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

  it("normalizes a missing options arg to an empty object rather than omitting it", async () => {
    const { shard, registerArgs } = makeShard({ registerResult: null });

    await sendPtyHostRpc(shard, "no-options", (requestId) => ({
      type: "get-project-stats",
      projectId: "p",
      requestId,
    }));

    expect(registerArgs).toEqual([{}]);
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
