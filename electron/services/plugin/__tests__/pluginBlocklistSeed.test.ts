import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as semver from "semver";

import { PluginBlocklistSchema } from "../PluginBlocklistService.js";
import { PLUGIN_BLOCKLIST_SEED } from "../pluginBlocklistSeed.js";

// The publish workflow runs this file against the develop tip before uploading
// `plugins/blocklist.json`, so a list that fails here never reaches the update
// host, and the same file is what every release ships as its seed.

const PUBLISHED_FILE = fileURLToPath(new URL("../../../../plugins/blocklist.json", import.meta.url));
const published: unknown = JSON.parse(readFileSync(PUBLISHED_FILE, "utf8"));

describe("published plugin blocklist", () => {
  it("is what the release seed ships", () => {
    expect(PLUGIN_BLOCKLIST_SEED).toEqual(published);
  });

  it("parses with the production schema and loses nothing to it", () => {
    // The schema strips unknown keys, so a misspelt field (`mesage`) would
    // otherwise pass review and be silently dropped by every client.
    const parsed = PluginBlocklistSchema.safeParse(published);
    expect(parsed.success, parsed.error?.message).toBe(true);
    expect(parsed.data).toEqual(published);
  });

  it("names only valid semver ranges, so no denial is silently inert", () => {
    const { entries } = PluginBlocklistSchema.parse(published);
    for (const entry of entries) {
      for (const range of entry.ranges) {
        expect(
          semver.validRange(range, { includePrerelease: true }),
          `${entry.name}: "${range}"`
        ).not.toBeNull();
      }
    }
  });

  it("scopes no entry by jti, which no plugin carries yet", () => {
    // An entry with `jti` matches only a plugin presenting one of those ids,
    // so today it blocks nothing.
    const { entries } = PluginBlocklistSchema.parse(published);
    expect(entries.filter((entry) => entry.jti).map((entry) => entry.name)).toEqual([]);
  });
});
