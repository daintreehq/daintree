import { describe, expect, it } from "vitest";

import { parsePluginCatalog, type PluginCatalog } from "../pluginCatalogSchema.js";
import {
  CATALOG_WITH_MALFORMED_ENTRY,
  DIGEST_A,
  VALID_CATALOG,
  catalogEntry,
} from "./pluginCatalogFixtures.js";

const ASSET_URL =
  "https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.1/daintreehq.continue-session-0.1.1.dntr";

function parseOk(raw: unknown): PluginCatalog {
  const result = parsePluginCatalog(raw);
  if (!result.ok) throw new Error(`expected a valid catalog: ${result.error}`);
  return result.catalog;
}

function rejects(entry: Record<string, unknown>): boolean {
  return !parsePluginCatalog({ entries: [entry] }).ok;
}

describe("parsePluginCatalog", () => {
  it("keeps every reviewed release of a plugin, not just the latest", () => {
    const catalog = parseOk(VALID_CATALOG);
    expect(catalog.entries.map((e) => `${e.id}@${e.version}`)).toEqual([
      "daintreehq.continue-session@0.1.0",
      "daintreehq.continue-session@0.1.1",
      "acme.linear-context@2.0.0-rc.1+build.7",
    ]);
  });

  it("accepts an empty catalog", () => {
    expect(parseOk({ entries: [] }).entries).toEqual([]);
  });

  it("drops unknown fields and lowercases the digest", () => {
    const [entry] = parseOk({
      entries: [catalogEntry({ sha256: DIGEST_A.toUpperCase(), tagline: "extra" })],
      publishedAt: "2026-11-01",
    }).entries;
    expect(entry.sha256).toBe(DIGEST_A);
    expect(entry).not.toHaveProperty("tagline");
  });

  it("keeps capabilities this build doesn't know, since they grant nothing", () => {
    const [entry] = parseOk({
      entries: [catalogEntry({ capabilities: ["future:capability"] })],
    }).entries;
    expect(entry.capabilities).toEqual(["future:capability"]);
  });

  it("hands back a frozen catalog", () => {
    const catalog = parseOk(VALID_CATALOG);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    expect(Object.isFrozen(catalog.entries[0])).toBe(true);
    expect(Object.isFrozen(catalog.entries[0].capabilities)).toBe(true);
  });

  it.each([
    ["a null document", null],
    ["an array document", [catalogEntry()]],
    ["a document without entries", {}],
    ["entries that aren't an array", { entries: catalogEntry() }],
  ])("refuses %s", (_label, raw) => {
    expect(parsePluginCatalog(raw).ok).toBe(false);
  });

  it("refuses the whole document when one entry is malformed", () => {
    const result = parsePluginCatalog(CATALOG_WITH_MALFORMED_ENTRY);
    expect(result.ok).toBe(false);
  });

  it("refuses a repeated (id, version), whether the copies agree or not", () => {
    expect(parsePluginCatalog({ entries: [catalogEntry(), catalogEntry()] }).ok).toBe(false);
    expect(
      parsePluginCatalog({ entries: [catalogEntry(), catalogEntry({ sha256: DIGEST_A })] }).ok
    ).toBe(false);
  });

  describe("id", () => {
    it.each([
      ["unscoped", "continue-session"],
      ["uppercase", "Daintreehq.continue-session"],
      ["in the reserved daintree.* namespace", "daintree.continue-session"],
      ["longer than a manifest name may be", `acme.${"x".repeat(60)}`],
      ["not a string", 42],
    ])("refuses an id that is %s", (_label, id) => {
      expect(rejects(catalogEntry({ id }))).toBe(true);
    });
  });

  describe("version", () => {
    it.each([
      ["a leading v", "v0.1.1"],
      ["surrounding space", " 0.1.1"],
      ["a partial version", "0.1"],
      ["a range", "^0.1.1"],
      ["a dist tag", "latest"],
    ])("refuses a version with %s", (_label, version) => {
      expect(rejects(catalogEntry({ version }))).toBe(true);
    });
  });

  describe("repo", () => {
    it.each([
      ["over http", "http://github.com/daintreehq/plugin-continue-session"],
      ["on another host", "https://gitlab.com/daintreehq/plugin-continue-session"],
      ["with a trailing slash", "https://github.com/daintreehq/plugin-continue-session/"],
      ["naming only an owner", "https://github.com/daintreehq"],
      ["with a deeper path", "https://github.com/daintreehq/plugin-continue-session/tree/main"],
    ])("refuses a repo %s", (_label, repo) => {
      expect(rejects(catalogEntry({ repo }))).toBe(true);
    });
  });

  describe("url", () => {
    it("matches the repo case-insensitively, as GitHub does", () => {
      expect(rejects(catalogEntry({ url: ASSET_URL.replace("daintreehq/", "DaintreeHQ/") }))).toBe(
        false
      );
    });

    it.each([
      [
        "a latest/download redirect",
        "https://github.com/daintreehq/plugin-continue-session/releases/latest/download/daintreehq.continue-session.dntr",
      ],
      [
        "a tag named latest",
        "https://github.com/daintreehq/plugin-continue-session/releases/download/latest/daintreehq.continue-session.dntr",
      ],
      ["plain http", ASSET_URL.replace("https:", "http:")],
      [
        "another repository",
        ASSET_URL.replace("plugin-continue-session/releases", "other/releases"),
      ],
      ["another host", ASSET_URL.replace("github.com", "objects.githubusercontent.com")],
      ["an explicit default port", ASSET_URL.replace("github.com", "github.com:443")],
      ["a query", `${ASSET_URL}?raw=1`],
      ["an empty query", `${ASSET_URL}?`],
      ["a fragment", `${ASSET_URL}#x`],
      ["credentials", ASSET_URL.replace("https://", "https://user:pass@")],
      ["a dot segment", ASSET_URL.replace("/releases/", "/x/../releases/")],
      ["a backslash", ASSET_URL.replace("/releases/", "\\releases/")],
      ["an uppercase host", ASSET_URL.replace("github.com", "GitHub.com")],
      ["an asset that isn't a .dntr", ASSET_URL.replace(/\.dntr$/, ".zip")],
      ["a bare .dntr asset name", ASSET_URL.replace(/[^/]+\.dntr$/, ".dntr")],
      [
        "no asset",
        "https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.1/",
      ],
    ])("refuses a url with %s", (_label, url) => {
      expect(rejects(catalogEntry({ url }))).toBe(true);
    });
  });

  describe("sha256", () => {
    it.each([
      ["too short", "a".repeat(63)],
      ["too long", "a".repeat(65)],
      ["not hex", "g".repeat(64)],
      ["missing", undefined],
    ])("refuses a digest that is %s", (_label, sha256) => {
      expect(rejects(catalogEntry({ sha256 }))).toBe(true);
    });
  });

  describe("capabilities", () => {
    it.each([
      ["missing", undefined],
      ["not an array", "mcp:expose"],
      ["repeated", ["mcp:expose", "mcp:expose"]],
      ["empty strings", [""]],
      ["control characters", ["mcp:expose\u0007"]],
    ])("refuses capabilities that are %s", (_label, capabilities) => {
      expect(rejects(catalogEntry({ capabilities }))).toBe(true);
    });
  });
});
