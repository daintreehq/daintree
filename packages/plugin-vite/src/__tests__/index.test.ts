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

describe("@daintreehq/plugin-vite — Tailwind is a runtime contract, not a build step", () => {
  /** Invoke a hook Vite would normally call with its own plugin context. */
  function callHook<T>(hook: unknown, ...args: unknown[]): T {
    const fn = typeof hook === "function" ? hook : (hook as { handler: unknown }).handler;
    return (fn as (...a: unknown[]) => T).call({}, ...args);
  }

  function configResolvedWith(plugins: { name: string }[]): void {
    callHook(daintreePlugin().configResolved, { plugins });
  }

  it("rejects a build that wires the real Tailwind Vite plugin", async () => {
    // Against the REAL factory, not a fabricated plugin name. `@tailwindcss/vite`
    // registers `@tailwindcss/vite:scan` and `@tailwindcss/vite:generate:*` and
    // never its own package name, so an equality check silently never fires —
    // which is exactly what a hand-written `{ name: "@tailwindcss/vite" }`
    // fixture would fail to notice.
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    const contributed = [tailwindcss()].flat() as { name: string }[];

    expect(contributed.length).toBeGreaterThan(0);
    expect(contributed.every((p) => p.name !== "@tailwindcss/vite")).toBe(true);
    expect(() => configResolvedWith(contributed)).toThrow(/@tailwindcss\/vite/);
  });

  it("names the runtime contract in the refusal", () => {
    // The author's next move should be to adopt the contract, not to work
    // around the error, so the message has to say what to do instead.
    expect(() => configResolvedWith([{ name: "@tailwindcss/vite:scan" }])).toThrow(
      /compiles the Tailwind classes your view uses at runtime/
    );
  });

  it("allows a build with no Tailwind plugin", () => {
    expect(() =>
      configResolvedWith([{ name: "vite:react-babel" }, { name: "daintree-plugin-vite" }])
    ).not.toThrow();
  });

  it("runs its stylesheet check before Tailwind and vite:css compile it away", () => {
    // Tailwind's plugins are `enforce: "pre"` and vite:css runs ahead of normal
    // user plugins, so a plain transform would only ever see output CSS with the
    // directive already resolved.
    const transform = daintreePlugin().transform;
    expect(typeof transform).toBe("object");
    expect((transform as { order?: string }).order).toBe("pre");
  });

  it("rejects a stylesheet that pulls Tailwind in directly", () => {
    const plugin = daintreePlugin();
    const run = (code: string, id: string) => () => callHook(plugin.transform, code, id);

    expect(run('@import "tailwindcss";', "/p/src/panel.css")).toThrow(/compiles Tailwind itself/);
    expect(run("@import 'tailwindcss';", "/p/src/panel.css")).toThrow(/compiles Tailwind itself/);
    // v3 spelling too — an author copying an old template is the likely case.
    expect(run("@tailwind base;\n@tailwind components;", "/p/a.scss")).toThrow(
      /compiles Tailwind itself/
    );
    // Query suffixes are how Vite addresses CSS in a module graph.
    expect(run("@tailwind utilities;", "/p/a.css?used")).toThrow(/compiles Tailwind itself/);
  });

  it("does not refuse a build over a directive that is only mentioned", () => {
    // A false accusation here is worse than a miss: the author cannot act on it,
    // and the DOM observer means a missed case still styles correctly.
    const plugin = daintreePlugin();
    const run =
      (code: string, id = "/p/src/panel.css") =>
      () =>
        callHook(plugin.transform, code, id);

    expect(
      run("/* Migration: drop the old @tailwind utilities; line. */\n.a{color:red}")
    ).not.toThrow();
    expect(run(".a::after { content: '@tailwind utilities;' }")).not.toThrow();
    expect(run('@import "tailwindcss-preset-x";')).not.toThrow();
    expect(run("@tailwind utilities-extra;")).not.toThrow();
  });

  it("reads the stylesheet lexically, not by blanking comments with a regex", () => {
    const plugin = daintreePlugin();
    const run =
      (code: string, id = "/p/src/panel.css") =>
      () =>
        callHook(plugin.transform, code, id);

    // Quoted `/*` and `*/` are content, not a comment. A comment regex pairs
    // them and erases the real directive between — which Tailwind then compiles.
    expect(run('.a{content:"/*"} @tailwind utilities; .b{content:"*/"}')).toThrow(
      /compiles Tailwind itself/
    );
    // An at-rule inside a string is text. Refusing the build over it is an
    // accusation the author cannot act on.
    expect(run(`.a::after { content: '@import "tailwindcss"'; }`)).not.toThrow();
    // `//` is a comment in SCSS and friends, and not in plain CSS.
    expect(run("// Remove @tailwind utilities;\n.a{color:red}", "/p/a.scss")).not.toThrow();
  });

  it("catches a directive with no trailing semicolon", () => {
    // Tailwind accepts `@tailwind utilities` at end of file, so requiring the
    // semicolon left a bypass that compiled the whole utility set.
    const plugin = daintreePlugin();

    expect(() => callHook(plugin.transform, "@tailwind utilities", "/p/a.css")).toThrow(
      /compiles Tailwind itself/
    );
  });

  it("leaves ordinary plugin CSS and non-CSS modules alone", () => {
    const plugin = daintreePlugin();

    expect(
      callHook(plugin.transform, "@layer components { .panel { color: red } }", "/p/src/panel.css")
    ).toBeNull();
    expect(
      callHook(plugin.transform, 'const doc = "@tailwind utilities;";', "/p/src/a.ts")
    ).toBeNull();
  });

  it("does not add the guard to the node target, which has no views", () => {
    const plugin = daintreePlugin({ target: "node" });
    expect(plugin.configResolved).toBeUndefined();
    expect(plugin.transform).toBeUndefined();
  });
});
