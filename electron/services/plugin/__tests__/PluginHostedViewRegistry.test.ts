import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPluginHostedViewRegistry,
  getPluginHostedViews,
  registerPluginHostedViews,
  unregisterPluginHostedViews,
} from "../PluginHostedViewRegistry.js";
import type { PluginHostedViewDescriptor } from "../../../../shared/types/plugin.js";

function view(pluginId: string, componentPath: string): PluginHostedViewDescriptor {
  return {
    id: `plugin-view:${pluginId}/prefs`,
    pluginId,
    viewId: "prefs",
    location: "settings",
    name: `${pluginId} settings`,
    componentPath,
  };
}

beforeEach(() => {
  clearPluginHostedViewRegistry();
});

describe("PluginHostedViewRegistry", () => {
  it("replaces a plugin's views wholesale, so a reload's new module can't sit beside the old", () => {
    registerPluginHostedViews("acme.a", [view("acme.a", "plugin://a/__dtv-1/prefs.js")]);
    registerPluginHostedViews("acme.b", [view("acme.b", "plugin://b/__dtv-1/prefs.js")]);
    registerPluginHostedViews("acme.a", [view("acme.a", "plugin://a/__dtv-2/prefs.js")]);

    expect(getPluginHostedViews().map((v) => v.componentPath)).toEqual([
      "plugin://b/__dtv-1/prefs.js",
      "plugin://a/__dtv-2/prefs.js",
    ]);
  });

  it("drops a plugin that now registers none", () => {
    registerPluginHostedViews("acme.a", [view("acme.a", "plugin://a/prefs.js")]);
    registerPluginHostedViews("acme.a", []);
    expect(getPluginHostedViews()).toEqual([]);
  });

  it("reports whether an unregister withdrew anything, so unload broadcasts only on a change", () => {
    registerPluginHostedViews("acme.a", [view("acme.a", "plugin://a/prefs.js")]);
    expect(unregisterPluginHostedViews("acme.a")).toBe(true);
    expect(unregisterPluginHostedViews("acme.a")).toBe(false);
    expect(getPluginHostedViews()).toEqual([]);
  });

  it("hands out copies that a caller can't use to rewrite the registry", () => {
    const registered = view("acme.a", "plugin://a/prefs.js");
    registerPluginHostedViews("acme.a", [registered]);
    registered.componentPath = "plugin://evil/prefs.js";
    getPluginHostedViews()[0].componentPath = "plugin://evil/prefs.js";

    expect(getPluginHostedViews()[0].componentPath).toBe("plugin://a/prefs.js");
  });
});
