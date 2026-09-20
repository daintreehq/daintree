import { describe, expect, it } from "vitest";
import type { RouteNode } from "../protocol.js";
import {
  analyzeRoutes,
  buildRouteTree,
  classifyRouteFile,
  isDynamicSegment,
  resolveBasePath,
  resolveRoutesDirectory,
  routeIdFromSegments,
} from "../project/routes.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../project/__testing__/fixtureReader.js";

const reader = createFixtureReader();

async function routesOf(fixture: string): Promise<RouteNode[]> {
  const worktree = fixtureWorktree(fixture);
  const routesDirectory = await resolveRoutesDirectory(reader, worktree);
  return buildRouteTree(reader, {
    appRoot: worktree,
    worktreeRoot: worktree,
    routesDir: routesDirectory.path,
  });
}

function byId(routes: RouteNode[], routeId: string): RouteNode {
  const match = routes.find((route) => route.routeId === routeId);
  if (!match) throw new Error(`no route ${routeId} in ${routes.map((r) => r.routeId).join(", ")}`);
  return match;
}

describe("classifyRouteFile", () => {
  it("distinguishes the roles of the + files", () => {
    expect(classifyRouteFile("+page.svelte")?.kind).toBe("page");
    expect(classifyRouteFile("+page.ts")?.kind).toBe("page-load");
    expect(classifyRouteFile("+page.js")?.kind).toBe("page-load");
    expect(classifyRouteFile("+page.server.ts")?.kind).toBe("page-server");
    expect(classifyRouteFile("+layout.svelte")?.kind).toBe("layout");
    expect(classifyRouteFile("+layout.server.js")?.kind).toBe("layout-server");
    expect(classifyRouteFile("+server.ts")?.kind).toBe("endpoint");
    expect(classifyRouteFile("+error.svelte")?.kind).toBe("error");
  });

  it("reads the layout-reset target off a page or layout filename", () => {
    expect(classifyRouteFile("+page@.svelte")).toEqual({ kind: "page", layoutReset: "" });
    expect(classifyRouteFile("+layout@(app).svelte")).toEqual({
      kind: "layout",
      layoutReset: "(app)",
    });
    expect(classifyRouteFile("+page.svelte")?.layoutReset).toBeNull();
  });

  it("rejects files that only look like route files", () => {
    expect(classifyRouteFile("Card.svelte")).toBeNull();
    expect(classifyRouteFile("+page.test.ts")).toBeNull();
    expect(classifyRouteFile("+server.svelte")).toBeNull();
    expect(classifyRouteFile("+page.server.svelte")).toBeNull();
    expect(classifyRouteFile("+page")).toBeNull();
    expect(classifyRouteFile("page.svelte")).toBeNull();
    expect(classifyRouteFile("+layout.server@(app).ts")).toBeNull();
  });
});

describe("routeIdFromSegments", () => {
  it("drops group directories and keeps parameter syntax intact", () => {
    expect(routeIdFromSegments([])).toBe("/");
    expect(routeIdFromSegments(["(marketing)"])).toBe("/");
    expect(routeIdFromSegments(["(app)", "settings", "billing"])).toBe("/settings/billing");
    expect(routeIdFromSegments(["blog", "[slug]"])).toBe("/blog/[slug]");
    expect(routeIdFromSegments(["(a)", "[[lang]]", "(b)", "docs", "[...rest]"])).toBe(
      "/[[lang]]/docs/[...rest]"
    );
  });
});

