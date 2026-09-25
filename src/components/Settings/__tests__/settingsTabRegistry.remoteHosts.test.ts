import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@/lib/remoteHosts");
  vi.resetModules();
});

async function loadWith(supported: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => supported }));
  const registry = await import("../settingsTabRegistry");
  const search = await import("../settingsSearchIndex");
  return { registry, search };
}

describe("Settings → Hosts registration", () => {
  it("registers the tab, its nav entry and its search entries where Remote Hosts exists", async () => {
    const { registry, search } = await loadWith(true);
    expect(registry.getSettingsTabEntry("hosts")).toMatchObject({
      label: "Hosts",
      scope: "global",
    });
    const navIds = registry
      .getSettingsNavGroups("global")
      .flatMap((g) => g.entries.map((e) => e.id));
    expect(navIds).toContain("hosts");
    expect(search.SETTINGS_SEARCH_INDEX.some((e) => e.tab === "hosts")).toBe(true);
  });

  it("leaves no trace of it where Remote Hosts is unsupported (Windows)", async () => {
    const { registry, search } = await loadWith(false);
    expect(registry.getSettingsTabEntry("hosts")).toBeUndefined();
    expect(registry.SETTINGS_REGISTRY.some((e) => e.id === "hosts")).toBe(false);
    const navIds = registry
      .getSettingsNavGroups("global")
      .flatMap((g) => g.entries.map((e) => e.id));
    expect(navIds).not.toContain("hosts");
    expect(search.SETTINGS_SEARCH_INDEX.some((e) => e.tab === "hosts")).toBe(false);
  });
});
