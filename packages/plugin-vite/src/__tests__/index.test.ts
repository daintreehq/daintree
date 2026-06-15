import { describe, it, expect } from "vitest";
import { reactExternals, daintreePlugin, HOST_IMPORTMAP_SPECIFIERS } from "../index.js";

describe("@daintreehq/plugin-vite — reactExternals", () => {
  function matchesAny(specifier: string): boolean {
    return reactExternals.some((re) => re.test(specifier));
  }

  it("matches bare react and react-dom", () => {
    expect(matchesAny("react")).toBe(true);
    expect(matchesAny("react-dom")).toBe(true);
  });

  it("matches every documented React subpath", () => {
    expect(matchesAny("react/jsx-runtime")).toBe(true);
    expect(matchesAny("react/jsx-dev-runtime")).toBe(true);
    expect(matchesAny("react/compiler-runtime")).toBe(true);
    expect(matchesAny("react-dom/client")).toBe(true);
    expect(matchesAny("react-dom/server")).toBe(true);
  });

  it("does not match adjacent package names that share a prefix", () => {
    expect(matchesAny("reactive-lib")).toBe(false);
    expect(matchesAny("reactstrap")).toBe(false);
    expect(matchesAny("react-router")).toBe(false);
    expect(matchesAny("react-dom-stub")).toBe(false);
  });

  it("does not match scoped packages whose path contains 'react'", () => {
    expect(matchesAny("@scope/react")).toBe(false);
    expect(matchesAny("@types/react")).toBe(false);
    expect(matchesAny("preact")).toBe(false);
  });
});

describe("@daintreehq/plugin-vite — daintreePlugin", () => {
  it("returns a Vite plugin with the expected name", () => {
    const plugin = daintreePlugin();
    expect(plugin.name).toBe("daintree-plugin-vite");
    expect(typeof plugin.config).toBe("function");
  });

  it("contributes the React externals through the config hook", () => {
    const plugin = daintreePlugin();
    const configFn = plugin.config as unknown as () => {
      build: { rollupOptions: { external: ReadonlyArray<string | RegExp> } };
    };
    const result = configFn();
    expect(result.build.rollupOptions.external).toHaveLength(reactExternals.length);
    for (const re of reactExternals) {
      expect(result.build.rollupOptions.external).toContain(re);
    }
  });

  it("merges caller-supplied externals after the React preset", () => {
    const plugin = daintreePlugin({ externals: ["@host/shared-ui", /^@daintree\//] });
    const configFn = plugin.config as unknown as () => {
      build: { rollupOptions: { external: ReadonlyArray<string | RegExp> } };
    };
    const externals = configFn().build.rollupOptions.external;
    expect(externals).toContain("@host/shared-ui");
    expect(externals.length).toBe(reactExternals.length + 2);
  });
});

describe("@daintreehq/plugin-vite — HOST_IMPORTMAP_SPECIFIERS", () => {
  function matchesAny(specifier: string): boolean {
    return reactExternals.some((re) => re.test(specifier));
  }

  it("only lists specifiers that the React externals would strip", () => {
    // The host-mapped set must be a subset of what gets externalized — a mapped
    // specifier the externals didn't strip would be bundled, never resolved
    // through the import map.
    for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
      expect(matchesAny(specifier)).toBe(true);
    }
  });

  it("does not list React subpaths the host cannot resolve", () => {
    // The externals are broader than the import map on purpose; these subpaths
    // externalize but must NOT be advertised as host-served.
    const list = HOST_IMPORTMAP_SPECIFIERS as readonly string[];
    expect(matchesAny("react-dom/server")).toBe(true);
    expect(list).not.toContain("react-dom/server");
    expect(list).not.toContain("react/compiler-runtime");
  });

  it("has no duplicate entries", () => {
    expect(new Set(HOST_IMPORTMAP_SPECIFIERS).size).toBe(HOST_IMPORTMAP_SPECIFIERS.length);
  });
});

describe("@daintreehq/plugin-vite — unmapped subpath guard", () => {
  type ResolveIdFn = (id: string) => string | null;

  function resolveIdOf(plugin: ReturnType<typeof daintreePlugin>): ResolveIdFn {
    return plugin.resolveId as unknown as ResolveIdFn;
  }

  it("throws on a React subpath the host import map does not serve", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    expect(() => resolveId("react-dom/server")).toThrow(/react-dom\/server/);
    expect(() => resolveId("react/compiler-runtime")).toThrow(/import map/);
  });

  it("allows every host-served specifier through (returns null to externalize)", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
      expect(resolveId(specifier)).toBeNull();
    }
  });

  it("ignores non-React specifiers", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    expect(resolveId("react-router")).toBeNull();
    expect(resolveId("@scope/react")).toBeNull();
    expect(resolveId("./local-module")).toBeNull();
  });
});

describe("@daintreehq/plugin-vite — node target", () => {
  type NodeConfig = {
    resolve: { conditions: string[]; mainFields: string[] };
    build: { target: string; rollupOptions: { external: ReadonlyArray<string | RegExp> } };
  };

  function nodeConfig(plugin: ReturnType<typeof daintreePlugin>): NodeConfig {
    return (plugin.config as unknown as () => NodeConfig)();
  }

  it("externalizes Node built-ins in both bare and node: forms", () => {
    const external = nodeConfig(daintreePlugin({ target: "node" })).build.rollupOptions.external;
    expect(external).toContain("process");
    expect(external).toContain("node:process");
    expect(external).toContain("fs");
    expect(external).toContain("node:fs");
  });

  it("does not externalize React (node code has no host import map)", () => {
    const external = nodeConfig(daintreePlugin({ target: "node" })).build.rollupOptions.external;
    for (const re of reactExternals) {
      expect(external).not.toContain(re);
    }
  });

  it("prefers Node resolve conditions over browser", () => {
    const { resolve } = nodeConfig(daintreePlugin({ target: "node" }));
    expect(resolve.conditions).toContain("node");
    expect(resolve.conditions).not.toContain("browser");
    expect(resolve.mainFields).not.toContain("browser");
  });

  it("merges caller-supplied externals alongside the Node built-ins", () => {
    const external = nodeConfig(daintreePlugin({ target: "node", externals: ["better-sqlite3"] }))
      .build.rollupOptions.external;
    expect(external).toContain("better-sqlite3");
    expect(external).toContain("node:fs");
  });

  it("does not attach the React subpath guard to node builds", () => {
    expect(daintreePlugin({ target: "node" }).resolveId).toBeUndefined();
  });
});
