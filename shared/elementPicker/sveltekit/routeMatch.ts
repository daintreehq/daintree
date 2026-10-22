import type { RouteNode } from "../protocol.js";

/**
 * The route a URL path is served by, read against the route templates the
 * project model lists. The running app's router can't be asked from here, so
 * this follows SvelteKit's own (2.x `utils/routing.js` and
 * `create_manifest_data/sort.js`): the same pattern for each route id, tried in
 * the same order. Where Kit would run a param matcher — code in the user's app —
 * it answers "unknown" rather than guess which route wins.
 */
export function matchRoute(routes: RouteNode[], pathname: string, basePath = ""): RouteNode | null {
  const path = withoutBase(decodePathname(pathname), basePath);
  if (path === null) return null;
  // Endpoints stay in: a `+server.ts` that wins the URL serves it, and the
  // page a fallback template would name is not what the user is looking at.
  for (const route of sortRoutes(routes)) {
    if (!patternFor(route.routeId).test(path)) continue;
    // A matcher (`[id=int]`) can refuse this route and hand the URL to the next.
    if (/\[[^\]]*=\w+\]/.test(route.routeId)) return null;
    return route.endpointOnly ? null : route;
  }
  return null;
}

function decodePathname(pathname: string): string {
  try {
    return pathname.split("%25").map(decodeURI).join("%25");
  } catch {
    return pathname;
  }
}

function withoutBase(path: string, basePath: string): string | null {
  const base = basePath.replace(/\/+$/, "");
  if (base === "") return path;
  if (path === base) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) : null;
}

const PARAM = /^(\[)?(\.\.\.)?(\w+)(?:=(\w+))?(\])?$/;

function isGroup(segment: string): boolean {
  return /^\([^)]+\)$/.test(segment);
}

function routeSegments(routeId: string): string[] {
  return routeId
    .slice(1)
    .split("/")
    .filter((segment) => segment !== "" && !isGroup(segment));
}

function escape(text: string): string {
  return text
    .normalize()
    .replace(/[[\]]/g, "\\$&")
    .replace(/%/g, "%25")
    .replace(/\//g, "%2[Ff]")
    .replace(/\?/g, "%3[Ff]")
    .replace(/#/g, "%23")
    .replace(/[.*+?^${}()|\\]/g, "\\$&");
}

const patterns = new Map<string, RegExp>();

function patternFor(routeId: string): RegExp {
  const cached = patterns.get(routeId);
  if (cached) return cached;
  const segments = routeSegments(routeId);
  const pattern =
    segments.length === 0
      ? /^\/$/
      : new RegExp(
          `^${segments
            .map((segment) => {
              if (/^\[\.\.\.(\w+)(?:=(\w+))?\]$/.test(segment)) return "(?:/([^]*))?";
              if (/^\[\[(\w+)(?:=(\w+))?\]\]$/.test(segment)) return "(?:/([^/]+))?";
              const parts = segment.split(/\[(.+?)\](?!\])/);
              return (
                "/" +
                parts
                  .map((content, index) => {
                    if (index % 2 === 0) return escape(content);
                    if (content.startsWith("x+")) {
                      return escape(String.fromCharCode(Number.parseInt(content.slice(2), 16)));
                    }
                    if (content.startsWith("u+")) {
                      return escape(
                        String.fromCharCode(
                          ...content
                            .slice(2)
                            .split("-")
                            .map((code) => Number.parseInt(code, 16))
                        )
                      );
                    }
                    const match = PARAM.exec(content);
                    if (!match) return escape(`[${content}]`);
                    const [, optional, rest] = match;
                    return rest ? "([^]*?)" : optional ? "([^/]*)?" : "([^/]+?)";
                  })
                  .join("")
              );
            })
            .join("")}/?$`
        );
  patterns.set(routeId, pattern);
  return pattern;
}

interface Part {
  type: "static" | "required" | "optional" | "rest";
  content: string;
  matched: boolean;
}

const EMPTY: Part = { type: "static", content: "", matched: false };

function splitParts(segment: string): Part[] {
  const parts: Part[] = [];
  let index = 0;
  while (index <= segment.length) {
    const start = segment.indexOf("[", index);
    if (start === -1) {
      parts.push({ type: "static", content: segment.slice(index), matched: false });
      break;
    }
    parts.push({ type: "static", content: segment.slice(index, start), matched: false });
    const type =
      segment[start + 1] === "[" ? "optional" : segment[start + 1] === "." ? "rest" : "required";
    const delimiter = type === "optional" ? "]]" : "]";
    const end = segment.indexOf(delimiter, start);
    if (end === -1) {
      parts.push({ type: "static", content: segment.slice(start), matched: false });
      break;
    }
    const content = segment.slice(start, (index = end + delimiter.length));
    parts.push({ type, content, matched: content.includes("=") });
  }
  return parts;
}

function sortSegments(routeId: string): Part[][] {
  return routeSegments(
    // Optional params only count at the very end (or before trailing groups).
    routeId.replace(/\[\[[^\]]+\]\](?!(?:\/\([^/]+\))*$)/g, "")
  )
    .filter(Boolean)
    .map(splitParts);
}

function sortStatic(a: string, b: string): number {
  if (a === b) return 0;
  for (let index = 0; ; index += 1) {
    const charA = a[index];
    const charB = b[index];
    if (charA !== charB) {
      if (charA === undefined) return +1;
      if (charB === undefined) return -1;
      return charA < charB ? -1 : +1;
    }
  }
}

function compareRoutes(routeA: RouteNode, routeB: RouteNode): number {
  const segmentsA = sortSegments(routeA.routeId);
  const segmentsB = sortSegments(routeB.routeId);
  for (let i = 0; i < Math.max(segmentsA.length, segmentsB.length); i += 1) {
    const segmentA = segmentsA[i] ?? [EMPTY];
    const segmentB = segmentsB[i] ?? [EMPTY];
    for (let j = 0; j < Math.max(segmentA.length, segmentB.length); j += 1) {
      const a = segmentA[j];
      const b = segmentB[j];
      if (j % 2 === 1) {
        if (!a) return -1;
        if (!b) return +1;
        const nextA = segmentA[j + 1]?.content || segmentsA[i + 1]?.[0]?.content;
        const nextB = segmentB[j + 1]?.content || segmentsB[i + 1]?.[0]?.content;
        if (a.type === "rest" && b.type === "rest") {
          if (nextA && nextB) continue;
          if (nextA) return -1;
          if (nextB) return +1;
        }
        if (a.type === "rest") return nextA && !nextB ? -1 : +1;
        if (b.type === "rest") return nextB && !nextA ? +1 : -1;
        if (a.matched !== b.matched) return a.matched ? -1 : +1;
        if (a.type !== b.type) {
          if (a.type === "required") return -1;
          if (b.type === "required") return +1;
        }
      } else if ((a ?? EMPTY).content !== (b ?? EMPTY).content) {
        if ((a ?? EMPTY) === EMPTY) return -1;
        if ((b ?? EMPTY) === EMPTY) return +1;
        return sortStatic(a!.content, b!.content);
      }
    }
  }
  return routeA.routeId < routeB.routeId ? +1 : -1;
}

function sortRoutes(routes: RouteNode[]): RouteNode[] {
  return [...routes].sort(compareRoutes);
}
