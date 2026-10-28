import { describe, it, expect } from "vitest";
import { resolvePluginToolbarMenu } from "../pluginToolbarMenu";

const registered = new Map([
  ["acme.sync", "Sync"],
  ["acme.pull", "Pull"],
  ["other.run", "Run"],
]);

describe("resolvePluginToolbarMenu", () => {
  const config = {
    pluginId: "acme",
    menu: [{ actionId: "acme.sync" }, { actionId: "acme.pull", label: "Pull now" }],
  };

  it("lists the manifest menu in order, labelled by the item or the action's title", () => {
    expect(resolvePluginToolbarMenu(config, null, registered)).toEqual([
      { actionId: "acme.sync", label: "Sync" },
      { actionId: "acme.pull", label: "Pull now" },
    ]);
  });

  it("waits for an action to register", () => {
    expect(resolvePluginToolbarMenu(config, null, new Map([["acme.pull", "Pull"]]))).toEqual([
      { actionId: "acme.pull", label: "Pull now" },
    ]);
    expect(resolvePluginToolbarMenu(config, null, new Map())).toEqual([]);
  });

  it("lets the plugin's live menu replace the manifest's, and [] remove it", () => {
    expect(
      resolvePluginToolbarMenu(config, { menu: [{ actionId: "acme.pull" }] }, registered)
    ).toEqual([{ actionId: "acme.pull", label: "Pull" }]);
    expect(resolvePluginToolbarMenu(config, { menu: [] }, registered)).toEqual([]);
  });

  it("never offers another plugin's action", () => {
    expect(
      resolvePluginToolbarMenu(
        { pluginId: "acme", menu: [{ actionId: "other.run" }] },
        null,
        registered
      )
    ).toEqual([]);
  });

  it("is empty for a button without a menu", () => {
    expect(resolvePluginToolbarMenu({ pluginId: "acme" }, null, registered)).toEqual([]);
  });
});
