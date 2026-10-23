import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginProjectTemplateRegistry,
  getPluginProjectTemplatePluginDir,
  getPluginProjectTemplates,
  registerPluginProjectTemplates,
  unregisterPluginProjectTemplates,
} from "../PluginProjectTemplateRegistry.js";

const template = (id: string, title: string, iconId?: string) => ({
  id,
  title,
  description: `${title} template`,
  ...(iconId ? { iconId } : {}),
});

afterEach(() => {
  clearPluginProjectTemplateRegistry();
});

describe("PluginProjectTemplateRegistry (#13825)", () => {
  it("lists templates by plugin name then title, whatever order plugins loaded in", () => {
    registerPluginProjectTemplates("zeta.tools", "Zeta", "/plugins/zeta", [
      template("notes", "Notes"),
    ]);
    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme", [
      template("site", "Site", "globe"),
      template("blog", "Blog"),
    ]);

    expect(getPluginProjectTemplates()).toEqual([
      {
        pluginId: "acme.sites",
        pluginName: "Acme",
        templateId: "blog",
        title: "Blog",
        description: "Blog template",
      },
      {
        pluginId: "acme.sites",
        pluginName: "Acme",
        templateId: "site",
        title: "Site",
        description: "Site template",
        iconId: "globe",
      },
      {
        pluginId: "zeta.tools",
        pluginName: "Zeta",
        templateId: "notes",
        title: "Notes",
        description: "Notes template",
      },
    ]);
  });

  it("resolves a plugin folder only for a template that plugin registered", () => {
    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme", [
      template("site", "Site"),
    ]);
    expect(getPluginProjectTemplatePluginDir("acme.sites", "site")).toBe("/plugins/acme");
    expect(getPluginProjectTemplatePluginDir("acme.sites", "blog")).toBeUndefined();
    expect(getPluginProjectTemplatePluginDir("other.plugin", "site")).toBeUndefined();
  });

  it("replaces a plugin's templates on reload and drops them on unload", () => {
    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme", [
      template("site", "Site"),
    ]);
    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme-v2", [
      template("blog", "Blog"),
    ]);
    expect(getPluginProjectTemplates().map((t) => t.templateId)).toEqual(["blog"]);
    expect(getPluginProjectTemplatePluginDir("acme.sites", "site")).toBeUndefined();
    expect(getPluginProjectTemplatePluginDir("acme.sites", "blog")).toBe("/plugins/acme-v2");

    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme-v2", []);
    expect(getPluginProjectTemplates()).toEqual([]);

    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme", [
      template("site", "Site"),
    ]);
    unregisterPluginProjectTemplates("acme.sites");
    expect(getPluginProjectTemplates()).toEqual([]);
    expect(getPluginProjectTemplatePluginDir("acme.sites", "site")).toBeUndefined();
  });

  it("hands out copies, so a caller can't edit what the registry holds", () => {
    registerPluginProjectTemplates("acme.sites", "Acme", "/plugins/acme", [
      template("site", "Site"),
    ]);
    getPluginProjectTemplates()[0].title = "Changed";
    expect(getPluginProjectTemplates()[0].title).toBe("Site");
  });
});
