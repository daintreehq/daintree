import { describe, expect, it } from "vitest";
import { parsePluginHostedViewKindId, pluginHostedViewKindId } from "../plugin.js";

describe("hosted view kind ids", () => {
  it.each([
    ["acme.tools", "prefs"],
    // A project instance key carries the project id inside it.
    ["project__0123abcd__acme.dash", "connection"],
    // An instance key is not promised to be free of `/`; a view id is.
    ["@acme/tools", "prefs"],
  ])("round-trips %s / %s", (pluginId, viewId) => {
    expect(parsePluginHostedViewKindId(pluginHostedViewKindId(pluginId, viewId))).toEqual({
      pluginId,
      viewId,
    });
  });

  it.each([
    "acme.tools.board",
    "project:p1/acme.dash/overview",
    "plugin-view:",
    "plugin-view:acme.tools",
    "plugin-view:/prefs",
    "plugin-view:acme.tools/",
    "plugin-view:acme.tools/pre fs",
  ])("names no hosted view: %j", (kindId) => {
    expect(parsePluginHostedViewKindId(kindId)).toBeNull();
  });

  it("refuses a non-string across the bridge", () => {
    expect(parsePluginHostedViewKindId(42 as unknown as string)).toBeNull();
  });
});
