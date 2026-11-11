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
    expect(catalog).toEqual(VALID_CATALOG);
  });

  it("lets different plugins list the same version", () => {
    const other = catalogEntry({
      id: "acme.other",
      repo: "https://github.com/acme/other",
      url: "https://github.com/acme/other/releases/download/v0.1.1/acme.other-0.1.1.dntr",
    });
    expect(parseOk({ entries: [catalogEntry(), other] }).entries).toHaveLength(2);
  });

  it("accepts an empty catalog", () => {
    expect(parseOk({ entries: [] }).entries).toEqual([]);
  });

  it("drops unknown fields and lowercases the digest", () => {
    const catalog = parseOk({
      entries: [catalogEntry({ sha256: DIGEST_A.toUpperCase(), tagline: "extra" })],
      publishedAt: "2026-11-01",
    });
    const [entry] = catalog.entries;
    expect(entry.sha256).toBe(DIGEST_A);
    expect(entry).not.toHaveProperty("tagline");
    expect(catalog).not.toHaveProperty("publishedAt");
  });

  it("keeps capabilities this build doesn't know, since they grant nothing", () => {
    const [entry] = parseOk({
      entries: [catalogEntry({ capabilities: ["future:capability"] })],
    }).entries;
    expect(entry.capabilities).toEqual(["future:capability"]);
  });

  it("hands back a frozen catalog", () => {
    const catalog = parseOk(VALID_CATALOG);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.entries)).toBe(true);
    for (const entry of catalog.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.capabilities)).toBe(true);
    }
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
    it("accepts an id as long as a manifest name may be", () => {
      expect(rejects(catalogEntry({ id: `acme.${"x".repeat(59)}` }))).toBe(false);
    });

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
      ["that isn't a URL", "daintreehq/plugin-continue-session"],
    ])("refuses a repo %s", (_label, repo) => {
      expect(rejects(catalogEntry({ repo }))).toBe(true);
    });

    it("refuses a repo name GitHub doesn't allow, even when the url agrees with it", () => {
      const repo = "https://github.com/daintreehq/plugin%20session";
      const url = `${repo}/releases/download/v0.1.1/daintreehq.continue-session-0.1.1.dntr`;
      expect(rejects(catalogEntry({ repo, url }))).toBe(true);
    });
  });

  describe("url", () => {
    it("matches the repo's owner and name case-insensitively, as GitHub does", () => {
      const url = ASSET_URL.replace(
        "daintreehq/plugin-continue-session/",
        "DaintreeHQ/Plugin-Continue-Session/"
      );
      expect(rejects(catalogEntry({ url }))).toBe(false);
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
        "a tag named latest in another case",
        "https://github.com/daintreehq/plugin-continue-session/releases/download/LaTeSt/daintreehq.continue-session.dntr",
      ],
      [
        "a percent-encoded latest tag",
        "https://github.com/daintreehq/plugin-continue-session/releases/download/%6catest/daintreehq.continue-session.dntr",
      ],
      [
        "a tag that doesn't percent-decode",
        "https://github.com/daintreehq/plugin-continue-session/releases/download/v%E0/daintreehq.continue-session.dntr",
      ],
      [
        "another repository",
        ASSET_URL.replace("plugin-continue-session/releases", "other/releases"),
      ],
      ["another owner", ASSET_URL.replace("github.com/daintreehq/", "github.com/acme/")],
      ["a path that isn't a release", ASSET_URL.replace("/releases/", "/archive/")],
      ["an extra path segment", `${ASSET_URL}/extra`],
      ["something that isn't a URL", "daintreehq.continue-session-0.1.1.dntr"],
      ["another host", ASSET_URL.replace("github.com", "objects.githubusercontent.com")],
      ["an explicit default port", ASSET_URL.replace("github.com", "github.com:443")],
      ["a query", `${ASSET_URL}?raw=1`],
      ["an empty query", `${ASSET_URL}?`],
      ["a fragment", `${ASSET_URL}#x`],
      ["an empty fragment", `${ASSET_URL}#`],
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
    it("accepts a capability name of 128 characters", () => {
      expect(rejects(catalogEntry({ capabilities: ["x".repeat(128)] }))).toBe(false);
    });

    it.each([
      ["missing", undefined],
      ["not an array", "mcp:expose"],
      ["repeated", ["mcp:expose", "mcp:expose"]],
      ["empty strings", [""]],
      ["control characters", ["mcp:expose\u0007"]],
      ["longer than 128 characters", ["x".repeat(129)]],
    ])("refuses capabilities that are %s", (_label, capabilities) => {
      expect(rejects(catalogEntry({ capabilities }))).toBe(true);
    });
  });
});
