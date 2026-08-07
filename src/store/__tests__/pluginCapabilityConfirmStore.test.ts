import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPluginCapabilityConfirmStoreForTesting,
  requestPluginCapabilityConsent,
  usePluginCapabilityConfirmStore,
} from "../pluginCapabilityConfirmStore";
import {
  PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS,
  type PluginCapabilityConsentRequestEvent,
} from "@shared/types/pluginCapabilityConsent";

function req(id: string): Omit<PluginCapabilityConsentRequestEvent, never> {
  return {
    requestId: id,
    pluginId: "acme.x",
    pluginDisplayName: "Acme",
    capability: "shell:exec",
    declaredCapabilities: ["shell:exec"],
  };
}

afterEach(() => {
  __resetPluginCapabilityConfirmStoreForTesting();
});

describe("pluginCapabilityConfirmStore", () => {
  it("surfaces the first request immediately and resolves its promise on decision", async () => {
    const p = requestPluginCapabilityConsent(req("r1"));
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("r1");

    usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin");
    await expect(p).resolves.toBe("approved-and-pin");
    expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
  });

  it("queues concurrent requests and advances in FIFO order", async () => {
    const p1 = requestPluginCapabilityConsent(req("r1"));
    const p2 = requestPluginCapabilityConsent(req("r2"));

    const state = usePluginCapabilityConfirmStore.getState();
    expect(state.current?.requestId).toBe("r1");
    expect(state.queue.map((q) => q.requestId)).toEqual(["r2"]);

    usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once");
    await expect(p1).resolves.toBe("approved-once");
    // Second prompt becomes current.
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("r2");

    usePluginCapabilityConfirmStore.getState().resolveCurrent("rejected");
    await expect(p2).resolves.toBe("rejected");
  });

  it("shares one prompt between repeat requests for the same requestId (#11708)", async () => {
    const p1 = requestPluginCapabilityConsent(req("dup"));
    const dup = requestPluginCapabilityConsent(req("dup"));

    // Main re-pushes an unacknowledged prompt, so the same id can legitimately
    // arrive twice. It must not queue a second dialog...
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("dup");
    expect(usePluginCapabilityConfirmStore.getState().queue).toHaveLength(0);

    // ...and must not settle early. Resolving a repeat as "rejected" would
    // reach the plugin as a denial the user never made.
    usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin");
    await expect(p1).resolves.toBe("approved-and-pin");
    await expect(dup).resolves.toBe("approved-and-pin");
  });

  it("drop rejects a queued request and removes it from the queue", async () => {
    const p1 = requestPluginCapabilityConsent(req("r1"));
    const p2 = requestPluginCapabilityConsent(req("r2"));

    usePluginCapabilityConfirmStore.getState().drop("r2");
    await expect(p2).resolves.toBe("rejected");
    expect(usePluginCapabilityConfirmStore.getState().queue).toHaveLength(0);
    // r1 unaffected.
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("r1");
    usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once");
    await expect(p1).resolves.toBe("approved-once");
  });

  describe("consent timeout safety net (#10841)", () => {
    it("settles an abandoned prompt as 'timeout' and evicts it from the store", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginCapabilityConsent(req("r1"));
        expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("r1");

        await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS);

        await expect(p).resolves.toBe("timeout");
        expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire after a user decision clears the timer", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginCapabilityConsent(req("r1"));
        usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin");
        await expect(p).resolves.toBe("approved-and-pin");

        // Advancing past the deadline must not re-settle the already-decided promise.
        await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS * 2);
        await expect(p).resolves.toBe("approved-and-pin");
      } finally {
        vi.useRealTimers();
      }
    });

    it("advances the FIFO queue when a queued prompt times out", async () => {
      vi.useFakeTimers();
      try {
        const p1 = requestPluginCapabilityConsent(req("r1"));
        const p2 = requestPluginCapabilityConsent(req("r2"));

        usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-once");
        await expect(p1).resolves.toBe("approved-once");
        expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("r2");

        await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS);
        await expect(p2).resolves.toBe("timeout");
        expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reset clears pending timers so they never fire into a cleared store", async () => {
      vi.useFakeTimers();
      try {
        const p = requestPluginCapabilityConsent(req("r1"));
        __resetPluginCapabilityConfirmStoreForTesting();

        await vi.advanceTimersByTimeAsync(PLUGIN_CAPABILITY_CONSENT_TIMEOUT_MS * 2);
        // The promise stays unsettled (the timer was cleared); no leaked timer
        // re-enqueued or re-settled anything.
        expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        void p;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
