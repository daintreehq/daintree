import { describe, expect, it } from "vitest";
import type { RouteNode } from "../protocol.js";
import {
  analyzeRoutes,
  buildRouteTree,
  classifyRouteFile,
  isDynamicSegment,
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
      "/reports/monthly",
      "/settings",
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

    expect(byId(routes, "/reports/monthly").layoutFiles).toEqual([
      "src/routes/+layout.svelte",
      "src/routes/(app.v2)/+layout.svelte",
      "src/routes/(app.v2)/reports/+layout@(app.v2).svelte",
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
