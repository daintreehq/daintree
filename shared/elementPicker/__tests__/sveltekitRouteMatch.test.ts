import { describe, expect, it } from "vitest";
import { matchRoute } from "../project/routeMatch.js";
import type { RouteNode } from "../protocol.js";

function route(routeId: string, extra: Partial<RouteNode> = {}): RouteNode {
  return {
    routeId,
    pageFile: `src/routes${routeId === "/" ? "" : routeId}/+page.svelte`,
    layoutFiles: [],
    dynamic: routeId.includes("["),
    endpointOnly: false,
    ...extra,
  };
}

const ROUTES = [
  route("/"),
  route("/about"),
  route("/blog/[slug]"),
  route("/blog/new"),
  route("/docs/[...path]"),
  route("/[[lang]]/pricing"),
  route("/shop/[category]-[item]"),
  route("/api/items", { endpointOnly: true, pageFile: null }),
  route("/a[x+2f]b"),
];

const id = (pathname: string) => matchRoute(ROUTES, pathname)?.routeId ?? null;

describe("matchRoute", () => {
  it("matches the root and static routes, with or without a trailing slash", () => {
    expect(id("/")).toBe("/");
    expect(id("/about")).toBe("/about");
    expect(id("/about/")).toBe("/about");
  });

  it("prefers a static segment over a parameter", () => {
    expect(id("/blog/new")).toBe("/blog/new");
    expect(id("/blog/hello-world")).toBe("/blog/[slug]");
  });

  it("matches rest, optional and compound parameters", () => {
    expect(id("/docs")).toBe("/docs/[...path]");
    expect(id("/docs/a/b/c")).toBe("/docs/[...path]");
    expect(id("/pricing")).toBe("/[[lang]]/pricing");
    expect(id("/fr/pricing")).toBe("/[[lang]]/pricing");
    expect(id("/shop/shoes-boot")).toBe("/shop/[category]-[item]");
  });

  it("reads escaped characters as SvelteKit does: encoded in the browser's path", () => {
    expect(id("/a%2Fb")).toBe("/a[x+2f]b");
    expect(id("/a%2fb")).toBe("/a[x+2f]b");
    expect(id("/a/b")).toBe(null);
  });

  it("ranks an exact route over an empty rest or optional suffix, in either order", () => {
    const routes = [route("/docs/[...path]"), route("/docs"), route("/[[lang]]"), route("/")];
    expect(matchRoute(routes, "/docs")?.routeId).toBe("/docs");
    expect(matchRoute([...routes].reverse(), "/docs")?.routeId).toBe("/docs");
    expect(matchRoute(routes, "/")?.routeId).toBe("/");
    expect(matchRoute([...routes].reverse(), "/")?.routeId).toBe("/");
    expect(matchRoute(routes, "/fr")?.routeId).toBe("/[[lang]]");
  });

  it("matches a rest param inside a compound segment across slashes", () => {
    expect(matchRoute([route("/files/[...path].json")], "/files/a/b.json")?.routeId).toBe(
      "/files/[...path].json"
    );
  });

  it("won't pick a route whose param matcher would have to run", () => {
    const routes = [route("/[id=int]"), route("/[slug]")];
    expect(matchRoute(routes, "/hello")).toBe(null);
    expect(matchRoute([route("/about"), ...routes], "/about")?.routeId).toBe("/about");
  });

  it("names no page when an endpoint wins the URL over a page template", () => {
    const routes = [route("/[slug]"), route("/report", { endpointOnly: true, pageFile: null })];
    expect(matchRoute(routes, "/report")).toBe(null);
    expect(matchRoute(routes, "/other")?.routeId).toBe("/[slug]");
  });

  it("strips the configured base path, and only at a segment boundary", () => {
    expect(matchRoute(ROUTES, "/app/about", "/app")?.routeId).toBe("/about");
    expect(matchRoute(ROUTES, "/app", "/app")?.routeId).toBe("/");
    expect(matchRoute(ROUTES, "/application/about", "/app")).toBe(null);
  });

  it("names no page for an endpoint or an unknown path", () => {
    expect(id("/api/items")).toBe(null);
    expect(id("/nowhere/at/all")).toBe(null);
  });
});