describe("buildRouteTree", () => {
  it("lists exactly the navigable pages and endpoints", async () => {
    const routes = await routesOf("grouped");

    expect(routes.map((route) => route.routeId)).toEqual([
      "/",
      "/[[lang]]/hello",
      "/about",
      "/api/health",
      "/blog",
      "/blog/[slug]",
      "/build",
      "/dashboard",
      "/docs/[...rest]",
      "/go",
      "/orphan",
      "/pricing",
      "/settings",
      "/statements/monthly",
    ]);
  });

  it("never puts a route group in a route id", async () => {
    const routes = await routesOf("grouped");

    for (const route of routes) {
      expect(route.routeId).not.toMatch(/[()]/);
    }
    expect(byId(routes, "/about").pageFile).toContain("(marketing)");
  });

  it("omits a directory that only carries structure", async () => {
    const routes = await routesOf("grouped");

    expect(routes.some((route) => route.routeId === "/internal")).toBe(false);
  });

  it("does not mistake an encoded character for a parameter", () => {
    expect(isDynamicSegment("[x+2f]")).toBe(false);
    expect(isDynamicSegment("smileys[u+1f600]")).toBe(false);
    expect(isDynamicSegment("[slug]")).toBe(true);
    expect(isDynamicSegment("[x+2f][slug]")).toBe(true);
  });

  it("marks a route dynamic when any segment carries a parameter", async () => {
    const routes = await routesOf("grouped");

    expect(byId(routes, "/blog/[slug]").dynamic).toBe(true);
    expect(byId(routes, "/docs/[...rest]").dynamic).toBe(true);
    expect(byId(routes, "/[[lang]]/hello").dynamic).toBe(true);
    expect(byId(routes, "/blog").dynamic).toBe(false);
    expect(byId(routes, "/about").dynamic).toBe(false);
  });

  it("treats a directory with only +server as an endpoint, not a page", async () => {
    const routes = await routesOf("grouped");
    const endpoint = byId(routes, "/api/health");

    expect(endpoint.endpointOnly).toBe(true);
    expect(endpoint.pageFile).toBeNull();
    expect(endpoint.layoutFiles).toEqual([]);
    expect(routes.filter((route) => route.endpointOnly)).toHaveLength(1);
  });

  it("does not make a page an endpoint just because it has a +page.server load", async () => {
    const routes = await routesOf("grouped");

    expect(byId(routes, "/pricing").endpointOnly).toBe(false);
    expect(byId(routes, "/pricing").pageFile).not.toBeNull();
  });

  it("attaches the inherited layout chain outermost first", async () => {
    const routes = await routesOf("grouped");

    expect(byId(routes, "/about").layoutFiles).toEqual([
      "src/routes/+layout.svelte",
      "src/routes/(marketing)/+layout.svelte",
    ]);
    expect(byId(routes, "/dashboard").layoutFiles).toEqual([
      "src/routes/+layout.svelte",
      "src/routes/(app)/+layout.svelte",
    ]);
    expect(byId(routes, "/").layoutFiles).toEqual(["src/routes/+layout.svelte"]);
  });

  it("honours a layout reset on the page filename", async () => {
    const routes = await routesOf("grouped");
    const settings = byId(routes, "/settings");

    expect(settings.pageFile).toContain("+page@.svelte");
    expect(settings.layoutFiles).toEqual(["src/routes/+layout.svelte"]);
  });

  it("keeps a page that has no component", async () => {
    const routes = await routesOf("grouped");
    const redirectRoute = byId(routes, "/go");

    // `+page.server.ts` alone is a navigable route that answers with a redirect.
    expect(redirectRoute.pageFile).toBeNull();
    expect(redirectRoute.endpointOnly).toBe(false);
    expect(redirectRoute.layoutFiles).toEqual(["src/routes/+layout.svelte"]);
  });

  it("does not drop a route whose directory is named like build output", async () => {
    const routes = await routesOf("grouped");

    expect(byId(routes, "/build").pageFile).toContain("routes/build/");
  });

  it("resolves a named reset onto a segment whose name contains dots", async () => {
    const routes = await routesOf("grouped");

    expect(byId(routes, "/statements/monthly").layoutFiles).toEqual([
      "src/routes/+layout.svelte",
      "src/routes/(app.v2)/+layout.svelte",
      "src/routes/(app.v2)/statements/+layout@(app.v2).svelte",
    ]);
  });

  it("reports a reset that names no ancestor instead of inventing a chain", async () => {
    const worktree = fixtureWorktree("grouped");
    const { routes, diagnostics } = await analyzeRoutes(reader, {
      appRoot: worktree,
      worktreeRoot: worktree,
      routesDir: `${worktree}/src/routes`,
    });

    expect(byId(routes, "/orphan").layoutFiles).toEqual([]);
    const unresolved = diagnostics.filter((d) => d.code === "unresolved-layout-reset");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.files[0]).toContain("orphan");
  });

  it("flags two groups that spell the same URL", async () => {
    const page = "<h1>About</h1>";
    const memory = createMemoryReader({
      "/repo/src/routes/(a)/about/+page.svelte": page,
      "/repo/src/routes/(b)/about/+page.svelte": page,
    });

    const { routes, diagnostics } = await analyzeRoutes(memory, {
      appRoot: "/repo",
      worktreeRoot: "/repo",
      routesDir: "/repo/src/routes",
    });

    expect(routes).toHaveLength(2);
    const duplicate = diagnostics.find((d) => d.code === "duplicate-route-id");
    expect(duplicate?.files).toHaveLength(2);
  });

  it("says when the walk stopped early rather than reporting a partial tree as whole", async () => {
    const memory = createMemoryReader({
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
      "/repo/src/routes/a/b/c/+page.svelte": "<h1>Deep</h1>",
    });

    const { routes, diagnostics } = await analyzeRoutes(memory, {
      appRoot: "/repo",
      worktreeRoot: "/repo",
      routesDir: "/repo/src/routes",
      maxDepth: 1,
    });

    expect(routes.map((route) => route.routeId)).toEqual(["/"]);
    expect(diagnostics.some((d) => d.code === "traversal-truncated")).toBe(true);
  });

  it("follows a routes subtree reached through a symlink", async () => {
    const memory = createMemoryReader({
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
      "/repo/src/routes/linked/+page.svelte": "<h1>Linked</h1>",
    });
    // A plain readdir reports a symlinked directory as neither file nor
    // directory — the shape production `host.fs` returns without `detail`.
    const opaque = {
      ...memory,
      readdir: async (path: string) =>
        (await memory.readdir(path)).map((entry) =>
          entry.name === "linked" ? { ...entry, isDirectory: false, isFile: false } : entry
        ),
    };

    const routes = await buildRouteTree(opaque, {
      appRoot: "/repo",
      worktreeRoot: "/repo",
      routesDir: "/repo/src/routes",
    });

    expect(routes.map((route) => route.routeId)).toEqual(["/", "/linked"]);
  });

  it("reads the configured routes directory instead of assuming src/routes", async () => {
    const worktree = fixtureWorktree("custom-routes");
    const routesDirectory = await resolveRoutesDirectory(reader, worktree);

    expect(routesDirectory.source).toBe("svelte.config");
    expect(routesDirectory.path.endsWith("src/pages")).toBe(true);

    const routes = await routesOf("custom-routes");
    expect(routes.map((route) => route.routeId)).toEqual(["/", "/contact"]);
    for (const route of routes) {
      expect(route.pageFile).toContain("src/pages/");
    }
  });

  it("refuses to claim it read a routes path the config only computes", async () => {
    const cases = [
      `export default { kit: { files: { routes: "src/" + "pages" } } };`,
      "export default { kit: { files: { routes: `src/${folder}` } } };",
      `export default { kit: { files: { routes: resolve("src/pages") } } };`,
    ];

    for (const config of cases) {
      const memory = createMemoryReader({ "/repo/svelte.config.js": config });
      const resolved = await resolveRoutesDirectory(memory, "/repo");

      expect(resolved.source).toBe("unresolved");
      expect(resolved.path).toBe("/repo/src/routes");
    }
  });

  it("does not read a routes key that is not inside kit.files", async () => {
    const memory = createMemoryReader({
      "/repo/svelte.config.js": `export default { somethingElse: { files: { routes: "wrong" } } };`,
    });

    const resolved = await resolveRoutesDirectory(memory, "/repo");

    expect(resolved.source).toBe("default");
    expect(resolved.path).toBe("/repo/src/routes");
  });

  it("falls back to src/routes when there is no config to read", async () => {
    const routesDirectory = await resolveRoutesDirectory(reader, fixtureWorktree("plain"));

    expect(routesDirectory.source).toBe("default");
    expect(routesDirectory.path.endsWith("src/routes")).toBe(true);
  });

  it("returns no routes rather than throwing when the routes directory is absent", async () => {
    const worktree = fixtureWorktree("plain");

    const routes = await buildRouteTree(reader, {
      appRoot: worktree,
      worktreeRoot: worktree,
      routesDir: `${worktree}/src/nowhere`,
    });

    expect(routes).toEqual([]);
  });
});

