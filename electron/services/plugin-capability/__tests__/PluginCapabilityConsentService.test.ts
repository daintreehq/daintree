import { describe, expect, it, vi } from "vitest";
import { PluginCapabilityConsentService } from "../PluginCapabilityConsentService.js";
import { PluginCapabilityConsentStore } from "../PluginCapabilityConsentStore.js";
import type {
  PluginCapabilityConsentDecision,
  PluginCapabilityConsentOutcome,
} from "../../../../shared/types/pluginCapabilityConsent.js";

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
  it("fails closed as undeliverable when no consent bridge is installed", async () => {
    const { service, store } = makeService();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // No bridge means no UI at all — fail closed, but don't attribute it to a
      // user who was never asked (#11708).
      await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
        /PERMISSION_REQUIRED.*could not present.*shell:exec/
      );
      expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    } finally {
      error.mockRestore();
    }
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
        /PERMISSION_REQUIRED.*shell:exec.*timed out/
      );
      // A timed-out prompt must not leave a grant behind.
      expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
      // Logged distinctly so an abandoned dialog is diagnosable.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      warn.mockRestore();
    }
  });

  it("treats a thrown bridge as undeliverable (fail-closed)", async () => {
    const { service, store } = makeService();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      service.setConsentBridge(async () => {
        throw new Error("renderer blew up");
      });
      await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
        /PERMISSION_REQUIRED.*could not present/
      );
      expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it("classifies a synchronously thrown bridge as undeliverable, not a raw error", async () => {
    const { service, store } = makeService();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Deliberately NOT async: this throws before any promise exists, so a
      // bare `bridge(...).catch(...)` would let it escape unclassified and the
      // plugin would see an error without the prefix the SDK keys on.
      service.setConsentBridge(() => {
        throw new Error("no window ref");
      });
      await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
        /PERMISSION_REQUIRED.*could not present/
      );
      expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);

      // The failed attempt must not poison the coalescing map — a later call
      // still gets to prompt.
      const bridge = vi.fn(async () => "approved-once" as PluginCapabilityConsentOutcome);
      service.setConsentBridge(bridge);
      await expect(
        service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)
      ).resolves.toBeUndefined();
      expect(bridge).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it.each(["undeliverable", "timeout", "rejected"] as const)(
    "coalesces concurrent callers onto one prompt and gives them all the same %s failure",
    async (outcome) => {
      const { service, store } = makeService();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let release!: (o: PluginCapabilityConsentOutcome) => void;
        const bridge = vi.fn(
          () =>
            new Promise<PluginCapabilityConsentOutcome>((resolve) => {
              release = resolve;
            })
        );
        service.setConsentBridge(bridge);

        const calls = [
          service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS),
          service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS),
          service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS),
        ].map((p) =>
          p.then(
            () => null,
            (err: Error) => err.message
          )
        );
        expect(bridge).toHaveBeenCalledTimes(1);

        release(outcome);
        const messages = await Promise.all(calls);

        // Every waiter fails closed, with the same reason — a coalesced caller
        // must not be told a different story from the one that raised the prompt.
        expect(messages.every((m) => m !== null)).toBe(true);
        expect(new Set(messages).size).toBe(1);
        expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);

        // A settled failure must not linger in the in-flight map and suppress
        // the next prompt.
        release = () => {};
        void service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS).catch(() => {});
        expect(bridge).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    }
  );

  it("reports undeliverable, timeout and rejection as three distinguishable failures (#11708)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const messageFor = async (outcome: PluginCapabilityConsentOutcome): Promise<string> => {
        const { service } = makeService();
        service.setConsentBridge(async () => outcome);
        try {
          await service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
          throw new Error(`expected ${outcome} to fail closed`);
        } catch (err) {
          return (err as Error).message;
        }
      };

      const undeliverable = await messageFor("undeliverable");
      const timedOut = await messageFor("timeout");
      const rejected = await messageFor("rejected");

      // All fail closed behind the prefix the SDK discriminates on...
      for (const message of [undeliverable, timedOut, rejected]) {
        expect(message).toContain("PERMISSION_REQUIRED");
      }
      // ...but a plugin author reading the error can tell what actually
      // happened. Conflating these was the misleading half of #11708: an
      // undelivered prompt was reported as an explicit refusal.
      expect(new Set([undeliverable, timedOut, rejected]).size).toBe(3);
      expect(undeliverable).not.toContain("was denied");
      expect(timedOut).not.toContain("was denied");
      expect(rejected).toContain("was denied");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
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

  it("does not coalesce prompts across scopes", async () => {
    const { service } = makeService();
    const bridge = vi.fn(async () => "approved-once" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);

    await Promise.all([
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS),
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS, "proj-1"),
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS, "proj-2"),
    ]);
    // Three scopes, three decisions — collapsing them would approve two scopes
    // the user was never shown.
    expect(bridge).toHaveBeenCalledTimes(3);
  });

  it("treats an omitted scope and an explicit global scope as one prompt", async () => {
    const { service } = makeService();
    let resolveBridge!: (d: PluginCapabilityConsentDecision) => void;
    const bridge = vi.fn(
      () =>
        new Promise<PluginCapabilityConsentDecision>((resolve) => {
          resolveBridge = resolve;
        })
    );
    service.setConsentBridge(bridge);

    // The store key and the coalescing key each default an absent scope
    // independently; if they ever drift, these two stop being the same request.
    const a = service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS);
    const b = service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS, "global");
    expect(bridge).toHaveBeenCalledTimes(1);

    resolveBridge("approved-and-pin");
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it("a grant in one scope does not satisfy a check in another", async () => {
    const { service, store } = makeService();
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    const bridge = vi.fn(async () => "rejected" as PluginCapabilityConsentDecision);
    service.setConsentBridge(bridge);

    // Granted scope passes silently...
    await expect(
      service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS, "proj-1")
    ).resolves.toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();

    // ...and the global scope still has to ask.
    await expect(service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS)).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("approved-and-pin pins only the scope that was asked about", async () => {
    const { service, store } = makeService();
    service.setConsentBridge(async () => "approved-and-pin");
    await service.ensureAllowed("acme.x", "Acme", "shell:exec", CAPS, "proj-1");
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(true);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
  });

  it("revokeAllForPlugin clears grants in every scope through the service", async () => {
    const { service, store } = makeService();
    store.grant({ pluginId: "acme.x", capability: "shell:exec" });
    store.grant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" });
    expect(service.revokeAllForPlugin("acme.x")).toBe(true);
    expect(store.hasGrant({ pluginId: "acme.x", capability: "shell:exec" })).toBe(false);
    expect(
      store.hasGrant({ pluginId: "acme.x", capability: "shell:exec", scopeKey: "proj-1" })
    ).toBe(false);
  });
});
