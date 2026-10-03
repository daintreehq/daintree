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

describe("locate (#12610)", () => {
  it("finds the renderer holding the plugin's own mounted panel", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "located", sourceId: 7 });
  });

  it("routes a render-failed panel to its renderer, which decides the outcome", () => {
    const broker = makeBroker();
    broker.ingest(7, [event({ phase: "render-failed" })]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "located", sourceId: 7 });
  });

  it.each(["hidden", "backgrounded", "trashed"] as const)(
    "reports a %s panel as not mounted",
    (phase) => {
      const broker = makeBroker();
      broker.ingest(7, [event({ phase })]);
      expect(broker.locate("p1", "acme")).toEqual({ kind: "not-mounted" });
    }
  );

  it("rejects another plugin's panel as foreign rather than missing", () => {
    const broker = makeBroker();
    broker.ingest(7, [event({ panelKindId: "other.panel" })]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "foreign" });
  });

  it("judges ownership from the registry, not the renderer-claimed pluginId", () => {
    const broker = makeBroker();
    broker.ingest(7, [event({ panelKindId: "other.panel", pluginId: "acme" })]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "foreign" });
  });

  it("will not authorize from a remembered owner once the kind is unregistered", () => {
    const owners: Record<string, string | undefined> = { "acme.dash": "acme" };
    const broker = new PluginPanelLifecycleBroker((kindId) => owners[kindId]);
    broker.ingest(7, [event()]);
    owners["acme.dash"] = undefined;
    expect(broker.locate("p1", "acme")).toEqual({ kind: "unavailable" });
  });

  it("refuses to pick when two renderers both hold a view of the panel", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    broker.ingest(8, [event()]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "unavailable" });
  });

  it("prefers the renderer with the mounted view over one holding it hidden", () => {
    const broker = makeBroker();
    broker.ingest(7, [event({ phase: "hidden" })]);
    broker.ingest(8, [event()]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "located", sourceId: 8 });
  });

  it("names a reported non-plugin panel, and forgets it with its renderer", () => {
    const broker = makeBroker();
    broker.setNonPluginPanels(7, ["term-1", "", 42]);
    expect(broker.locate("term-1", "acme")).toEqual({ kind: "non-plugin" });
    broker.clearSource(7);
    expect(broker.locate("term-1", "acme")).toEqual({ kind: "missing" });
  });

  it("replaces a renderer's inventory wholesale", () => {
    const broker = makeBroker();
    broker.setNonPluginPanels(7, ["term-1"]);
    broker.setNonPluginPanels(7, ["term-2"]);
    expect(broker.locate("term-1", "acme")).toEqual({ kind: "missing" });
    expect(broker.locate("term-2", "acme")).toEqual({ kind: "non-plugin" });
  });

  it("reports an unknown id as missing and a removed panel as gone", () => {
    const broker = makeBroker();
    expect(broker.locate("nope", "acme")).toEqual({ kind: "missing" });
    broker.ingest(7, [event(), event({ phase: "removed" })]);
    expect(broker.locate("p1", "acme")).toEqual({ kind: "missing" });
  });
});

describe("pushTargetsFor", () => {
  let clock = 0;
  const makeBroker = (): PluginPanelLifecycleBroker =>
    new PluginPanelLifecycleBroker(
      (kindId) => OWNERS[kindId],
      () => clock
    );
  const pastGrace = (): void => {
    clock += 2_000;
  };

  it.each(["mounted", "hidden", "backgrounded", "trashed", "render-failed"] as const)(
    "counts a %s panel's renderer as a holder",
    (phase) => {
      const broker = makeBroker();
      broker.ingest(7, [event({ phase })]);
      expect(broker.pushTargetsFor("p1", "acme")).toEqual([7]);
    }
  );

  it("returns every renderer that holds the panel", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    broker.ingest(9, [event({ phase: "backgrounded" })]);
    expect([...(broker.pushTargetsFor("p1", "acme") as number[])].sort()).toEqual([7, 9]);
  });

  it("returns nothing for an unreported panel and 'closed' for a removed one", () => {
    const broker = makeBroker();
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([]);
    broker.ingest(7, [event(), event({ phase: "removed" })]);
    // A moving panel is removed from one renderer before the next reports it,
    // so right after `removed` it still reads as unreported.
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([]);
    pastGrace();
    expect(broker.pushTargetsFor("p1", "acme")).toBe("closed");
    // Closed is the owner's answer only; anyone else still sees "unknown".
    expect(broker.pushTargetsFor("p1", "other")).toEqual([]);
  });

  it("is not closed while another renderer still holds the panel", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    broker.ingest(9, [event()]);
    broker.ingest(7, [event({ phase: "removed" })]);
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([9]);
  });

  it("clears the closed mark when the id is reported live again", () => {
    const broker = makeBroker();
    broker.ingest(7, [event(), event({ phase: "removed" })]);
    broker.ingest(9, [event()]);
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([9]);
    broker.ingest(9, [event({ phase: "removed" })]);
    pastGrace();
    expect(broker.pushTargetsFor("p1", "acme")).toBe("closed");
  });

  it("keeps a bounded memory of closed panels", () => {
    const broker = makeBroker();
    for (let i = 0; i < 1100; i++) {
      broker.ingest(7, [
        event({ panelId: `x${i}` }),
        event({ panelId: `x${i}`, phase: "removed" }),
      ]);
    }
    pastGrace();
    expect(broker.pushTargetsFor("x0", "acme")).toEqual([]);
    expect(broker.pushTargetsFor("x1099", "acme")).toBe("closed");
  });

  it("does not treat an evicted renderer's panels as closed", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    broker.clearSource(7);
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([]);
  });

  it("returns nothing when ownership is in doubt", () => {
    const owners: Record<string, string | undefined> = { "acme.dash": "acme" };
    const broker = new PluginPanelLifecycleBroker((kindId) => owners[kindId]);
    broker.ingest(7, [event()]);
    expect(broker.pushTargetsFor("p1", "other")).toEqual([]);
    owners["acme.dash"] = undefined;
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([]);
  });

  it("forgets a cleared renderer", () => {
    const broker = makeBroker();
    broker.ingest(7, [event()]);
    broker.clearSource(7);
    expect(broker.pushTargetsFor("p1", "acme")).toEqual([]);
  });
});