describe("route data files", () => {
  it("lists the load modules feeding a page, outermost first, and drops those a reset leaves", async () => {
    const memory = createMemoryReader({
      "/repo/src/routes/+layout.svelte": "<slot />",
      "/repo/src/routes/+layout.server.ts": "export const load = () => ({});",
      "/repo/src/routes/shop/+layout.ts": "export const load = () => ({});",
      "/repo/src/routes/shop/[item]/+page.svelte": "<h1>Item</h1>",
      "/repo/src/routes/shop/[item]/+page.ts": "export const load = () => ({});",
      "/repo/src/routes/shop/[item]/+page.server.ts": "export const load = () => ({});",
      "/repo/src/routes/admin/+layout.svelte": "<slot />",
      "/repo/src/routes/admin/+layout.ts": "export const load = () => ({});",
      "/repo/src/routes/admin/login/+page@.svelte": "<h1>Login</h1>",
    });
    const { routes } = await analyzeRoutes(memory, {
      appRoot: "/repo",
      worktreeRoot: "/repo",
      routesDir: "/repo/src/routes",
    });

    expect(byId(routes, "/shop/[item]").dataFiles).toEqual([
      "src/routes/+layout.server.ts",
      "src/routes/shop/+layout.ts",
      "src/routes/shop/[item]/+page.server.ts",
      "src/routes/shop/[item]/+page.ts",
    ]);
    // `+page@` resets to the root layout: the admin layout's load no longer runs.
    expect(byId(routes, "/admin/login").dataFiles).toEqual(["src/routes/+layout.server.ts"]);
  });

  it("drops a load-only layout that a reset skips", async () => {
    const memory = createMemoryReader({
      "/repo/src/routes/+layout.server.ts": "export const load = () => ({});",
      "/repo/src/routes/admin/+layout.server.ts": "export const load = () => ({});",
      "/repo/src/routes/admin/login/+page@.svelte": "<h1>Login</h1>",
      "/repo/src/routes/admin/users/+page.svelte": "<h1>Users</h1>",
    });
    const { routes } = await analyzeRoutes(memory, {
      appRoot: "/repo",
      worktreeRoot: "/repo",
      routesDir: "/repo/src/routes",
    });
    expect(byId(routes, "/admin/login").dataFiles).toEqual(["src/routes/+layout.server.ts"]);
    expect(byId(routes, "/admin/users").dataFiles).toEqual([
      "src/routes/+layout.server.ts",
      "src/routes/admin/+layout.server.ts",
    ]);
  });
});

