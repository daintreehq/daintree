import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  addPluginCatalogSource,
  getPluginCatalogSources,
  isAddedPluginCatalogSource,
  removePluginCatalogSource,
} from "../pluginCatalogSources.js";
import {
  canonicalCatalogSourceUrl,
  catalogSourceOf,
  installedCatalogOf,
  replacedCatalogOf,
} from "../pluginCatalogSourceUrl.js";
import {
  PLUGIN_CATALOG_SOURCES_MAX,
  PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH,
  PLUGIN_CATALOG_URL,
} from "../../../../shared/config/pluginCatalog.js";
import type { InstalledPluginRecord } from "../../../../shared/types/plugin.js";

const SOURCE = "https://plugins.example.org/catalog.json";

describe("catalog source URLs (#17434)", () => {
  it("gives every spelling of one catalog the same URL", () => {
    for (const spelling of [
      SOURCE,
      `  ${SOURCE}  `,
      "https://PLUGINS.Example.ORG/catalog.json",
      "https://plugins.example.org:443/catalog.json",
      "https://plugins.example.org./catalog.json",
      "https://plugins.example.org/x/../catalog.json",
      `${SOURCE}#top`,
    ]) {
      expect(canonicalCatalogSourceUrl(spelling)).toEqual({ ok: true, url: SOURCE });
    }
  });

  it("keeps what can name a different catalog on the same site", () => {
    const urls = [
      "https://plugins.example.org/Catalog.json",
      "https://plugins.example.org/catalog.json?list=rust",
      "https://plugins.example.org:8443/catalog.json",
    ].map((raw) => canonicalCatalogSourceUrl(raw));
    expect(urls.every((result) => result.ok)).toBe(true);
    expect(new Set(urls.map((result) => (result.ok ? result.url : ""))).size).toBe(3);
    expect(urls.some((result) => result.ok && result.url === SOURCE)).toBe(false);
  });

  it.each([
    ["plain http", "http://plugins.example.org/catalog.json", "insecure"],
    ["another scheme", "file:///etc/catalog.json", "malformed"],
    ["not a URL", "plugins.example.org/catalog.json", "malformed"],
    ["an empty value", "   ", "malformed"],
    ["a control character", "https://plugins.example.org/cat\talog.json", "malformed"],
    ["credentials", "https://user:pass@plugins.example.org/catalog.json", "credentials"],
    ["loopback", "https://127.0.0.1/catalog.json", "private-host"],
    ["localhost", "https://localhost./catalog.json", "private-host"],
    ["a private network", "https://192.168.1.2/catalog.json", "private-host"],
    ["IPv6 loopback", "https://[::1]/catalog.json", "private-host"],
    [
      "an overlong URL",
      `https://plugins.example.org/${"a".repeat(PLUGIN_CATALOG_SOURCE_URL_MAX_LENGTH)}`,
      "too-long",
    ],
    ["Daintree's own catalog", PLUGIN_CATALOG_URL, "builtin"],
    [
      "Daintree's own catalog, spelled otherwise",
      `${PLUGIN_CATALOG_URL.replace("https://updates.", "https://UPDATES.").replace(".org/", ".org:443/")}#top`,
      "builtin",
    ],
    ["a number", 42, "malformed"],
  ])("refuses %s", (_, raw, reason) => {
    expect(canonicalCatalogSourceUrl(raw)).toEqual({ ok: false, reason });
  });

  it("reads a named catalog as Daintree's own only when it is, and never a malformed one", () => {
    expect(catalogSourceOf(undefined)).toBeUndefined();
    expect(catalogSourceOf(PLUGIN_CATALOG_URL)).toBeUndefined();
    expect(catalogSourceOf(`${SOURCE}#x`)).toBe(SOURCE);
    expect(catalogSourceOf("http://plugins.example.org/catalog.json")).toBeNull();
    expect(catalogSourceOf(null)).toBeNull();
  });

  it("reads an install record's catalog, with no field meaning Daintree's own", () => {
    const record = (overrides: Partial<InstalledPluginRecord>) =>
      ({
        source: "catalog",
        catalog: { id: "a.b", version: "1.0.0", repo: "r" },
        ...overrides,
      }) as InstalledPluginRecord;
    expect(installedCatalogOf(record({}))).toEqual({});
    expect(
      installedCatalogOf(
        record({ catalog: { id: "a.b", version: "1.0.0", repo: "r", sourceUrl: SOURCE } })
      )
    ).toEqual({ sourceUrl: SOURCE });
    expect(installedCatalogOf(record({ source: "url" }))).toBeNull();
    expect(installedCatalogOf(undefined)).toBeNull();

    expect(replacedCatalogOf({}, SOURCE)).toEqual({});
    expect(replacedCatalogOf({ sourceUrl: SOURCE }, SOURCE)).toBeNull();
    expect(replacedCatalogOf({ sourceUrl: SOURCE }, undefined)).toEqual({ sourceUrl: SOURCE });
    expect(replacedCatalogOf(null, SOURCE)).toBeNull();
  });
});

