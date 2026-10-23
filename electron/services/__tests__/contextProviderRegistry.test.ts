import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arbitrateContextProviders,
  clearContextProviderImplRegistry,
  clearContextProviderRegistry,
  getContextProviderImpl,
  getRegisteredContextProviders,
  registerContextProviderImpl,
  registerContextProviders,
  unregisterContextProviderImpl,
  unregisterContextProviderImpls,
  unregisterContextProviders,
} from "../contextProviderRegistry.js";
import type { ContextProviderImpl } from "../../../shared/types/pluginContextProvider.js";

const PROJECT_PLUGIN = "project__p1__acme.notes";

function impl(): ContextProviderImpl {
  return { search: vi.fn(async () => []), resolve: vi.fn(async () => null) };
}

afterEach(() => {
  clearContextProviderRegistry();
  clearContextProviderImplRegistry();
  vi.restoreAllMocks();
});

describe("contextProviderRegistry (#13795)", () => {
  it("lists providers in registration order and drops a plugin on unregister", () => {
    registerContextProviders("acme.kanban", "Kanban", [
      { id: "cards", prefix: "card", label: "Cards" },
    ]);
    registerContextProviders("acme.wiki", "Wiki", [
      { id: "pages", prefix: "page", label: "Pages" },
    ]);
    expect(getRegisteredContextProviders().map((p) => p.pluginId)).toEqual([
      "acme.kanban",
      "acme.wiki",
    ]);
    unregisterContextProviders("acme.kanban");
    expect(getRegisteredContextProviders().map((p) => p.pluginId)).toEqual(["acme.wiki"]);
  });

  it("warns when a later plugin will be refused a prefix it can share a project with", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerContextProviders("acme.kanban", "Kanban", [{ id: "a", prefix: "rec", label: "A" }]);
    registerContextProviders("project__p2__x", "X", [{ id: "b", prefix: "rec", label: "B" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"@rec:"');

    warn.mockClear();
    registerContextProviders("project__p1__y", "Y", [{ id: "c", prefix: "doc", label: "C" }]);
    registerContextProviders("project__p3__z", "Z", [{ id: "d", prefix: "doc", label: "D" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("unbinds only the impl a disposer was handed", () => {
    const first = impl();
    const second = impl();
    registerContextProviderImpl("acme.kanban", "cards", first);
    registerContextProviderImpl("acme.kanban", "cards", second);
    unregisterContextProviderImpl("acme.kanban", "cards", first);
    expect(getContextProviderImpl("acme.kanban", "cards")).toBe(second);
    unregisterContextProviderImpls("acme.kanban");
    expect(getContextProviderImpl("acme.kanban", "cards")).toBeUndefined();
  });
});

describe("arbitrateContextProviders", () => {
  const visible = [
    {
      pluginId: "acme.kanban",
      pluginName: "Kanban",
      contribution: { id: "a", prefix: "rec", label: "Cards" },
    },
    {
      pluginId: PROJECT_PLUGIN,
      pluginName: "Notes",
      contribution: { id: "b", prefix: "rec", label: "Notes" },
    },
    {
      pluginId: PROJECT_PLUGIN,
      pluginName: "Notes",
      contribution: { id: "c", prefix: "note", label: "Notes" },
    },
  ];

  it("gives a prefix to its first claimant and refuses the later one, naming the holder", () => {
    const entries = arbitrateContextProviders(visible, () => false);
    expect(entries.map((e) => [e.pluginId, e.prefix, e.status, e.scope])).toEqual([
      ["acme.kanban", "rec", "active", "global"],
      [PROJECT_PLUGIN, "rec", "refused", "project"],
      [PROJECT_PLUGIN, "note", "active", "project"],
    ]);
    expect(entries[1]!.heldBy).toEqual({ pluginId: "acme.kanban", pluginName: "Kanban" });
  });

  it("hands the prefix on when its holder is switched off", () => {
    const entries = arbitrateContextProviders(visible, (id) => id === "acme.kanban");
    expect(entries.map((e) => e.status)).toEqual(["off", "active", "active"]);
    expect(entries[1]!.heldBy).toBeUndefined();
  });
});
