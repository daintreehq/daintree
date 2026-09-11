import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ plugins: {} as Record<string, unknown> }));
vi.mock("../../../store.js", () => ({
  store: {
    get: () => persistence.plugins,
    set: (_key: string, value: Record<string, unknown>) => {
      persistence.plugins = value;
    },
  },
}));

import { PluginInstalledRecordsStore } from "../PluginInstalledRecordsStore.js";

beforeEach(() => {
  persistence.plugins = { disabled: [], auditEnabled: true };
});

describe("opt-in built-in plugins", () => {
  it("keeps Markdown editing off for existing preferences with no explicit choice", () => {
    const records = new PluginInstalledRecordsStore();
    expect(records.getDisabledIds().has("daintree.markdown-editor")).toBe(true);
    expect(records.getDisabledIds().has("daintree.github")).toBe(false);
  });

  it("remembers enabling across store instances, then respects disabling again", () => {
    new PluginInstalledRecordsStore().setEnabled("daintree.markdown-editor", true);
    const restarted = new PluginInstalledRecordsStore();
    expect(restarted.getDisabledIds().has("daintree.markdown-editor")).toBe(false);
    restarted.setEnabled("daintree.markdown-editor", false);
    expect(new PluginInstalledRecordsStore().getDisabledIds().has("daintree.markdown-editor")).toBe(
      true
    );
    expect(persistence.plugins.auditEnabled).toBe(true);
  });

  it("doesn't let enabling an unrelated plugin activate Markdown editing", () => {
    const records = new PluginInstalledRecordsStore();
    records.setEnabled("acme.other", true);
    expect(records.getDisabledIds().has("daintree.markdown-editor")).toBe(true);
  });
});