describe("the person's catalog list (#17434)", () => {
  beforeEach(() => {
    storeMock.data.clear();
    storeMock.set.mockClear();
  });

  it("adds a catalog once, in its canonical spelling, after the ones already there", () => {
    const first = "https://a.example.com/catalog.json";
    expect(addPluginCatalogSource(first)).toEqual({
      status: "added",
      sourceUrl: first,
      sources: [first],
    });
    expect(addPluginCatalogSource("https://PLUGINS.example.org/catalog.json#x")).toEqual({
      status: "added",
      sourceUrl: SOURCE,
      sources: [first, SOURCE],
    });
    expect(addPluginCatalogSource(`${SOURCE} `)).toEqual({
      status: "refused",
      reason: "duplicate",
      sources: [first, SOURCE],
    });
    expect(isAddedPluginCatalogSource(SOURCE)).toBe(true);
  });

  it("refuses an address it couldn't fetch safely, and writes nothing", () => {
    expect(addPluginCatalogSource("http://plugins.example.org/catalog.json")).toEqual({
      status: "refused",
      reason: "insecure",
      sources: [],
    });
    expect(addPluginCatalogSource(PLUGIN_CATALOG_URL)).toMatchObject({ reason: "builtin" });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("holds the list to its limit", () => {
    for (let i = 0; i < PLUGIN_CATALOG_SOURCES_MAX; i++) {
      expect(addPluginCatalogSource(`https://c${i}.example.com/catalog.json`).status).toBe("added");
    }
    expect(addPluginCatalogSource(SOURCE)).toMatchObject({ status: "refused", reason: "too-many" });
    expect(getPluginCatalogSources()).toHaveLength(PLUGIN_CATALOG_SOURCES_MAX);
  });

  it("removes a catalog by any spelling, and leaves the list alone for one it doesn't hold", () => {
    addPluginCatalogSource(SOURCE);
    storeMock.set.mockClear();
    expect(removePluginCatalogSource("https://example.com/none.json")).toEqual([SOURCE]);
    expect(storeMock.set).not.toHaveBeenCalled();
    expect(removePluginCatalogSource("https://plugins.example.org:443/catalog.json")).toEqual([]);
    expect(isAddedPluginCatalogSource(SOURCE)).toBe(false);
  });

  it("checks a hand-edited list on every read, so nothing malformed can be fetched", () => {
    storeMock.data.set("pluginCatalogSources", [
      "http://insecure.example.com/catalog.json",
      "https://10.0.0.1/catalog.json",
      PLUGIN_CATALOG_URL,
      SOURCE,
      `${SOURCE}#again`,
      17,
    ]);
    expect(getPluginCatalogSources()).toEqual([SOURCE]);
    storeMock.data.set("pluginCatalogSources", "not a list");
    expect(getPluginCatalogSources()).toEqual([]);
  });
});
