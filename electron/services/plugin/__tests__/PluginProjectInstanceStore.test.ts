import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      state.set(key, structuredClone(value));
    }),
    _state: state,
  };
});
vi.mock("../../../store.js", () => ({ store: storeMock }));

import { PluginProjectInstanceStore } from "../PluginProjectInstanceStore.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

beforeEach(() => {
  storeMock._state.clear();
  vi.clearAllMocks();
});

describe("PluginProjectInstanceStore", () => {
  it("treats a missing or malformed key as no enablement", () => {
    const store = new PluginProjectInstanceStore();
    expect(store.listForProject(A)).toEqual([]);
    storeMock._state.set("pluginProjectInstances", [1, 2]);
    expect(store.listForPackage("acme.ledger")).toEqual([]);
    storeMock._state.set("pluginProjectInstances", { [A]: "nope", [B]: ["acme.ledger", 3, ""] });
    expect(store.listForProject(A)).toEqual([]);
    expect(store.listForProject(B)).toEqual(["acme.ledger"]);
  });

  it("enables per project without touching other projects", () => {
    const store = new PluginProjectInstanceStore();
    store.setEnabled(A, "acme.ledger", true);
    store.setEnabled(A, "acme.ledger", true);
    store.setEnabled(B, "acme.other", true);

    expect(store.listForProject(A)).toEqual(["acme.ledger"]);
    expect(store.isEnabled(B, "acme.ledger")).toBe(false);

    store.setEnabled(A, "acme.ledger", false);
    expect(store.listForProject(A)).toEqual([]);
    expect(store.listForProject(B)).toEqual(["acme.other"]);
  });

  it("removes a package everywhere and reports where it was", () => {
    const store = new PluginProjectInstanceStore();
    store.setEnabled(A, "acme.ledger", true);
    store.setEnabled(B, "acme.ledger", true);
    store.setEnabled(B, "acme.other", true);

    expect(store.removePackage("acme.ledger").sort()).toEqual([A, B]);
    expect(store.listForPackage("acme.ledger")).toEqual([]);
    expect(store.listForProject(B)).toEqual(["acme.other"]);
  });

  it("propagates a persistence failure so enabling cannot half-apply", () => {
    storeMock.set.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => new PluginProjectInstanceStore().setEnabled(A, "acme.ledger", true)).toThrow(
      "disk full"
    );
  });
});
