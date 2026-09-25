import { describe, it, expect } from "vitest";
import { build } from "vite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  reactExternals,
  tourExternals,
  daintreePlugin,
  HOST_IMPORTMAP_SPECIFIERS,
} from "../index.js";

function matchesHostExternal(specifier: string): boolean {
  return [...reactExternals, ...tourExternals].some((re) => re.test(specifier));
}

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

describe("@daintreehq/plugin-vite — tourExternals", () => {
  function matchesAny(specifier: string): boolean {
    return tourExternals.some((re) => re.test(specifier));
  }

  it("matches the tour root and every subpath", () => {
    expect(matchesAny("@daintreehq/tour")).toBe(true);
    expect(matchesAny("@daintreehq/tour/react")).toBe(true);
    expect(matchesAny("@daintreehq/tour/kit")).toBe(true);
  });

  it("does not match adjacent package names that share a prefix", () => {
    expect(matchesAny("@daintreehq/tour-extra")).toBe(false);
    expect(matchesAny("@daintreehq/tourist")).toBe(false);
    expect(matchesAny("@daintreehq/plugin-sdk")).toBe(false);
    expect(matchesAny("@other/tour")).toBe(false);
  });
});

describe("@daintreehq/plugin-vite — daintreePlugin", () => {
  it("returns a Vite plugin with the expected name", () => {
    const plugin = daintreePlugin();
    expect(plugin.name).toBe("daintree-plugin-vite");
    expect(typeof plugin.config).toBe("function");
  });

  type ExternalFn = (id: string, importer?: string, isResolved?: boolean) => boolean;
  function externalOf(plugin: ReturnType<typeof daintreePlugin>, userConfig = {}): ExternalFn {
    const configFn = plugin.config as unknown as (config: unknown) => {
      build: { rollupOptions: { external: ExternalFn } };
    };
    return configFn(userConfig).build.rollupOptions.external;
  }

  it("externalizes every host-served specifier, as a function", () => {
    const external = externalOf(daintreePlugin());
    expect(typeof external).toBe("function");
    for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
      expect(matchesHostExternal(specifier)).toBe(true);
      expect(external(specifier)).toBe(true);
    }
    expect(external("react-router")).toBe(false);
    expect(external("./local-module")).toBe(false);
  });

  it("throws from the external decision for an unmapped React subpath", () => {
    // `external` is consulted before `resolveId`, and a match skips resolution
    // entirely, so this is the only hook where the guard is guaranteed to run.
    const external = externalOf(daintreePlugin());
    expect(() => external("react-dom/server")).toThrow(/import map does not serve/);
    expect(() => external("react/compiler-runtime")).toThrow(/react\/compiler-runtime/);
  });

  it("throws from the external decision for an unmapped tour subpath", () => {
    const external = externalOf(daintreePlugin());
    expect(() => external("@daintreehq/tour/internal")).toThrow(
      /@daintreehq\/tour\/internal.*import map/
    );
  });

  it("does not let an author external smuggle an unmapped tour subpath past the guard", () => {
    const external = externalOf(daintreePlugin({ externals: [/^@daintreehq\//] }));
    expect(() => external("@daintreehq/tour/internal")).toThrow(/import map does not serve/);
    expect(external("@daintreehq/tour/react")).toBe(true);
    expect(external("@daintreehq/tour/kit")).toBe(true);
    expect(external("@daintreehq/tour/mock-app")).toBe(true);
  });

  it("merges caller-supplied externals with the React preset", () => {
    const external = externalOf(daintreePlugin({ externals: ["@host/shared-ui", /^@daintree\//] }));
    expect(external("@host/shared-ui")).toBe(true);
    expect(external("@daintree/anything")).toBe(true);
    // Strings are exact ids, as in Rollup — a prefix is not a match.
    expect(external("@host/shared-ui/deep")).toBe(false);
    expect(external("react")).toBe(true);
  });

  it("matches a global or sticky regex the same way on every call", () => {
    // `RegExp.test` advances `lastIndex` on a `g`/`y` regex, so without a reset
    // the second consecutive match against the same pattern fails.
    const external = externalOf(daintreePlugin({ externals: [/^@acme\//g] }));
    expect(external("@acme/a")).toBe(true);
    expect(external("@acme/b")).toBe(true);
    expect(external("@acme/c")).toBe(true);
  });

  it("folds an external the author set in their own config into the function", () => {
    // Vite's config merge would concatenate an author array with this function
    // into a shape Rolldown cannot consume, so the preset absorbs it instead.
    const userConfig = { build: { rollupOptions: { external: ["lodash", /^@acme\//] } } };
    const external = externalOf(daintreePlugin(), userConfig);
    expect(external("lodash")).toBe(true);
    expect(external("@acme/ui")).toBe(true);
    expect(external("react")).toBe(true);
    expect(userConfig.build.rollupOptions.external).toBeUndefined();

    const fromFn = externalOf(daintreePlugin(), {
      build: { rollupOptions: { external: (id: string) => id === "chalk" } },
    });
    expect(fromFn("chalk")).toBe(true);
    expect(fromFn("lodash")).toBe(false);
  });
});

describe("@daintreehq/plugin-vite — real build honours the unmapped subpath guard", () => {
  async function buildEntry(source: string) {
    const root = await mkdtemp(path.join(tmpdir(), "daintree-vite-external-"));
    try {
      const entry = path.join(root, "entry.js");
      await writeFile(entry, source);
      const result = await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [daintreePlugin()],
        build: { write: false, lib: { entry, formats: ["es"], fileName: "entry" } },
      });
      const outputs = Array.isArray(result) ? result : [result];
      return outputs
        .flatMap((output) => ("output" in output ? output.output : []))
        .filter((file) => file.type === "chunk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rejects a bundle importing react-dom/server instead of emitting an unresolvable import", async () => {
    await expect(
      buildEntry('import { renderToString } from "react-dom/server"; export { renderToString };')
    ).rejects.toThrow(/react-dom\/server.*import map does not serve/);
  });

  it("leaves a host-mapped specifier external in the emitted chunk", async () => {
    const chunks = await buildEntry(
      'import { createRoot } from "react-dom/client"; export const mount = (el) => createRoot(el);'
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.imports).toEqual(["react-dom/client"]);
    expect(chunks[0]?.code).toContain('from "react-dom/client"');
  });

  it("leaves every tour subpath external so a scene shares the host's tour instance", async () => {
    const chunks = await buildEntry(
      'import { TourPlayer } from "@daintreehq/tour"; import { useCue } from "@daintreehq/tour/react"; import { TourCanvas } from "@daintreehq/tour/kit"; import { MockApp } from "@daintreehq/tour/mock-app"; export { TourPlayer, useCue, TourCanvas, MockApp };'
    );
    expect(chunks).toHaveLength(1);
    expect([...(chunks[0]?.imports ?? [])].sort()).toEqual([
      "@daintreehq/tour",
      "@daintreehq/tour/kit",
      "@daintreehq/tour/mock-app",
      "@daintreehq/tour/react",
    ]);
    expect(chunks[0]?.code).not.toContain("TourPlayerContext");
  });

  it("rejects a bundle importing an unmapped tour subpath", async () => {
    await expect(
      buildEntry('import { internal } from "@daintreehq/tour/internal"; export { internal };')
    ).rejects.toThrow(/@daintreehq\/tour\/internal.*import map does not serve/);
  });
});

describe("@daintreehq/plugin-vite — HOST_IMPORTMAP_SPECIFIERS", () => {
  function matchesAny(specifier: string): boolean {
    return reactExternals.some((re) => re.test(specifier));
  }

  it("only lists specifiers that the host externals would strip", () => {
    // The host-mapped set must be a subset of what gets externalized — a mapped
    // specifier the externals didn't strip would be bundled, never resolved
    // through the import map.
    for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
      expect(matchesHostExternal(specifier)).toBe(true);
    }
  });

  it("serves exactly the public subpaths @daintreehq/tour exports", () => {
    // A subpath the tour package publishes but the host does not serve would
    // fail the plugin build; one the host serves but the package does not
    // export is a facade nobody can type against.
    const tourPackage = JSON.parse(
      readFileSync(new URL("../../../tour/package.json", import.meta.url), "utf8")
    ) as { exports: Record<string, unknown> };
    const published = Object.keys(tourPackage.exports)
      .map((subpath) =>
        subpath === "." ? "@daintreehq/tour" : `@daintreehq/tour/${subpath.slice(2)}`
      )
      .sort();
    const served = HOST_IMPORTMAP_SPECIFIERS.filter((s) => s.startsWith("@daintreehq/tour")).sort();
    expect(served).toEqual(published);
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

  it("throws on a React or tour subpath the host import map does not serve", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    expect(() => resolveId("react-dom/server")).toThrow(/react-dom\/server/);
    expect(() => resolveId("react/compiler-runtime")).toThrow(/import map/);
    expect(() => resolveId("@daintreehq/tour/internal")).toThrow(/@daintreehq\/tour\/internal/);
  });

  it("allows every host-served specifier through (returns null to externalize)", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    for (const specifier of HOST_IMPORTMAP_SPECIFIERS) {
      expect(resolveId(specifier)).toBeNull();
    }
  });

  it("ignores specifiers the host does not own", () => {
    const resolveId = resolveIdOf(daintreePlugin());
    expect(resolveId("react-router")).toBeNull();
    expect(resolveId("@daintreehq/tour-extra")).toBeNull();
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

  it("does not externalize React or the tour (node code has no host import map)", () => {
    const external = nodeConfig(daintreePlugin({ target: "node" })).build.rollupOptions.external;
    for (const re of [...reactExternals, ...tourExternals]) {
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
