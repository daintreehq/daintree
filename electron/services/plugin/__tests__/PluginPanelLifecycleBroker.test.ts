import { describe, it, expect, vi } from "vitest";
import type { PluginPanelLifecycleEvent } from "../../../../shared/types/plugin.js";
import { PluginPanelLifecycleBroker } from "../PluginPanelLifecycleBroker.js";

const OWNERS: Record<string, string> = {
  "acme.dash": "acme",
  "acme.logs": "acme",
  "other.panel": "other",
};

function makeBroker(): PluginPanelLifecycleBroker {
  return new PluginPanelLifecycleBroker((kindId) => OWNERS[kindId]);
}

function event(overrides: Partial<PluginPanelLifecycleEvent> = {}): PluginPanelLifecycleEvent {
  return {
    panelId: "p1",
    panelKindId: "acme.dash",
    pluginId: "acme",
    phase: "mounted",
    ...overrides,
  };
}

describe("routing", () => {
  it("delivers a plugin only its own panels' events", () => {
    const broker = makeBroker();
    const acme = vi.fn();
    const other = vi.fn();
    broker.subscribe("acme", acme);
    broker.subscribe("other", other);

    broker.ingest(1, [event(), event({ panelId: "p2", panelKindId: "other.panel" })]);

    expect(acme).toHaveBeenCalledTimes(1);
    expect(acme.mock.calls[0]?.[0]).toMatchObject({ panelId: "p1", pluginId: "acme" });
    expect(other).toHaveBeenCalledTimes(1);
    expect(other.mock.calls[0]?.[0]).toMatchObject({ panelId: "p2", pluginId: "other" });
  });

  it("resolves ownership from the registry, not the renderer's claim", () => {
    const broker = makeBroker();
    const victim = vi.fn();
    broker.subscribe("other", victim);

    // A renderer claiming someone else's plugin id must not reach their worker.
    broker.ingest(1, [event({ pluginId: "other" })]);

    expect(victim).not.toHaveBeenCalled();
  });

  it("freezes delivered events", () => {
    const broker = makeBroker();
    const seen: PluginPanelLifecycleEvent[] = [];
    broker.subscribe("acme", (e) => seen.push(e));
    broker.ingest(1, [event()]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("keeps delivering to remaining listeners when one throws", () => {
    const broker = makeBroker();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    broker.subscribe("acme", () => {
      throw new Error("plugin bug");
    });
    broker.subscribe("acme", healthy);

    broker.ingest(1, [event()]);

    expect(healthy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("stops delivering after the disposer runs, and the disposer is idempotent", () => {
    const broker = makeBroker();
    const listener = vi.fn();
    const dispose = broker.subscribe("acme", listener);
    broker.ingest(1, [event()]);
    dispose();
    dispose();
    broker.ingest(1, [event({ phase: "hidden" })]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("replay on subscribe", () => {
  it("replays the current phase of live panels", () => {
    const broker = makeBroker();
    broker.ingest(1, [
      event({ panelId: "p1", phase: "mounted" }),
      event({ panelId: "p2", panelKindId: "acme.logs", phase: "hidden" }),
    ]);

    const listener = vi.fn();
    broker.subscribe("acme", listener);

    // A plugin activates BECAUSE a view opened, so it subscribes after its own
    // panel already reported `mounted` — without replay it would never learn.
    expect(listener.mock.calls.map(([e]) => [e.panelId, e.phase])).toEqual([
      ["p1", "mounted"],
      ["p2", "hidden"],
    ]);
  });

  it("replays only the latest phase per panel", () => {
    const broker = makeBroker();
    broker.ingest(1, [event({ phase: "mounted" })]);
    broker.ingest(1, [event({ phase: "hidden" })]);

    const listener = vi.fn();
    broker.subscribe("acme", listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].phase).toBe("hidden");
  });

  it("does not replay removed panels", () => {
    const broker = makeBroker();
    broker.ingest(1, [event({ phase: "mounted" })]);
    broker.ingest(1, [event({ phase: "removed" })]);

    const listener = vi.fn();
    broker.subscribe("acme", listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not replay restored, which describes a moment rather than a state", () => {
    const broker = makeBroker();
    broker.ingest(1, [event({ phase: "restored" })]);

    const listener = vi.fn();
    broker.subscribe("acme", listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not replay another plugin's panels", () => {
    const broker = makeBroker();
    broker.ingest(1, [event({ panelKindId: "other.panel" })]);
    const listener = vi.fn();
    broker.subscribe("acme", listener);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("source isolation", () => {
  it("keeps each renderer's panels in its own bucket", () => {
    const broker = makeBroker();
    broker.ingest(1, [event({ panelId: "p1" })]);
    broker.ingest(2, [event({ panelId: "p2" })]);

    broker.clearSource(1);

    const listener = vi.fn();
    broker.subscribe("acme", listener);
    expect(listener.mock.calls.map(([e]) => e.panelId)).toEqual(["p2"]);
  });

  it("never synthesizes removed when a renderer goes away", () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.subscribe("acme", listener);
    broker.ingest(1, [event({ phase: "mounted" })]);
    listener.mockClear();

    // A cached or crashed WebContentsView says nothing about whether the user
    // closed the panel — inventing a terminal event is the destructive misread
    // this whole API exists to prevent.
    broker.clearSource(1);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("input validation", () => {
  it("drops malformed entries without losing the rest of the batch", () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.subscribe("acme", listener);

    broker.ingest(1, [
      null,
      "nope",
      { panelId: "", panelKindId: "acme.dash", phase: "mounted" },
      { panelId: "p1", panelKindId: "acme.dash", phase: "not-a-phase" },
      { panelId: "p2", panelKindId: "unregistered.kind", phase: "mounted" },
      event({ panelId: "good" }),
    ]);

    expect(listener.mock.calls.map(([e]) => e.panelId)).toEqual(["good"]);
  });

  it("keeps routing a known panel while its plugin's kinds are unregistered", () => {
    const owners = new Map(Object.entries(OWNERS));
    const broker = new PluginPanelLifecycleBroker((kindId) => owners.get(kindId));
    broker.ingest(1, [event({ phase: "mounted" })]);

    // Disable / upgrade: `unregisterPluginPanelKinds` has run, so a live
    // registry lookup misses — but the renderer is still reporting real
    // transitions for a panel that plainly exists.
    owners.clear();
    broker.ingest(1, [event({ phase: "removed" })]);

    owners.set("acme.dash", "acme");
    const listener = vi.fn();
    broker.subscribe("acme", listener);
    // Dropping the `removed` would have left `mounted` cached and replayed it to
    // the re-enabled plugin's new worker as though the panel were still open.
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not let a recycled panel id inherit another plugin's ownership", () => {
    const owners = new Map(Object.entries(OWNERS));
    const broker = new PluginPanelLifecycleBroker((kindId) => owners.get(kindId));
    broker.ingest(1, [event({ panelId: "p1", panelKindId: "acme.dash" })]);
    owners.clear();

    const acme = vi.fn();
    broker.subscribe("acme", acme);
    acme.mockClear();
    // Same panel id, different kind — the remembered owner must not apply.
    broker.ingest(1, [event({ panelId: "p1", panelKindId: "other.panel", phase: "hidden" })]);
    expect(acme).not.toHaveBeenCalled();
  });

  it("ignores a non-array payload", () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.subscribe("acme", listener);
    broker.ingest(1, "not-an-array" as unknown as unknown[]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("teardown", () => {
  it("clearPlugin drops every listener the plugin registered", () => {
    const broker = makeBroker();
    const listener = vi.fn();
    broker.subscribe("acme", listener);
    broker.clearPlugin("acme");
    broker.ingest(1, [event()]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose drops listeners and remembered panels", () => {
    const broker = makeBroker();
    broker.ingest(1, [event()]);
    broker.dispose();

    const listener = vi.fn();
    broker.subscribe("acme", listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
