import { describe, expect, it } from "vitest";
import type { LoadedPluginInfo, PluginCapability, PluginCategoryId } from "@shared/types/plugin";
import { filterPlugins, isQueryActive, parsePluginQuery, scorePlugin } from "../pluginSearch";

function makePlugin(overrides: {
  name: string;
  displayName?: string;
  description?: string;
  tagline?: string;
  category?: PluginCategoryId;
  isBuiltin?: boolean;
  disabled?: boolean;
  capabilities?: PluginCapability[];
  blocklisted?: boolean;
  loadError?: { message: string; at: number };
}): LoadedPluginInfo {
  return {
    instanceId: overrides.name,
    origin: "global",
    projectId: null,
    manifest: {
      name: overrides.name,
      version: "1.0.0",
      displayName: overrides.displayName,
      description: overrides.description,
      tagline: overrides.tagline,
      category: overrides.category,
      capabilities: overrides.capabilities,
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        views: [],
        mcpServers: [],
        skills: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        fileEditors: [],
        agents: [],
        processTools: [],
        recipes: [],
      },
    },
    dir: `/plugins/${overrides.name}`,
    loadedAt: 0,
    isBuiltin: overrides.isBuiltin ?? false,
    source: overrides.isBuiltin ? "builtin" : "sideload",
    installedAt: 0,
    archiveHash: null,
    originalUrl: null,
    disabled: overrides.disabled ?? false,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    blocklisted: overrides.blocklisted ?? false,
    loadError: overrides.loadError ?? null,
  };
}

const names = (plugins: LoadedPluginInfo[]) => plugins.map((p) => p.manifest.name);

describe("parsePluginQuery", () => {
  it("splits operators from free text", () => {
    const parsed = parsePluginQuery("@builtin notes");
    expect(parsed.operators).toEqual([{ key: "builtin", value: null }]);
    expect(parsed.freeText).toBe("notes");
  });

  it("is case-insensitive on operator keys and values", () => {
    const parsed = parsePluginQuery("@Builtin @CAP:Network:Fetch");
    expect(parsed.operators).toEqual([
      { key: "builtin", value: null },
      { key: "cap", value: "network:fetch" },
    ]);
  });

  it("treats unknown @tokens as free text", () => {
    const parsed = parsePluginQuery("@category:ui notes");
    expect(parsed.operators).toEqual([]);
    expect(parsed.freeText).toBe("@category:ui notes");
  });

  it("captures free text on both sides of an operator", () => {
    const parsed = parsePluginQuery("foo @disabled bar");
    expect(parsed.operators).toEqual([{ key: "disabled", value: null }]);
    expect(parsed.freeText).toBe("foo bar");
  });

  it("parses @cap with an empty value as null", () => {
    const parsed = parsePluginQuery("@cap:");
    expect(parsed.operators).toEqual([{ key: "cap", value: null }]);
    expect(parsed.freeText).toBe("");
  });

  it("stops the operator key at a non-letter so @builtin-extra yields @builtin + tail", () => {
    const parsed = parsePluginQuery("@builtin-extra");
    expect(parsed.operators).toEqual([{ key: "builtin", value: null }]);
    expect(parsed.freeText).toBe("-extra");
  });

  it("keeps a colon-bearing capability value intact", () => {
    const parsed = parsePluginQuery("@cap:network:fetch");
    expect(parsed.operators).toEqual([{ key: "cap", value: "network:fetch" }]);
    expect(parsed.freeText).toBe("");
  });
});

describe("isQueryActive", () => {
  it("is false for whitespace-only input", () => {
    expect(isQueryActive(parsePluginQuery("   "))).toBe(false);
  });

  it("is true when an operator is present", () => {
    expect(isQueryActive(parsePluginQuery("@enabled"))).toBe(true);
  });

  it("is true when free text is present", () => {
    expect(isQueryActive(parsePluginQuery("notes"))).toBe(true);
  });
});

