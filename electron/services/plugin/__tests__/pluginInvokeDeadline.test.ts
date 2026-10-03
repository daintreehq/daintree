import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS } from "../../../../shared/config/pluginBudgets.js";
import type { PluginIpcContext } from "../../../../shared/types/plugin.js";
import {
  PLUGIN_INVOKE_TIMEOUT,
  PluginInvokeTimeoutError,
  invokeSignalFor,
  resolveInvokeTimeoutMs,
  runWithInvokeDeadline,
} from "../pluginInvokeDeadline.js";

const ctx: PluginIpcContext = {
  projectId: null,
  worktreeId: null,
  webContentsId: 1,
  pluginId: "acme.demo",
};

describe("resolveInvokeTimeoutMs", () => {
  it("defaults an omitted value and keeps 0 and positive numbers", () => {
    expect(resolveInvokeTimeoutMs("p", "c", undefined)).toBe(PLUGIN_INVOKE_DEFAULT_TIMEOUT_MS);
    expect(resolveInvokeTimeoutMs("p", "c", 0)).toBe(0);
    expect(resolveInvokeTimeoutMs("p", "c", 1500)).toBe(1500);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "100", null])(
    "rejects %s at registration",
    (raw) => {
      expect(() => resolveInvokeTimeoutMs("p", "c", raw)).toThrow(/timeoutMs must be a number/);
    }
  );
});

describe("runWithInvokeDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the handler's result inside the deadline", async () => {
    const result = runWithInvokeDeadline("p", "c", 1000, ctx, async () => "ok");
    await expect(result).resolves.toBe("ok");
  });

  it("passes a handler rejection through untouched", async () => {
    const boom = new Error("boom");
    const result = runWithInvokeDeadline("p", "c", 1000, ctx, async () => {
      throw boom;
    });
    await expect(result).rejects.toBe(boom);
  });

  it("rejects with PLUGIN_INVOKE_TIMEOUT and aborts the invoke's signal on expiry", async () => {
    let seen: AbortSignal | undefined;
    const result = runWithInvokeDeadline("acme.demo", "slow", 250, ctx, (scoped) => {
      seen = invokeSignalFor(scoped);
      return new Promise(() => {});
    }) as Promise<unknown>;
    const settled = result.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(250);
    const error = await settled;

    expect(error).toBeInstanceOf(PluginInvokeTimeoutError);
    expect((error as PluginInvokeTimeoutError).code).toBe(PLUGIN_INVOKE_TIMEOUT);
    expect((error as Error).message).toBe(
      'PLUGIN_INVOKE_TIMEOUT: plugin "acme.demo" handler "slow" did not settle within 250 ms'
    );
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(error);
  });

  it("hands each invoke its own context copy, never the caller's object", async () => {
    let scopedCtx: PluginIpcContext | undefined;
    await runWithInvokeDeadline("p", "c", 1000, ctx, (scoped) => {
      scopedCtx = scoped;
      return null;
    });
    expect(scopedCtx).toEqual(ctx);
    expect(scopedCtx).not.toBe(ctx);
    expect(invokeSignalFor(ctx)).toBeUndefined();
  });

  it("clears its timer once the handler settles", async () => {
    await runWithInvokeDeadline("p", "c", 1000, ctx, async () => "ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls the handler directly with no deadline when timeoutMs is 0", () => {
    const value = runWithInvokeDeadline("p", "c", 0, ctx, (scoped) => {
      expect(scoped).toBe(ctx);
      return "sync";
    });
    expect(value).toBe("sync");
    expect(vi.getTimerCount()).toBe(0);
  });
});
