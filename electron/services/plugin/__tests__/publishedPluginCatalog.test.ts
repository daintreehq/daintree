import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { PLUGIN_CATALOG_MAX_BYTES } from "../../../../shared/config/pluginCatalog.js";
import { parsePluginCatalog } from "../pluginCatalogSchema.js";

// The publish workflow runs this file against the develop tip before uploading
// `plugins/catalog.json`, so a catalog that fails here never reaches the update
// host. The download checks of each new entry run on the pull request
// (`scripts/ci/check-plugin-catalog.ts`).

const readText = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const readJson = (relative: string): unknown => JSON.parse(readText(relative));

const publishedText = readText("../../../../plugins/catalog.json");
const published: unknown = JSON.parse(publishedText);
const schema = readJson("../../../../plugins/catalog.schema.json") as object;
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** The production parser accepts the document and returns it unchanged. */
function parsesExactly(document: unknown): boolean {
  const result = parsePluginCatalog(document);
  return result.ok && isDeepStrictEqual(structuredClone(result.catalog), document);
}

const ENTRY = {
  id: "acme.widget",
  repo: "https://github.com/acme/widget-plugin",
  version: "1.2.3",
  url: "https://github.com/acme/widget-plugin/releases/download/v1.2.3/acme.widget-1.2.3.dntr",
  sha256: "a".repeat(64),
  capabilities: ["fs:user-data-read", "mcp:expose"],
};

const RELEASES = "https://github.com/acme/widget-plugin/releases";

// Entries on which the repository's JSON Schema and the app's parser must give
// the same verdict, so the schema can't drift from what clients accept.
const AGREEMENT: Array<[string, Record<string, unknown>, boolean]> = [
  ["the reference entry", ENTRY, true],
  ["no capabilities", { ...ENTRY, capabilities: [] }, true],
  ["a prerelease with build metadata", { ...ENTRY, version: "2.0.0-rc.1+build.5" }, true],
  ["a hyphenated id", { ...ENTRY, id: "acme-labs.widget-pro" }, true],
  ["a tag with an @", { ...ENTRY, url: `${RELEASES}/download/widget@1.2.3/widget.dntr` }, true],
  ["a percent-escaped tag", { ...ENTRY, url: `${RELEASES}/download/widget%401.2.3/w.dntr` }, true],
  ["a dot-dot tag", { ...ENTRY, url: `${RELEASES}/download/../widget.dntr` }, false],
  ["an escaped dot-dot tag", { ...ENTRY, url: `${RELEASES}/download/%2e%2E/widget.dntr` }, false],
  ["an unscoped id", { ...ENTRY, id: "widget" }, false],
  ["an id in daintree.*", { ...ENTRY, id: "daintree.widget" }, false],
  ["an uppercase id", { ...ENTRY, id: "Acme.widget" }, false],
  ["an id over 64 characters", { ...ENTRY, id: `acme.${"w".repeat(60)}` }, false],
  ["a leading v", { ...ENTRY, version: "v1.2.3" }, false],
  ["a two-part version", { ...ENTRY, version: "1.2" }, false],
  ["a zero-padded version", { ...ENTRY, version: "01.2.3" }, false],
  ["a repo that isn't GitHub", { ...ENTRY, repo: "https://gitlab.com/acme/widget-plugin" }, false],
  ["a repo with a trailing slash", { ...ENTRY, repo: `${ENTRY.repo}/` }, false],
  ["a repo over plain http", { ...ENTRY, repo: "http://github.com/acme/widget-plugin" }, false],
  ["a repo with a dot-dot segment", { ...ENTRY, repo: "https://github.com/acme/.." }, false],
  ["a latest/download url", { ...ENTRY, url: `${RELEASES}/latest/download/widget.dntr` }, false],
  ["a tag named latest", { ...ENTRY, url: `${RELEASES}/download/latest/widget.dntr` }, false],
  ["a tag named LATEST", { ...ENTRY, url: `${RELEASES}/download/LATEST/widget.dntr` }, false],
  ["a url that isn't a .dntr", { ...ENTRY, url: `${RELEASES}/download/v1.2.3/widget.zip` }, false],
  ["a url with a query", { ...ENTRY, url: `${ENTRY.url}?raw=1` }, false],
  [
    "a url with an extra segment",
    { ...ENTRY, url: `${RELEASES}/download/v1/x/widget.dntr` },
    false,
  ],
  ["an uppercase digest", { ...ENTRY, sha256: "A".repeat(64) }, false],
  ["a short digest", { ...ENTRY, sha256: "a".repeat(63) }, false],
  ["a repeated capability", { ...ENTRY, capabilities: ["mcp:expose", "mcp:expose"] }, false],
  ["an empty capability", { ...ENTRY, capabilities: [""] }, false],
  ["a capability with a control character", { ...ENTRY, capabilities: ["mcp:\u0007"] }, false],
  ["a missing field", { ...ENTRY, sha256: undefined }, false],
  ["an unknown field", { ...ENTRY, homepage: "https://example.com" }, false],
];

describe("published plugin catalog", () => {
  it("matches the catalog's JSON Schema", () => {
    expect(validateSchema(published), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it("fits under the size the client refuses to read", () => {
    expect(Buffer.byteLength(publishedText, "utf8")).toBeLessThanOrEqual(PLUGIN_CATALOG_MAX_BYTES);
  });

  it("parses with the production parser and loses nothing to it", () => {
    // The parser drops unknown keys and lowercases digests, so a misspelt
    // field would otherwise pass review and be silently dropped by every client.
    const parsed = parsePluginCatalog(published);
    expect(parsed.ok, parsed.ok ? undefined : parsed.error).toBe(true);
    expect(parsesExactly(published)).toBe(true);
  });
});

describe("catalog JSON Schema", () => {
  it.each(AGREEMENT)("agrees with the production parser on %s", (_label, entry, valid) => {
    const document = { entries: [JSON.parse(JSON.stringify(entry))] };
    expect(validateSchema(document), JSON.stringify(validateSchema.errors)).toBe(valid);
    expect(parsesExactly(document)).toBe(valid);
  });

  it("leaves the url-in-repo rule to the production parser, which refuses another repo", () => {
    // JSON Schema can't compare one field with another, so its description
    // names this rule and CI enforces it through the parser.
    const url = "https://github.com/evil/widget-plugin/releases/download/v1/widget.dntr";
    expect(parsePluginCatalog({ entries: [{ ...ENTRY, url }] }).ok).toBe(false);
    const sameRepoOtherCase = ENTRY.url.replace("acme/widget-plugin", "Acme/Widget-Plugin");
    expect(parsesExactly({ entries: [{ ...ENTRY, url: sameRepoOtherCase }] })).toBe(true);
  });

  it("leaves a percent-escaped latest tag and repeated releases to the production parser", () => {
    const escapedLatest = { ...ENTRY, url: `${RELEASES}/download/%6catest/widget.dntr` };
    expect(validateSchema({ entries: [escapedLatest] })).toBe(true);
    expect(parsePluginCatalog({ entries: [escapedLatest] }).ok).toBe(false);
    expect(validateSchema({ entries: [ENTRY, ENTRY] })).toBe(true);
    expect(parsePluginCatalog({ entries: [ENTRY, ENTRY] }).ok).toBe(false);
  });

  it("compares documents by structure, not key order", () => {
    const reordered = Object.fromEntries(Object.entries(ENTRY).reverse());
    expect(parsesExactly({ entries: [reordered] })).toBe(true);
  });

  it("refuses a document with any other top-level key", () => {
    expect(validateSchema({ entries: [], version: 1 })).toBe(false);
  });
});