describe("filterPlugins operators", () => {
  const plugins = [
    makePlugin({ name: "core.builtin", isBuiltin: true }),
    makePlugin({ name: "core.builtin-off", isBuiltin: true, disabled: true }),
    makePlugin({ name: "third.party" }),
    makePlugin({ name: "third.party-off", disabled: true }),
    makePlugin({ name: "third.blocked", blocklisted: true }),
  ];

  it("@builtin selects by provenance alone, whatever the plugin's state", () => {
    expect(names(filterPlugins(plugins, "@builtin"))).toEqual(["core.builtin", "core.builtin-off"]);
  });

  it("@installed selects by provenance alone, whatever the plugin's state", () => {
    expect(names(filterPlugins(plugins, "@installed"))).toEqual([
      "third.party",
      "third.party-off",
      "third.blocked",
    ]);
  });

  it("@enabled means what the row's switch means, so a blocked plugin is not enabled", () => {
    // The row computes `disabled !== true && !blocklisted`. A blocklisted plugin
    // renders with its switch off, so matching it here would return a row that
    // visibly contradicts the filter that found it.
    expect(names(filterPlugins(plugins, "@enabled"))).toEqual(["core.builtin", "third.party"]);
  });

  it("@disabled returns only disabled plugins", () => {
    expect(names(filterPlugins(plugins, "@disabled"))).toEqual([
      "core.builtin-off",
      "third.party-off",
    ]);
  });

  it("AND-combines multiple operators", () => {
    expect(names(filterPlugins(plugins, "@enabled @builtin"))).toEqual(["core.builtin"]);
    expect(names(filterPlugins(plugins, "@installed @disabled"))).toEqual(["third.party-off"]);
  });

  it("keeps provenance and state independent, so every combination is reachable", () => {
    // The invariant, not the values: provenance (@builtin/@installed) and state
    // (@enabled/@disabled) are orthogonal axes. These used to AND an implicit
    // `!disabled` into the provenance operators, which made "@builtin @disabled"
    // — the obvious way to ask which built-ins you had switched off —
    // unsatisfiable, because it reduced to `!disabled && disabled`.
    for (const provenance of ["@builtin", "@installed"]) {
      const all = names(filterPlugins(plugins, provenance));
      const enabled = names(filterPlugins(plugins, `${provenance} @enabled`));
      const disabled = names(filterPlugins(plugins, `${provenance} @disabled`));
      expect(disabled.length).toBeGreaterThan(0);
      // Each state partition is a subset of the provenance set, and together
      // they never exceed it.
      for (const name of [...enabled, ...disabled]) expect(all).toContain(name);
      expect(enabled.filter((n) => disabled.includes(n))).toEqual([]);
    }
  });

  it("@problem finds what the user would call broken, whatever the switch says", () => {
    // The rule, not the list: a plugin the user did not switch off but which
    // cannot run is the case the row's switch cannot express, so the filter
    // behind the health summary has to key off runtime facts rather than the
    // `disabled` flag.
    const broken = [
      makePlugin({ name: "a.failed", loadError: { message: "boom", at: 1 } }),
      makePlugin({ name: "a.blocked", blocklisted: true }),
      makePlugin({ name: "a.fine" }),
      makePlugin({ name: "a.off", disabled: true }),
    ];
    expect(names(filterPlugins(broken, "@problem"))).toEqual(["a.failed", "a.blocked"]);
    // Switched off on purpose is not a problem.
    expect(names(filterPlugins(broken, "@problem"))).not.toContain("a.off");
  });

  it("@problem still narrows by free text, like every other operator", () => {
    const broken = [
      makePlugin({ name: "a.alpha", displayName: "Alpha", loadError: { message: "x", at: 1 } }),
      makePlugin({ name: "a.beta", displayName: "Beta", loadError: { message: "x", at: 1 } }),
    ];
    expect(names(filterPlugins(broken, "@problem alpha"))).toEqual(["a.alpha"]);
    expect(names(filterPlugins(broken, "@problem zzz"))).toEqual([]);
  });

  it("returns all plugins for a blank query", () => {
    expect(names(filterPlugins(plugins, "  "))).toEqual(names(plugins));
  });
});

