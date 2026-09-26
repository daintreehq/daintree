import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../../../../../shared/types/plugin.js";
import { pluginInstallRefusal, replacementRefusal } from "../preflight.js";

function manifest(patch: Record<string, unknown> = {}): PluginManifest {
  return { name: "acme.graph", version: "1.2.0", ...patch } as unknown as PluginManifest;
}

const blocklist = {
  entries: [
    { name: "acme.graph", ranges: ["<1.3.0"], reason: "compromised", message: "Leaked key" },
  ],
};

describe("pluginInstallRefusal", () => {
  it("refuses a package with no build for this OS", () => {
    expect(
      pluginInstallRefusal(manifest({ platforms: ["darwin"] }), {
        platform: "linux",
        blocklist: null,
      })
    ).toEqual({ kind: "platform", platform: "linux", supported: ["darwin"] });
  });

  it("refuses a blocklisted version before it is copied", () => {
    expect(pluginInstallRefusal(manifest(), { platform: "linux", blocklist })).toEqual({
      kind: "blocklisted",
      message: "Leaked key",
    });
  });

  it("admits an unlisted OS-neutral package and a version outside the blocked range", () => {
    expect(pluginInstallRefusal(manifest(), { platform: "linux", blocklist: null })).toBeNull();
    expect(
      pluginInstallRefusal(manifest({ version: "1.3.0", platforms: ["linux", "darwin"] }), {
        platform: "linux",
        blocklist,
      })
    ).toBeNull();
  });
});

describe("replacementRefusal", () => {
  const pkg = { name: "acme.graph", version: "1.2.0" };

  it("never lets an update downgrade or stand still", () => {
    expect(replacementRefusal(pkg, "1.1.0", { pluginId: "acme.graph", update: true })).toBeNull();
    expect(replacementRefusal(pkg, "1.2.0", { update: true })).toMatch(/isn't newer/);
    expect(replacementRefusal(pkg, "1.3.0", { update: true })).toMatch(/isn't newer/);
    expect(replacementRefusal(pkg, null, { update: true })).toMatch(/no longer installed/);
  });

  it("never lets an install replace an installed copy it was asked to add", () => {
    expect(replacementRefusal(pkg, "1.0.0", { pluginId: "acme.graph" })).toMatch(
      /already installed/
    );
    expect(replacementRefusal(pkg, null, { pluginId: "acme.graph" })).toBeNull();
    // A dropped package names no plugin and replaces as a local install does.
    expect(replacementRefusal(pkg, "1.0.0", {})).toBeNull();
  });
});
