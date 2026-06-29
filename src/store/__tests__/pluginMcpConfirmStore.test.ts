import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPluginMcpConfirmStoreForTesting,
  requestPluginMcpConsent,
  usePluginMcpConfirmStore,
} from "../pluginMcpConfirmStore";
import {
  PLUGIN_MCP_CONSENT_TIMEOUT_MS,
  type PluginMcpConsentRequestEvent,
} from "@shared/types/pluginMcpConsent";

function req(id: string): PluginMcpConsentRequestEvent {
  return {
    requestId: id,
    pluginId: "acme.x",
    serverId: "srv",
    toolName: "do_thing",
    pluginDisplayName: "Acme",
    descriptionDisplay: "Does a thing",
    argsSummary: "",
    dangerTier: "D1",
    declaredCapabilities: [],
    reason: "first-use",
  };
}

afterEach(() => {
  __resetPluginMcpConfirmStoreForTesting();
});

describe("pluginMcpConfirmStore", () => {
  it("surfaces the first request immediately and resolves its promise on decision", async () => {
    const p = requestPluginMcpConsent(req("r1"));
    expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("r1");

    usePluginMcpConfirmStore.getState().resolveCurrent("approved-and-pin");
    await expect(p).resolves.toBe("approved-and-pin");
    expect(usePluginMcpConfirmStore.getState().current).toBeNull();
  });

  it("queues concurrent requests and advances in FIFO order", async () => {
    const p1 = requestPluginMcpConsent(req("r1"));
    const p2 = requestPluginMcpConsent(req("r2"));

    const state = usePluginMcpConfirmStore.getState();
    expect(state.current?.requestId).toBe("r1");
    expect(state.queue.map((q) => q.requestId)).toEqual(["r2"]);

    usePluginMcpConfirmStore.getState().resolveCurrent("approved-once");
    await expect(p1).resolves.toBe("approved-once");
    expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("r2");

    usePluginMcpConfirmStore.getState().resolveCurrent("rejected");
    await expect(p2).resolves.toBe("rejected");
  });

  it("rejects a duplicate requestId without disturbing the live prompt", async () => {
    const p1 = requestPluginMcpConsent(req("dup"));
    const dup = requestPluginMcpConsent(req("dup"));
    await expect(dup).resolves.toBe("rejected");
    expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("dup");

    usePluginMcpConfirmStore.getState().resolveCurrent("approved-and-pin");
    await expect(p1).resolves.toBe("approved-and-pin");
  });

  it("drop rejects a queued request and removes it from the queue", async () => {
    const p1 = requestPluginMcpConsent(req("r1"));
    const p2 = requestPluginMcpConsent(req("r2"));

    usePluginMcpConfirmStore.getState().drop("r2");
    await expect(p2).resolves.toBe("rejected");
    expect(usePluginMcpConfirmStore.getState().queue).toHaveLength(0);
    expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("r1");
    usePluginMcpConfirmStore.getState().resolveCurrent("approved-once");
    await expect(p1).resolves.toBe("approved-once");
  });

  describe("consent timeout safety net (#10841)", () => {
    it("settles an abandoned prompt as 'timeout' and evicts it from the store", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginMcpConsent(req("r1"));
        expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("r1");

        await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS);

        await expect(p).resolves.toBe("timeout");
        expect(usePluginMcpConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire after a user decision clears the timer", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginMcpConsent(req("r1"));
        usePluginMcpConfirmStore.getState().resolveCurrent("approved-and-pin");
        await expect(p).resolves.toBe("approved-and-pin");

        await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS * 2);
        await expect(p).resolves.toBe("approved-and-pin");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire after drop clears the timer", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginMcpConsent(req("r1"));
        usePluginMcpConfirmStore.getState().drop("r1");
        await expect(p).resolves.toBe("rejected");

        await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS * 2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("advances the FIFO queue when a queued prompt times out", async () => {
      vi.useFakeTimers();
      try {
        const p1 = requestPluginMcpConsent(req("r1"));
        const p2 = requestPluginMcpConsent(req("r2"));

        usePluginMcpConfirmStore.getState().resolveCurrent("approved-once");
        await expect(p1).resolves.toBe("approved-once");
        expect(usePluginMcpConfirmStore.getState().current?.requestId).toBe("r2");

        await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS);
        await expect(p2).resolves.toBe("timeout");
        expect(usePluginMcpConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reset clears pending timers so they never fire into a cleared store", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginMcpConsent(req("r1"));
        __resetPluginMcpConfirmStoreForTesting();

        await vi.advanceTimersByTimeAsync(PLUGIN_MCP_CONSENT_TIMEOUT_MS * 2);
        expect(usePluginMcpConfirmStore.getState().current).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        void p;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