describe("resolveBasePath", () => {
  it("reads a literal base, says none when unset, and refuses a computed one", async () => {
    const literal = createMemoryReader({
      "/a/svelte.config.js": "export default { kit: { paths: { base: '/docs' } } };",
    });
    const unset = createMemoryReader({ "/b/svelte.config.js": "export default { kit: {} };" });
    const computed = createMemoryReader({
      "/c/svelte.config.js": "export default { kit: { paths: { base: process.env.BASE_PATH } } };",
    });
    expect(await resolveBasePath(literal, "/a")).toBe("/docs");
    expect(await resolveBasePath(unset, "/b")).toBe("");
    expect(await resolveBasePath(computed, "/c")).toBe(null);
    const indirect = createMemoryReader({
      "/d/svelte.config.js": "const paths = { base: '/x' };\nexport default { kit: { paths } };",
    });
    expect(await resolveBasePath(indirect, "/d")).toBe(null);
  });
});

describe("resolveRoutesDirectory against configs that are not a single literal", () => {
  const resolve = (files: Record<string, string>) =>
    resolveRoutesDirectory(createMemoryReader(files), "/repo");

  it("will not call src/routes the default when the exported config only references the value", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js":
        "const files = { routes: 'src/pages' };\nexport default { kit: { files } };",
    });

    expect(resolved.source).toBe("unresolved");
    expect(resolved.path).toBe("/repo/src/routes");
  });

  it("does not answer from a kit object the module never exports", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js":
        "const other = { kit: {}, files: { routes: 'wrong' } };\nexport default { kit: {} };",
    });

    expect(resolved.source).toBe("default");
    expect(resolved.path).toBe("/repo/src/routes");
  });

  it("treats an imported config as unknown rather than as no config at all", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": "import config from './config.js';\nexport default config;",
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("refuses a config whose kit key a later spread could overwrite", async () => {
    const overwritten = await resolve({
      "/repo/svelte.config.js":
        "export default { kit: { files: { routes: 'src/pages' } }, ...base };",
    });
    // A spread the explicit key comes after is one the explicit key wins.
    const overridden = await resolve({
      "/repo/svelte.config.js":
        "export default { ...base, kit: { files: { routes: 'src/pages' } } };",
    });

    expect(overwritten.source).toBe("unresolved");
    expect(overridden.path).toBe("/repo/src/pages");
  });

  it("reads through an imported defineConfig wrapper and past a satisfies clause", async () => {
    const wrapped = await resolve({
      "/repo/svelte.config.js":
        "import { defineConfig } from 'vite';\nexport default defineConfig({ kit: { files: { routes: 'src/pages' } } });",
    });
    const asserted = await resolve({
      "/repo/svelte.config.js":
        "export default { kit: { files: { routes: 'src/pages' } } } satisfies Config;",
    });

    // A local `function defineConfig(c) { return other; }` is transparent in
    // name only, so an unimported wrapper is not read through.
    const shadowed = await resolve({
      "/repo/svelte.config.js":
        "function defineConfig(c) { return real; }\nexport default defineConfig({ kit: { files: { routes: 'src/pages' } } });",
    });

    expect([wrapped.source, asserted.source]).toEqual(["svelte.config", "svelte.config"]);
    expect([wrapped.path, asserted.path]).toEqual(["/repo/src/pages", "/repo/src/pages"]);
    expect(shadowed.source).toBe("unresolved");
  });

  it("is not fooled by braces inside strings, regex literals or a later nested kit key", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": [
        "const note = 'kit: { files: { routes: \"decoy\" } }';",
        "const strip = /[{}]+/g;",
        "export default {",
        "  compilerOptions: { runes: true, nested: { deep: { kit: { files: { routes: 'nope' } } } } },",
        "  kit: { files: { routes: 'src/pages' } },",
        "};",
      ].join("\n"),
    });

    expect(resolved.source).toBe("svelte.config");
    expect(resolved.path).toBe("/repo/src/pages");
  });

  it("refuses an object that is only the first operand of the exported expression", async () => {
    const ternary = await resolve({
      "/repo/svelte.config.js":
        'export default {} ? { kit: { files: { routes: "src/pages" } } } : {};',
    });
    const conjunction = await resolve({
      "/repo/svelte.config.js":
        "import { defineConfig } from 'vite';\nexport default defineConfig({ kit: { files: { routes: 'src/pages' } } }) && other;",
    });

    expect([ternary.source, conjunction.source]).toEqual(["unresolved", "unresolved"]);
  });

  it("refuses a duplicate key spelled as an escape, which a raw comparison would miss", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js":
        'export default { kit: { files: { routes: "src/wrong", "\\u0072outes": "src/pages" } } };',
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("keeps a configured path exactly as written", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": 'export default { kit: { files: { routes: " src/pages " } } };',
    });

    // Trimming would name a directory the config does not.
    expect(resolved.path).toBe("/repo/ src/pages ");
  });

  it("reads a CommonJS config, and refuses one that assigns its exports piecemeal", async () => {
    // `svelte.config.js` in a package that is not `"type": "module"`.
    const whole = await resolve({
      "/repo/svelte.config.js": "module.exports = { kit: { files: { routes: 'src/pages' } } };",
    });
    const piecemeal = await resolve({
      "/repo/svelte.config.js": "module.exports.kit = { files: { routes: 'src/pages' } };",
    });
    const mutated = await resolve({
      "/repo/svelte.config.js":
        "module.exports = { kit: { files: { routes: 'src/wrong' } } };\nmodule.exports.kit.files.routes = 'src/pages';",
    });
    const shadowed = await resolve({
      "/repo/svelte.config.js":
        "function wrap(module) { module.exports = { kit: { files: { routes: 'src/wrong' } } }; }",
    });

    expect([whole.source, whole.path]).toEqual(["svelte.config", "/repo/src/pages"]);
    expect([piecemeal.source, mutated.source, shadowed.source]).toEqual([
      "unresolved",
      "unresolved",
      "unresolved",
    ]);
  });

  it("will not answer from a config spelling SvelteKit does not load", async () => {
    // Kit looks for `svelte.config.js` and `svelte.config.ts`. A `.mjs` or
    // `.cjs` beside them may configure the app or may be dead weight, and which
    // it is depends on a loader we do not run.
    const mjs = await resolve({
      "/repo/svelte.config.mjs": "export default { kit: { files: { routes: 'src/pages' } } };",
    });
    const alongside = await resolve({
      "/repo/svelte.config.cjs": "module.exports = { kit: { files: { routes: 'src/wrong' } } };",
      "/repo/svelte.config.js": "export default { kit: { files: { routes: 'src/pages' } } };",
    });

    expect(mjs.source).toBe("unresolved");
    // The file Kit does load answers, and the other is not consulted.
    expect([alongside.source, alongside.path]).toEqual(["svelte.config", "/repo/src/pages"]);
  });

  it("does not report a default for a file it lost track of", async () => {
    // An unterminated template: past it, code and text are indistinguishable.
    const resolved = await resolve({
      "/repo/svelte.config.js":
        "const note = `unclosed;\nexport default { kit: { files: { routes: 'src/pages' } } };",
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("abandons a file whose regex literal it cannot tell from a division", async () => {
    // The regex body holds `}}};`. Read as a division, it closes the config
    // object early and leaves a shorter object that still parses — a wrong
    // answer that looks like a confident one.
    const resolved = await resolve({
      "/repo/svelte.config.js": [
        "export default {",
        "  preprocess: {",
        "    markup({ content }) {",
        "      if (content) /}}};/.test(content);",
        "      return { code: content };",
        "    }",
        "  },",
        '  kit: { files: { routes: "src/pages" } }',
        "};",
      ].join("\n"),
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("derives the routes directory from files.src rather than assuming src/routes", async () => {
    const moved = await resolve({
      "/repo/svelte.config.js": 'export default { kit: { files: { src: "app" } } };',
    });
    const computed = await resolve({
      "/repo/svelte.config.js": "export default { kit: { files: { src: dir } } };",
    });

    expect([moved.source, moved.path]).toEqual(["svelte.config", "/repo/app/routes"]);
    expect(computed.source).toBe("unresolved");
  });

  it("refuses a CommonJS export that is conditional, reassigned or passed on", async () => {
    const conditional = await resolve({
      "/repo/svelte.config.js":
        'if (false)\n  module.exports = { kit: { files: { routes: "src/wrong" } } };',
    });
    const assigned = await resolve({
      "/repo/svelte.config.js":
        'module.exports = { kit: { files: { routes: "src/wrong" } } };\nObject.assign(module.exports, { kit: { files: { routes: "src/actual" } } });',
    });
    const bracketed = await resolve({
      "/repo/svelte.config.js": 'module["exports"] = { kit: { files: { routes: "src/wrong" } } };',
    });

    expect([conditional.source, assigned.source, bracketed.source]).toEqual([
      "unresolved",
      "unresolved",
      "unresolved",
    ]);
  });

  it("keeps a line comment and a regex apart, whichever spelling they take", async () => {
    // `/[//]/` is a regex whose body opens with a comment marker, and a
    // terminator that is not LF still ends a comment. Losing either takes the
    // mutation on the next line out of the file before anything reads it.
    const regexBody = await resolve({
      "/repo/svelte.config.js":
        'module.exports = { kit: { files: { routes: "src/wrong" } } };\nconst slash = /[//]/; module.exports.kit.files.routes = "src/actual";',
    });
    const separator = await resolve({
      "/repo/svelte.config.js":
        "module.exports={kit:{files:{routes:'src/wrong'}}};\n// note\u2028module.exports.kit.files.routes='src/actual';",
    });

    expect([regexBody.source, separator.source]).toEqual(["unresolved", "unresolved"]);
  });

  it("treats a slash after ++ or a keyword-named property as a division it cannot risk", async () => {
    const postfix = await resolve({
      "/repo/svelte.config.js":
        'module.exports = {kit:{files:{routes:"src/wrong"}}};\nlet n = 1;\nconst ratio = n++ / 2; module.exports.kit.files.routes = "actual";',
    });
    const property = await resolve({
      "/repo/svelte.config.js":
        'module.exports = {kit:{files:{routes:"src/wrong"}}};\nconst box = { return: 4 };\nconst r = box.return / 2; module.exports.kit.files.routes = "actual";',
    });

    expect([postfix.source, property.source]).toEqual(["unresolved", "unresolved"]);
  });

  it("refuses a wrapper authorised by a require the file defines itself", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": [
        'function require(_) { return { defineConfig: () => ({ kit: { files: { routes: "src/actual" } } }) }; }',
        'const { defineConfig } = require("vite");',
        'export default defineConfig({ kit: { files: { routes: "src/wrong" } } });',
      ].join("\n"),
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("resolves a drive-letter path against the app root on a platform that has no drives", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": 'export default { kit: { files: { routes: "C:/routes" } } };',
    });

    // `C:` is an ordinary directory name here, which is what path.resolve does.
    expect(resolved.path).toBe("/repo/C:/routes");
  });

  it("knows a regex can follow any reserved word, not just the common few", async () => {
    // `void /}}};/` read as a division swallows the braces that close the
    // config object. The config here is ordinary and must simply be read.
    const resolved = await resolve({
      "/repo/svelte.config.js":
        "void /}}};x/;\nexport default { kit: { files: { routes: 'src/pages' } } };",
    });

    expect([resolved.source, resolved.path]).toEqual(["svelte.config", "/repo/src/pages"]);
  });

  it("refuses an object whose prototype could supply the key, quoted or not", async () => {
    const bare = await resolve({
      "/repo/svelte.config.js": "export default { kit: { files: { __proto__: defaults } } };",
    });
    const quoted = await resolve({
      "/repo/svelte.config.js":
        'export default { "__proto__": { kit: { files: { routes: "src/actual" } } } };',
    });

    expect([bare.source, quoted.source]).toEqual(["unresolved", "unresolved"]);
  });

  it("refuses a path a template literal breaks across lines", async () => {
    // A template normalises CRLF when it is evaluated, so the text in the file
    // is not the string the config ends up with.
    const resolved = await resolve({
      "/repo/svelte.config.js": "export default { kit: { files: { routes: `src/\r\npages` } } };",
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("does not let an aliased vite import authorise a local function of the same name", async () => {
    const resolved = await resolve({
      "/repo/svelte.config.js": [
        'import { defineConfig as viteConfig } from "vite";',
        "function defineConfig(_) {",
        '  return { kit: { files: { routes: "src/actual" } } };',
        "}",
        'export default defineConfig({ kit: { files: { routes: "src/wrong" } } });',
      ].join("\n"),
    });

    expect(resolved.source).toBe("unresolved");
  });

  it("says unresolved for a config it was not allowed to read", async () => {
    const reader = createMemoryReader({ "/repo/svelte.config.js": "" });
    const refused = {
      ...reader,
      readBoundedText: async () => ({ status: "too-large" as const }),
    };

    const resolved = await resolveRoutesDirectory(refused, "/repo");

    expect(resolved.source).toBe("unresolved");
  });
});

describe("resolveRoutesDirectory when the Vite plugin carries the config", () => {
  // The argument is only read from Kit 2.62.0 on, so every case here says which
  // Kit is installed; the version's own effect is asserted separately below.
  const CURRENT_KIT = { kitVersion: "2.70.3" };
  const KIT_IMPORT = "import { sveltekit } from '@sveltejs/kit/vite';\n";
  const viteAndSvelte = (vite: string) => ({
    "/repo/vite.config.ts": vite.includes("@sveltejs/kit/vite") ? vite : KIT_IMPORT + vite,
    "/repo/svelte.config.js": "export default { kit: { files: { routes: 'src/ignored' } } };",
  });

  it("reads the plugin argument instead of the svelte config it replaces", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          "export default { plugins: [sveltekit({ files: { routes: 'src/pages' } })] };"
        )
      ),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("vite.config");
    expect(resolved.path).toBe("/repo/src/pages");
  });

  it("reports Kit's default, not the bypassed svelte config, when the argument sets no routes", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte("export default { plugins: [sveltekit({ adapter: adapter() })] };")
      ),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("default");
    expect(resolved.path).toBe("/repo/src/routes");
  });

  it("leaves the svelte config in charge when the plugin is called bare", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(viteAndSvelte("export default { plugins: [sveltekit()] };")),
      "/repo"
    );

    expect(resolved.source).toBe("svelte.config");
    expect(resolved.path).toBe("/repo/src/ignored");
  });

  it("gives up when the Vite config never imports the plugin it must be registering", async () => {
    const elsewhere = await resolveRoutesDirectory(
      createMemoryReader({
        "/repo/vite.config.ts":
          "import { plugins } from './build/plugins.js';\nexport default { plugins };",
        "/repo/svelte.config.js": "export default { kit: { files: { routes: 'src/pages' } } };",
      }),
      "/repo",
      CURRENT_KIT
    );

    expect(elsewhere.source).toBe("unresolved");
  });

  it("follows the plugin through an import alias, and gives up on a namespace import", async () => {
    const aliased = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          "import { sveltekit as kit } from '@sveltejs/kit/vite';\nexport default { plugins: [kit({ files: { routes: 'src/pages' } })] };"
        )
      ),
      "/repo",
      CURRENT_KIT
    );
    const namespaced = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          "import * as kitVite from '@sveltejs/kit/vite';\nexport default { plugins: [kitVite.sveltekit()] };"
        )
      ),
      "/repo",
      CURRENT_KIT
    );

    expect([aliased.source, aliased.path]).toEqual(["vite.config", "/repo/src/pages"]);
    expect(namespaced.source).toBe("unresolved");
  });

  it("does not apply the bypass on a Kit that predates it, or on one it could not read", async () => {
    const files = viteAndSvelte(
      "export default { plugins: [sveltekit({ files: { routes: 'src/pages' } })] };"
    );
    const older = await resolveRoutesDirectory(createMemoryReader(files), "/repo", {
      kitVersion: "2.61.0",
    });
    const unknown = await resolveRoutesDirectory(createMemoryReader(files), "/repo");

    expect([older.source, older.path]).toEqual(["svelte.config", "/repo/src/ignored"]);
    expect(unknown.source).toBe("unresolved");
  });

  it("refuses a plugin call that is not inside the object the Vite config exports", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader({
        "/repo/vite.config.js": [
          "import { sveltekit } from '@sveltejs/kit/vite';",
          "const unused = () => sveltekit({ files: { routes: 'src/wrong' } });",
          "export { default } from './vite.actual.js';",
        ].join("\n"),
        "/repo/vite.actual.js":
          "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({ files: { routes: 'src/actual' } })] };",
        "/repo/svelte.config.js": "export default { kit: { files: { routes: 'src/old' } } };",
      }),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("unresolved");
  });

  it("withholds a reading when a build script points Vite at another config file", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader({
        ...viteAndSvelte("export default { plugins: [sveltekit()] };"),
        "/repo/package.json": JSON.stringify({
          // Quoted, because that is what a real script often looks like, and
          // the shell hands Vite the same flag either way.
          scripts: { dev: 'vite dev "--config" config/site.ts' },
        }),
      }),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("unresolved");
  });

  it("refuses a plugin handed to something else, and is not fooled by an import inside a string", async () => {
    const indirect = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          "import { sveltekit } from '@sveltejs/kit/vite';\nconst kit = sveltekit;\nconst unused = () => sveltekit({ files: { routes: 'src/wrong' } });\nexport default { plugins: [kit()] };"
        )
      ),
      "/repo",
      CURRENT_KIT
    );
    const decoyed = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          "const doc = \"import {sveltekit as fake} from '@sveltejs/kit/vite'\";\nimport { sveltekit as kit$ } from '@sveltejs/kit/vite';\nexport default { plugins: [kit$({ files: { routes: 'src/pages' } })] };"
        )
      ),
      "/repo",
      CURRENT_KIT
    );

    expect(indirect.source).toBe("unresolved");
    expect([decoyed.source, decoyed.path]).toEqual(["vite.config", "/repo/src/pages"]);
  });

  it("refuses a file that imports the plugin twice under different names", async () => {
    // Only one of the two is in the exported plugin list, and which one that is
    // needs dataflow this deliberately does not do.
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          [
            'import { sveltekit as legacy } from "@sveltejs/kit/vite";',
            'import { sveltekit as current } from "@sveltejs/kit/vite";',
            "const unused = () => legacy();",
            'export default { plugins: [current({ files: { routes: "src/actual" } })] };',
          ].join("\n")
        )
      ),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("unresolved");
  });

  it("does not take a binding from a re-export that binds nothing here", async () => {
    // `export { sveltekit } from …` passes the plugin on without naming it in
    // this file, so the local `sveltekit` is someone else's function.
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(
        viteAndSvelte(
          [
            "export { sveltekit } from '@sveltejs/kit/vite';",
            "function sveltekit(options) { return options; }",
            "export default { plugins: [sveltekit({ files: { routes: 'src/wrong' } })] };",
          ].join("\n")
        )
      ),
      "/repo",
      CURRENT_KIT
    );

    expect(resolved.source).toBe("unresolved");
  });

  it("refuses a version that is a range, and a prerelease of the release that introduced the bypass", async () => {
    const files = viteAndSvelte(
      "export default { plugins: [sveltekit({ files: { routes: 'src/pages' } })] };"
    );
    const range = await resolveRoutesDirectory(createMemoryReader(files), "/repo", {
      kitVersion: "2.61.0 || 2.70.0",
    });
    const prerelease = await resolveRoutesDirectory(createMemoryReader(files), "/repo", {
      kitVersion: "2.62.0-next.1",
    });

    expect([range.source, prerelease.source]).toEqual(["unresolved", "unresolved"]);
  });

  it("withholds a reading when the plugin argument is not a literal", async () => {
    const resolved = await resolveRoutesDirectory(
      createMemoryReader(viteAndSvelte("export default { plugins: [sveltekit(kitConfig)] };")),
      "/repo"
    );

    expect(resolved.source).toBe("unresolved");
  });
});