describe("filterPlugins @cap", () => {
  const plugins = [
    makePlugin({ name: "net.plugin", capabilities: ["network:fetch"] }),
    makePlugin({ name: "fs.plugin", capabilities: ["fs:project-read"] }),
    makePlugin({ name: "nocap.plugin" }),
  ];

  it("matches plugins declaring the capability", () => {
    expect(names(filterPlugins(plugins, "@cap:network:fetch"))).toEqual(["net.plugin"]);
  });

  it("matches case-insensitively", () => {
    expect(names(filterPlugins(plugins, "@cap:NETWORK:FETCH"))).toEqual(["net.plugin"]);
  });

  it("@cap with no value matches nothing", () => {
    expect(names(filterPlugins(plugins, "@cap:"))).toEqual([]);
  });

  it("plugins without a capabilities array never match @cap", () => {
    expect(names(filterPlugins(plugins, "@cap:fs:project-read"))).toEqual(["fs.plugin"]);
  });
});

describe("filterPlugins @cat", () => {
  const plugins = [
    makePlugin({ name: "a.github", category: "forge" }),
    makePlugin({ name: "b.notes", category: "workspace" }),
    makePlugin({ name: "c.misc" }),
  ];

  it("matches the declared category", () => {
    expect(names(filterPlugins(plugins, "@cat:forge"))).toEqual(["a.github"]);
  });

  it("matches the derived fallback category for undeclared plugins", () => {
    expect(names(filterPlugins(plugins, "@cat:other"))).toEqual(["c.misc"]);
  });

  it("@cat with no value matches nothing", () => {
    expect(names(filterPlugins(plugins, "@cat:"))).toEqual([]);
  });

  it("AND-combines with state operators", () => {
    const mixed = [
      makePlugin({ name: "on.forge", category: "forge" }),
      makePlugin({ name: "off.forge", category: "forge", disabled: true }),
    ];
    expect(names(filterPlugins(mixed, "@cat:forge @disabled"))).toEqual(["off.forge"]);
  });
});

describe("filterPlugins free text", () => {
  const plugins = [
    makePlugin({ name: "a.notes", displayName: "Notes", description: "Take quick notes" }),
    makePlugin({ name: "b.other", displayName: "Other", description: "Has notes in description" }),
  ];

  it("ranks a name match above a description-only match", () => {
    expect(names(filterPlugins(plugins, "notes"))).toEqual(["a.notes", "b.other"]);
  });

  it("drops plugins matching neither name nor description", () => {
    expect(names(filterPlugins(plugins, "zzzznomatch"))).toEqual([]);
  });

  it("matches tagline text", () => {
    const tagged = [
      makePlugin({ name: "t.tagged", displayName: "Tagged", tagline: "Quick capture for ideas" }),
      makePlugin({ name: "u.untagged", displayName: "Untagged" }),
    ];
    expect(names(filterPlugins(tagged, "capture"))).toEqual(["t.tagged"]);
  });

  it("combines operators with free text (AND)", () => {
    const mixed = [
      makePlugin({ name: "x.notes", displayName: "Notes", isBuiltin: true }),
      makePlugin({ name: "y.notes", displayName: "Notes", isBuiltin: false }),
    ];
    expect(names(filterPlugins(mixed, "@builtin notes"))).toEqual(["x.notes"]);
  });
});

describe("scorePlugin", () => {
  it("returns 0 for empty free text", () => {
    expect(scorePlugin(makePlugin({ name: "a", displayName: "Alpha" }), "")).toBe(0);
  });

  it("scores a name hit higher than a description hit for the same term", () => {
    const nameHit = scorePlugin(makePlugin({ name: "a", displayName: "Logger" }), "logger");
    const descHit = scorePlugin(
      makePlugin({ name: "b", displayName: "Tool", description: "A logger tool" }),
      "logger"
    );
    expect(nameHit).toBeGreaterThan(descHit);
  });
});
