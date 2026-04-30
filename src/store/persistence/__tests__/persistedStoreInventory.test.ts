// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  _resetPersistedStoreRegistryForTests,
  listPersistedStores,
} from "../persistedStoreRegistry";

/**
 * Regression guard: importing the store barrel must populate the registry with
 * every persisted Zustand store. If someone deletes a `registerPersistedStore`
 * call (or adds a new persisted store without one), this test fails and the
 * new `actions.persistedStores` diagnostic silently drops the missing entry.
 */

const EXPECTED_STORE_IDS = [
  "worktreeFilterStore",
  "commandHistoryStore",
  "helpPanelStore",
  "portalStore",
  "twoPaneSplitStore",
  "preferencesStore",
  "panelLimitStore",
  "agentPreferencesStore",
  "toolbarPreferencesStore",
  "projectStore",
  "urlHistoryStore",
] as const;

const EXPECTED_STORAGE_KEYS: Record<(typeof EXPECTED_STORE_IDS)[number], string> = {
  worktreeFilterStore: "daintree-worktree-filters",
  commandHistoryStore: "daintree-command-history",
  helpPanelStore: "help-panel-storage",
  portalStore: "portal-storage",
  twoPaneSplitStore: "daintree-two-pane-split",
  preferencesStore: "daintree-preferences",
  panelLimitStore: "daintree-panel-limits",
  agentPreferencesStore: "daintree-agent-preferences",
  toolbarPreferencesStore: "daintree-toolbar-preferences",
  projectStore: "project-storage",
  urlHistoryStore: "daintree-url-history",
};

beforeAll(async () => {
  _resetPersistedStoreRegistryForTests();

  await Promise.all([
    import("../../worktreeFilterStore"),
    import("../../commandHistoryStore"),
    import("../../helpPanelStore"),
    import("../../portalStore"),
    import("../../twoPaneSplitStore"),
    import("../../preferencesStore"),
    import("../../panelLimitStore"),
    import("../../agentPreferencesStore"),
    import("../../toolbarPreferencesStore"),
    import("../../projectStore"),
    import("../../urlHistoryStore"),
  ]);
});

afterAll(() => {
  _resetPersistedStoreRegistryForTests();
});

describe("persisted store inventory", () => {
  it("registers every known persisted store", () => {
    const registeredIds = listPersistedStores()
      .map((r) => r.storeId)
      .sort();
    const expected = [...EXPECTED_STORE_IDS].sort();
    expect(registeredIds).toEqual(expected);
  });

  it("exposes each store's localStorage key through persist.getOptions()", () => {
    const entries = listPersistedStores();
    for (const storeId of EXPECTED_STORE_IDS) {
      const entry = entries.find((r) => r.storeId === storeId);
      expect(entry, `missing registration for ${storeId}`).toBeDefined();
      expect(entry!.store.persist.getOptions().name).toBe(EXPECTED_STORAGE_KEYS[storeId]);
    }
  });

  it("preserves .persist.getOptions() for stores wrapped in additional middleware", () => {
    // projectStore nests persist inside subscribeWithSelector. This test fails
    // if middleware composition ever drops the persist mutator surface.
    const entry = listPersistedStores().find((r) => r.storeId === "projectStore");
    expect(entry).toBeDefined();
    expect(typeof entry!.store.persist.getOptions).toBe("function");
    const options = entry!.store.persist.getOptions();
    expect(options.name).toBe("project-storage");
    expect(typeof options.merge).toBe("function");
    expect(typeof options.partialize).toBe("function");
  });
});
