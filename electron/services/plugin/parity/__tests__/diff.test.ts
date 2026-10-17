import { describe, expect, it } from "vitest";
import { computePluginParity } from "../diff.js";
import type { PluginInventory, PluginInventoryEntry } from "../inventory.js";

function entry(pluginId: string, patch: Partial<PluginInventoryEntry> = {}): PluginInventoryEntry {
  return {
    pluginId,
    displayName: pluginId,
    version: "1.0.0",
    engine: null,
    platforms: null,
    remoteUnsupported: false,
    blocklisted: false,
    missingSecrets: [],
    ...patch,
  };
}

function inventory(
  plugins: PluginInventoryEntry[],
  patch: Partial<PluginInventory> = {}
): PluginInventory {
  return { appVersion: "0.38.0", platform: "linux", plugins, ...patch };
}

function rowFor(rows: ReturnType<typeof computePluginParity>, pluginId: string) {
  const row = rows.find((candidate) => candidate.pluginId === pluginId);
  if (!row) throw new Error(`no row for ${pluginId}`);
  return row;
}

describe("computePluginParity", () => {
  it("offers to install a plugin only this machine has", () => {
    const rows = computePluginParity(inventory([entry("acme.md")]), inventory([]));
    expect(rowFor(rows, "acme.md")).toEqual({
      pluginId: "acme.md",
      displayName: "acme.md",
      group: "only-here",
      localVersion: "1.0.0",
      hostVersion: null,
      incompatibility: null,
      action: "install-on-host",
    });
  });

  it("lists a plugin only the host has without an action", () => {
    const row = rowFor(computePluginParity(inventory([]), inventory([entry("acme.x")])), "acme.x");
    expect(row).toMatchObject({ group: "only-on-host", action: null, hostVersion: "1.0.0" });
  });

  it("offers an update only when this machine's copy is newer", () => {
    const newerHere = computePluginParity(
      inventory([entry("acme.a", { version: "1.3.0" })]),
      inventory([entry("acme.a", { version: "1.2.0" })])
    );
    expect(rowFor(newerHere, "acme.a")).toMatchObject({
      group: "version-differs",
      action: "update-on-host",
      localVersion: "1.3.0",
      hostVersion: "1.2.0",
    });

    const newerThere = computePluginParity(
      inventory([entry("acme.a", { version: "1.2.0" })]),
      inventory([entry("acme.a", { version: "1.3.0" })])
    );
    expect(rowFor(newerThere, "acme.a")).toMatchObject({
      group: "version-differs",
      action: null,
    });
  });

  it("reports the same version as same", () => {
    const rows = computePluginParity(inventory([entry("acme.a")]), inventory([entry("acme.a")]));
    expect(rowFor(rows, "acme.a")).toMatchObject({ group: "same", action: null });
  });

  it("refuses a plugin with no build for the host's OS before offering to copy it", () => {
    const rows = computePluginParity(
      inventory([entry("acme.graph", { platforms: ["darwin"] })], { platform: "darwin" }),
      inventory([], { platform: "linux" })
    );
    expect(rowFor(rows, "acme.graph")).toMatchObject({
      group: "incompatible",
      action: null,
      incompatibility: { kind: "platform", hostPlatform: "linux", supported: ["darwin"] },
    });
  });

  it("offers no install for a plugin that refuses remote windows anyway", () => {
    const rows = computePluginParity(
      inventory([entry("acme.local", { remoteUnsupported: true })]),
      inventory([])
    );
    expect(rowFor(rows, "acme.local")).toMatchObject({
      group: "incompatible",
      action: null,
      incompatibility: { kind: "remote-unsupported" },
    });
  });

  it("reports an unmet engine range on the host but still offers the install", () => {
    const rows = computePluginParity(
      inventory([entry("acme.new", { engine: ">=0.40.0" })]),
      inventory([], { appVersion: "0.38.0" })
    );
    expect(rowFor(rows, "acme.new")).toMatchObject({
      group: "only-here",
      action: "install-on-host",
      incompatibility: { kind: "engine", required: ">=0.40.0", hostVersion: "0.38.0" },
    });
  });

  it("reports the host copy's engine mismatch as incompatible", () => {
    const rows = computePluginParity(
      inventory([]),
      inventory([entry("acme.new", { engine: ">=0.40.0" })], { appVersion: "0.38.0" })
    );
    expect(rowFor(rows, "acme.new")).toMatchObject({
      group: "incompatible",
      incompatibility: { kind: "engine" },
    });
  });

  it("reports remote-unsupported, blocklisted and unconfigured host copies", () => {
    const rows = computePluginParity(
      inventory([entry("acme.remote"), entry("acme.blocked"), entry("acme.linear")]),
      inventory([
        entry("acme.remote", { remoteUnsupported: true }),
        entry("acme.blocked", { blocklisted: true }),
        entry("acme.linear", { missingSecrets: ["apiToken"] }),
      ])
    );
    expect(rowFor(rows, "acme.remote").incompatibility).toEqual({ kind: "remote-unsupported" });
    expect(rowFor(rows, "acme.blocked").incompatibility).toEqual({ kind: "untrusted" });
    expect(rowFor(rows, "acme.linear").incompatibility).toEqual({
      kind: "unconfigured",
      missing: ["apiToken"],
    });
    for (const id of ["acme.remote", "acme.blocked", "acme.linear"]) {
      expect(rowFor(rows, id).group).toBe("incompatible");
    }
  });

  it("keeps the update action on an incompatible row whose copy here is newer", () => {
    const rows = computePluginParity(
      inventory([entry("acme.linear", { version: "2.0.0" })]),
      inventory([entry("acme.linear", { version: "1.0.0", missingSecrets: ["token"] })])
    );
    expect(rowFor(rows, "acme.linear")).toMatchObject({
      group: "incompatible",
      action: "update-on-host",
    });
  });

  it("orders rows by group, then name", () => {
    const rows = computePluginParity(
      inventory([entry("acme.b"), entry("acme.a"), entry("acme.same")]),
      inventory([entry("acme.same"), entry("acme.host")])
    );
    expect(rows.map((row) => row.pluginId)).toEqual(["acme.a", "acme.b", "acme.host", "acme.same"]);
  });
});
