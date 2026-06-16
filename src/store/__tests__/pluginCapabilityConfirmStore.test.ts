import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPluginCapabilityConfirmStoreForTesting,
  requestPluginCapabilityConsent,
  usePluginCapabilityConfirmStore,
} from "../pluginCapabilityConfirmStore";
import type { PluginCapabilityConsentRequestEvent } from "@shared/types/pluginCapabilityConsent";

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

  it("rejects a duplicate requestId without disturbing the live prompt", async () => {
    const p1 = requestPluginCapabilityConsent(req("dup"));
    const dup = requestPluginCapabilityConsent(req("dup"));
    await expect(dup).resolves.toBe("rejected");
    // The original is still pending and current.
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("dup");

    usePluginCapabilityConfirmStore.getState().resolveCurrent("approved-and-pin");
    await expect(p1).resolves.toBe("approved-and-pin");
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
});