describe("analyzeRoutes under cancellation", () => {
  it("fails the walk when the workspace closes mid-stat instead of reporting no routes", async () => {
    const controller = new AbortController();
    const base = createMemoryReader({
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
      "/repo/src/routes/linked/+page.svelte": "<h1>Linked</h1>",
    });
    const reader = {
      ...base,
      // A symlink is neither file nor directory to `readdir`, so the walk
      // stats it — the read that was in flight when the workspace closed.
      async readdir(path: string) {
        const entries = await base.readdir(path);
        return entries.map((entry) =>
          entry.name === "linked" ? { name: entry.name, isDirectory: false, isFile: false } : entry
        );
      },
      async stat(path: string) {
        controller.abort();
        throw new Error(`workspace closed: ${path}`);
      },
    };

    await expect(
      analyzeRoutes(reader, {
        appRoot: "/repo",
        worktreeRoot: "/repo",
        routesDir: "/repo/src/routes",
        signal: controller.signal,
      })
    ).rejects.toThrow(/workspace closed/);
  });
});

describe("resolveBasePath scoped to the exported config", () => {
  it("ignores a paths object the module does not export, and reads the Vite plugin's own", async () => {
    const decoy = createMemoryReader({
      "/repo/svelte.config.js":
        "const draft = { kit: { paths: { base: '/old' } } };\nexport default { kit: {} };",
    });
    const viaVite = createMemoryReader({
      "/repo/vite.config.ts":
        "import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({ paths: { base: '/docs' } })] };",
      "/repo/svelte.config.js": "export default { kit: { paths: { base: '/old' } } };",
    });

    expect(await resolveBasePath(decoy, "/repo")).toBe("");
    expect(await resolveBasePath(viaVite, "/repo", { kitVersion: "2.70.3" })).toBe("/docs");
  });

  it("does not read a base out of a mention of paths elsewhere in the file", async () => {
    const mention = createMemoryReader({
      "/repo/svelte.config.js":
        "const paths = require('node:path');\nexport default { kit: { adapter: adapter() } };",
    });

    // The old whole-file `paths` probe turned this into "we cannot know".
    expect(await resolveBasePath(mention, "/repo")).toBe("");
  });
});
