import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The service module statically imports the electron-store-backed `store` for
// its singleton factory. These tests exercise the class directly with injected
// callbacks, so stub `store` to keep the unit test hermetic (no electron).
vi.mock("../../store.js", () => ({
  store: { get: vi.fn(() => ({})), set: vi.fn() },
}));

import { events, type DaintreeEventMap } from "../events.js";
import { PluginActionAuditService } from "../PluginActionAuditService.js";

/** In-memory stand-in for the `plugins` store slice. */
function makeConfigStore(initial: Record<string, unknown> = {}) {
  let config: Record<string, unknown> = { auditEnabled: true, auditMaxRecords: 500, ...initial };
  return {
    saveConfig: (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    },
    readConfig: () => config,
    raw: () => config,
  };
}

function emitDispatch(overrides: Partial<DaintreeEventMap["action:dispatched"]> = {}): void {
  events.emit("action:dispatched", {
    actionId: "plugin.foo.bar",
    source: "user",
    context: {},
    timestamp: Date.now(),
    category: "plugin",
    durationMs: 3,
    danger: "safe",
    ...overrides,
  });
}

describe("PluginActionAuditService", () => {
  let store: ReturnType<typeof makeConfigStore>;
  let service: PluginActionAuditService;

  beforeEach(() => {
    store = makeConfigStore();
    service = new PluginActionAuditService(store.saveConfig, store.readConfig);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it("starts empty", () => {
    expect(service.getRecords()).toEqual([]);
  });

  it("appends a record with the expected shape", () => {
    service.append({
      pluginId: "acme.plugin",
      actionId: "acme.do-thing",
      source: "user",
      danger: "safe",
      argsHash: "a".repeat(64),
      durationMs: 12,
      result: "success",
    });
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pluginId: "acme.plugin",
      actionId: "acme.do-thing",
      source: "user",
      danger: "safe",
      argsHash: "a".repeat(64),
      durationMs: 12,
      result: "success",
      schemaVersion: 1,
    });
    expect(typeof records[0]!.id).toBe("string");
    expect(typeof records[0]!.ts).toBe("number");
  });

  it("does not append when auditEnabled is false", () => {
    store.saveConfig({ auditEnabled: false });
    service.append({
      pluginId: "acme.plugin",
      actionId: "acme.do-thing",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    expect(service.getRecords()).toEqual([]);
  });

  it("trims to the configured max records (oldest evicted)", () => {
    store.saveConfig({ auditMaxRecords: 50 });
    for (let i = 0; i < 60; i++) {
      service.append({
        pluginId: "acme.plugin",
        actionId: `acme.action-${i}`,
        source: "user",
        danger: "safe",
        argsHash: "",
        durationMs: 1,
        result: "success",
      });
    }
    const records = service.getRecords();
    expect(records).toHaveLength(50);
    // Newest-first: the most recent dispatch is first; oldest 10 evicted.
    expect(records[0]!.actionId).toBe("acme.action-59");
    expect(records.at(-1)!.actionId).toBe("acme.action-10");
  });

  it("returns records newest-first", () => {
    service.append({
      pluginId: "p",
      actionId: "first",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    service.append({
      pluginId: "p",
      actionId: "second",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    const records = service.getRecords();
    expect(records.map((r) => r.actionId)).toEqual(["second", "first"]);
  });

  it("clear() empties the ring and persists", () => {
    service.append({
      pluginId: "p",
      actionId: "x",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    service.clear();
    expect(service.getRecords()).toEqual([]);
    expect(store.raw().auditLog).toEqual([]);
  });

  it("setEnabled / setMaxRecords return and persist config", () => {
    expect(service.setEnabled(false)).toEqual({ enabled: false, maxRecords: 500 });
    expect(store.raw().auditEnabled).toBe(false);
    expect(service.setMaxRecords(100)).toMatchObject({ maxRecords: 100 });
    expect(store.raw().auditMaxRecords).toBe(100);
  });

  it("clamps maxRecords to the allowed range", () => {
    expect(service.setMaxRecords(1).maxRecords).toBe(50);
    expect(service.setMaxRecords(999_999).maxRecords).toBe(5000);
  });

  it("flushes to the store after the debounce window (oldest-first)", () => {
    vi.useFakeTimers();
    const svc = new PluginActionAuditService(store.saveConfig, store.readConfig);
    svc.append({
      pluginId: "p",
      actionId: "first",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    svc.append({
      pluginId: "p",
      actionId: "second",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    expect(store.raw().auditLog).toBeUndefined();
    vi.advanceTimersByTime(1000);
    const persisted = store.raw().auditLog as Array<{ actionId: string }>;
    // Stored oldest-first (getRecords reverses for display).
    expect(persisted.map((r) => r.actionId)).toEqual(["first", "second"]);
    svc.dispose();
  });

  it("dispose() flushes pending records synchronously", () => {
    vi.useFakeTimers();
    const svc = new PluginActionAuditService(store.saveConfig, store.readConfig);
    svc.append({
      pluginId: "p",
      actionId: "x",
      source: "user",
      danger: "safe",
      argsHash: "",
      durationMs: 1,
      result: "success",
    });
    expect(store.raw().auditLog).toBeUndefined();
    svc.dispose(); // flushes without advancing the debounce timer
    expect((store.raw().auditLog as unknown[]).length).toBe(1);
  });

  it("hydrate rejects records missing string pluginId/actionId", () => {
    const seeded = makeConfigStore({
      auditLog: [
        { id: "ok", pluginId: "p", actionId: "a", ts: 1, schemaVersion: 1 },
        { id: "bad-plugin", pluginId: null, actionId: "a" },
        { id: "no-action", pluginId: "p" },
        { pluginId: "p", actionId: "a" }, // missing id
      ],
    });
    const svc = new PluginActionAuditService(seeded.saveConfig, seeded.readConfig);
    const records = svc.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("ok");
    svc.dispose();
  });

  it("hydrates persisted records on first read", () => {
    const seeded = makeConfigStore({
      auditLog: [
        {
          id: "seed-1",
          ts: 1,
          pluginId: "p",
          actionId: "seeded",
          source: "user",
          danger: "safe",
          argsHash: "",
          durationMs: 1,
          result: "success",
          schemaVersion: 1,
        },
      ],
    });
    const svc = new PluginActionAuditService(seeded.saveConfig, seeded.readConfig);
    const records = svc.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.actionId).toBe("seeded");
    svc.dispose();
  });

  it("exportRecords serializes as NDJSON", () => {
    const ndjson = service.exportRecords([
      {
        id: "1",
        ts: 1,
        pluginId: "p",
        actionId: "a",
        source: "user",
        danger: "safe",
        argsHash: "",
        durationMs: 1,
        result: "success",
        schemaVersion: 1,
      },
      {
        id: "2",
        ts: 2,
        pluginId: "p",
        actionId: "b",
        source: "user",
        danger: "safe",
        argsHash: "",
        durationMs: 1,
        result: "success",
        schemaVersion: 1,
      },
    ]);
    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).actionId).toBe("a");
    expect(JSON.parse(lines[1]!).actionId).toBe("b");
  });

  describe("bus integration", () => {
    it("records only plugin-contributed dispatches", () => {
      service.initialize({ isPlaintextEnabled: () => false });
      emitDispatch({ actionId: "builtin.action" }); // no pluginId — ignored
      emitDispatch({ actionId: "plugin.foo", pluginId: "foo", argsHash: "b".repeat(64) });
      const records = service.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        pluginId: "foo",
        actionId: "plugin.foo",
        argsHash: "b".repeat(64),
        result: "success",
      });
    });

    it("persists plaintext args only when the developer opts in", () => {
      let plaintext = false;
      service.initialize({ isPlaintextEnabled: () => plaintext });

      emitDispatch({ pluginId: "foo", args: { name: "value" } });
      expect(service.getRecords()[0]!.argsPlaintext).toBeUndefined();

      plaintext = true;
      emitDispatch({ pluginId: "foo", actionId: "plugin.foo2", args: { name: "value" } });
      const newest = service.getRecords()[0]!;
      expect(newest.actionId).toBe("plugin.foo2");
      expect(newest.argsPlaintext).toBe(JSON.stringify({ name: "value" }));
    });
  });
});
