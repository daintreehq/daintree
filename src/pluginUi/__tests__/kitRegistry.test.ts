import { describe, expect, it } from "vitest";
import { pluginKit, pluginKitFamilies } from "@/components/PluginKit/PluginKit";
import { pluginKitDataTables } from "@/components/PluginKit/PluginKitDataTables";

// A family that redefines a name another already serves replaces it without a
// word. Each such override has to be deliberate and listed here.
const APPROVED_OVERRIDES = ["DataTable"];

describe("plugin kit registry", () => {
  it("merges every family, and overrides only the names it approves", () => {
    const owners = new Map<string, number>();
    for (const family of pluginKitFamilies) {
      for (const name of Object.keys(family)) owners.set(name, (owners.get(name) ?? 0) + 1);
    }
    const overridden = [...owners].filter(([, count]) => count > 1).map(([name]) => name);
    expect(overridden.sort()).toEqual(APPROVED_OVERRIDES);
    expect(owners.get("DataTable")).toBe(2);
    expect(Object.keys(pluginKit).sort()).toEqual([...owners.keys()].sort());
  });

  it("serves the rich DataTable over the basic one", () => {
    expect(pluginKit.DataTable).toBe(pluginKitDataTables.DataTable);
  });
});
