import { describe, expect, it, vi } from "vitest";
import { PluginCapabilityConsentService } from "../PluginCapabilityConsentService.js";
import { PluginCapabilityConsentStore } from "../PluginCapabilityConsentStore.js";
import type { PluginCapabilityConsentDecision } from "../../../../shared/types/pluginCapabilityConsent.js";

function makeService() {
  let config: Record<string, unknown> = {};
  const store = new PluginCapabilityConsentStore(
    (patch) => {
      config = { ...config, ...patch };
    },
    () => config
  );
  const service = new PluginCapabilityConsentService(store);
  return { service, store };
}

const CAPS = ["shell:exec"] as const;

describe("PluginCapabilityConsentService", () => {
  it("denies (fail-closed) when no consent bridge is installed", async () => {
    const { service, store } = makeService();
    await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    // A denial must not leave a grant behind.
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
  });

  it("short-circuits without prompting once a capability is granted", async () => {
    const { service, store } = makeService();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    const bridge = vi.fn(async () => "rejected" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);
    await expect(
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)
    ).resolves.toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("approved-and-pin persists the grant so later calls skip the prompt", async () => {
    const { service, store } = makeService();
    const bridge = vi.fn(async () => "approved-and-pin" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);

    await service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);

    // Second call short-circuits — bridge invoked only once.
    await service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("approved-once allows the call but does not persist a grant", async () => {
    const { service, store } = makeService();
    const bridge = vi.fn(async () => "approved-once" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);

    await expect(
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)
    ).resolves.toBeUndefined();
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);

    // Not pinned, so the next call prompts again.
    await service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it("rejected throws PERMISSION_REQUIRED", async () => {
    const { service } = makeService();
    service.setConsentBridge(async () => "rejected");
    await expect(
      service.ensureAllowed("acme.x", "Acme", "git:write", ["git:write"])
    ).rejects.toThrow(/PERMISSION_REQUIRED.*git:write/);
  });

  it("treats a timeout decision as a fail-closed denial without persisting a grant (#10841)", async () => {
    const { service, store } = makeService();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      service.setConsentBridge(async () => "timeout");
      await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
        /PERMISSION_REQUIRED.*shell:exec/
      );
      // A timed-out prompt must not leave a grant behind.
      expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
      // Logged distinctly so an abandoned dialog is diagnosable.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a thrown bridge as a rejection (fail-closed)", async () => {
    const { service } = makeService();
    service.setConsentBridge(async () => {
      throw new Error("renderer blew up");
    });
    await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
  });

  it("coalesces concurrent first-use calls for the same (plugin, capability) onto one prompt", async () => {
    const { service, store } = makeService();
    let resolveBridge!: (d: PluginCapabilityConsentDecision) => void;
    const bridge = vi.fn(
      () =>
        new Promise<PluginCapabilityConsentDecision>((resolve) => {
          resolveBridge = resolve;
        })
    );
    service.setConsentBridge(bridge);

    const a = service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    const b = service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    const c = service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);

    // All three are waiting on a single in-flight prompt.
    expect(bridge).toHaveBeenCalledTimes(1);

    resolveBridge("approved-and-pin");
    await expect(Promise.all([a, b, c])).resolves.toEqual([undefined, undefined, undefined]);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(true);
  });

  it("does not coalesce across distinct capabilities", async () => {
    const { service } = makeService();
    const bridge = vi.fn(async () => "approved-once" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);

    await Promise.all([
      service.ensureAllowed("acme.x", "Acme", "shell:exec", ["shell:exec", "git:write"]),
      service.ensureAllowed("acme.x", "Acme", "git:write", ["shell:exec", "git:write"]),
    ]);
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it("revokeAllForPlugin clears grants through the service", async () => {
    const { service, store } = makeService();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    expect(service.revokeAllForPlugin("acme.x")).toBe(true);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
  });
});
