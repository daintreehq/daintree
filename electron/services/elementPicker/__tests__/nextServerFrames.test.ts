import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { transform } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type { ResolutionResult } from "../../../../shared/elementPicker/resolution.js";
import type { ResolverSourceAccess } from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { checkResolveResponse } from "../checkResponse.js";
import { nextDevServer } from "../nextDevServer.js";
import { JobSourceAccess, type SourceRoots } from "../sourceAccess.js";
import { createNextSourceMapProvider, createSourceMapProvider } from "../sourceMapFetcher.js";
import { reactResolver } from "../worker/resolvers/react.js";
import { clearDecodedMapCache } from "../worker/symbolication.js";
import { observation, request } from "./fixtures.js";

/**
 * A server component's frames, resolved through main's own source access: a
 * Turbopack server chunk and its map in the app's build output on disk, and
 * a Next.js dev server whose private map route answers for the modules only
 * it holds. Frames are the ones Flight fakes for the page, `about://React/`
 * around the server's own file, so each case says which route was asked,
 * what was read from disk, and what main let through.
 *
 * Chunks are esbuild's `jsxDEV` output of the page with a trailing map
 * reference, as Turbopack writes them; the maps' source names are the
 * shapes each bundler writes. Synthetic, like every frame here.
 */

const WORKSPACE = "ws-next";
const CHUNK = ".next/dev/server/chunks/ssr/[root-of-the-server]__page._.js";

const PAGE = [
  "export default function Page() {",
  "  return (",
  '    <section className="page">',
  '      <h1 className="title">Products</h1>',
  "    </section>",
  "  );",
  "}",
  "",
].join("\n");

interface RouteAnswer {
  status: number;
  body?: string;
}

let root: string;
let roots: SourceRoots;
let server: http.Server;
let origin: string;
let routeHits: string[];
let route: (filename: string) => RouteAnswer;
let built: { code: string; map: Record<string, unknown> };
let counter = 0;

beforeEach(async () => {
  clearDecodedMapCache();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-next-")));
  roots = { worktreePath: root, appRoot: root };
  write("app/page.tsx", PAGE);
  const out = await transform(PAGE, {
    loader: "tsx",
    jsx: "automatic",
    jsxDev: true,
    format: "esm",
    sourcemap: "external",
    sourcefile: "page.tsx",
    sourcesContent: true,
  });
  built = { code: out.code, map: JSON.parse(out.map) as Record<string, unknown> };
  routeHits = [];
  route = () => ({ status: 204 });
  server = http.createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    routeHits.push(url.pathname);
    if (url.pathname !== "/__nextjs_source-map") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const answer = route(url.searchParams.get("filename") ?? "");
    response.statusCode = answer.status;
    response.end(answer.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, contents: string): void {
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

/** The chunk on disk, naming its map the way Turbopack does: beside it, percent-encoded. */
function writeChunk(sources: string[]): void {
  const name = path.posix.basename(CHUNK);
  write(CHUNK, `${built.code}\n//# sourceMappingURL=${encodeURIComponent(name)}.map\n`);
  write(`${CHUNK}.map`, JSON.stringify({ ...built.map, sources }));
}

/** What the route answers for the chunk: the same map, its sources as Turbopack names them. */
function routeMap(sources: string[]): string {
  return JSON.stringify({ ...built.map, sources });
}

/** Where V8 reports the `nth` call starting with `call` in the chunk, as a server stack prints it. */
function at(call: string, nth = 0): { line: number; column: number } {
  let seen = 0;
  for (const [index, line] of built.code.split("\n").entries()) {
    for (let column = line.indexOf(call); column !== -1; column = line.indexOf(call, column + 1)) {
      if (seen++ === nth) return { line: index + 1, column: column + 1 };
    }
  }
  throw new Error(`no ${call}`);
}

/** The server's own name for a file, as Flight wraps it in a frame's URL: a fresh counter each time. */
function wrapped(file: string): string {
  counter += 1;
  return `about://React/Server/${encodeURI(file)}?${counter}`;
}

const chunkPath = () => path.join(root, ...CHUNK.split("/"));

function frame(
  kind: "element-creation" | "component-definition",
  file: string,
  position: { line: number; column: number },
  field = "_debugStack"
): SourceCandidate {
  counter += 1;
  return {
    kind,
    candidateId: `frame-${counter}`,
    framework: "react",
    extraction: { kind: "generated-stack-frame", field, frameIndex: 1 },
    file,
    location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...position },
  };
}

/** A pick of the page's `<h1>`, the page itself a server record with its definition frame. */
function headingPick(file: string, version: string | null): SelectionObservation {
  const base = observation("el-1", [frame("element-creation", file, at('jsxDEV("h1"'))]);
  return {
    ...base,
    tagName: "h1",
    componentChain: {
      nearestId: "page",
      components: [
        {
          componentId: "page",
          framework: "react",
          name: {
            value: "Page",
            extraction: { kind: "runtime-field", field: "_debugInfo[0].name" },
          },
          environment: "server",
          rootElementIds: [],
          rootsComplete: false,
          sourceCandidates: [
            frame(
              "component-definition",
              file,
              at('jsxDEV("section"'),
              "_debugInfo[0].debugLocation"
            ),
          ],
        },
      ],
      truncated: false,
    },
    frameworkEvidence:
      version === null
        ? []
        : [
            {
              kind: "generic",
              framework: "react",
              fields: [
                { name: "nextVersion", value: version },
                { name: "nextRouter", value: "app" },
              ],
            },
          ],
  };
}

async function resolve(observed: SelectionObservation): Promise<ResolutionResult[]> {
  const req = request(WORKSPACE, [observed]);
  const controller = new AbortController();
  const job = new JobSourceAccess({
    workspaceId: WORKSPACE,
    roots,
    budget: req.budget,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: origin,
    sourceMaps: createSourceMapProvider(),
    next: nextDevServer(req.observations),
    nextSourceMaps: createNextSourceMapProvider(),
    onRead: () => {},
  });
  const access: ResolverSourceAccess = {
    readSource: (file) => job.readSource(file),
    fetchSourceMap: (url) => job.fetchSourceMap(url),
    locateSource: ({ generatedUrl, source, sourceRoot }) =>
      job.locateSource(generatedUrl, source, sourceRoot),
    locateFile: async (reported) => job.locateFile(reported),
  };
  const response = await reactResolver.resolve(req, access, controller.signal);
  // What main would pass on, and nothing it would refuse.
  expect(
    checkResolveResponse(req, response, {
      roots,
      servedRevision: (relative) => job.servedRevision(relative),
      servedMap: (mapUrl, mapRevision) => job.servedMap(mapUrl, mapRevision),
    })
  ).toEqual(response);
  return response.outcomes[0]!.results;
}

const states = (results: ResolutionResult[]) =>
  results.map((result) => (result.state === "unavailable" ? result.reason : result.state));

function targetOf(result: ResolutionResult | undefined) {
  return result && "target" in result ? result.target : undefined;
}

describe("a Turbopack server component's frames", () => {
  it("are mapped through the route on a release it was written against, one request per file", async () => {
    writeChunk([`file://${root}/app/page.tsx`]);
    const asked: string[] = [];
    route = (filename) => {
      asked.push(filename);
      return { status: 200, body: routeMap(["turbopack:///[project]/app/page.tsx"]) };
    };
    const results = await resolve(headingPick(wrapped(`file://${chunkPath()}`), "16.0.3"));
    expect(states(results)).toEqual(["verified", "verified"]);
    expect(targetOf(results[0])).toMatchObject({
      file: { workspaceId: WORKSPACE, path: "app/page.tsx" },
      location: { line: 4 },
    });
    // The page's function itself, where it is declared.
    expect(targetOf(results[1])).toMatchObject({ location: { line: 1 } });
    // Two frames with two counters, one map: asked by the path React gave Next.js's own client.
    expect(asked).toEqual([chunkPath()]);
    const [first] = results;
    expect(first?.state === "verified" && first.sourceMap?.mapUrl).toContain(
      "/__nextjs_source-map?filename="
    );
  });

  it("are mapped from the chunk's own map on disk when the page names no release the route is known for", async () => {
    writeChunk(["../../../../../app/page.tsx"]);
    const results = await resolve(headingPick(wrapped(`file://${chunkPath()}`), "15.5.0"));
    expect(states(results)).toEqual(["verified", "verified"]);
    expect(targetOf(results[0])).toMatchObject({
      file: { path: "app/page.tsx" },
      location: { line: 4 },
    });
    const [first] = results;
    expect(first?.state === "verified" && first.sourceMap?.mapUrl).toMatch(/^file:\/\/.*\.map$/);
    expect(routeHits).toEqual([]);
  });

  it("fall back to the map on disk when the route has none, or answers with something that is not one", async () => {
    writeChunk(["../../../../../app/page.tsx"]);
    expect(states(await resolve(headingPick(wrapped(`file://${chunkPath()}`), "16.0.3")))).toEqual([
      "verified",
      "verified",
    ]);
    expect(routeHits).toEqual(["/__nextjs_source-map"]);

    clearDecodedMapCache();
    route = () => ({ status: 200, body: "<!doctype html><h1>404</h1>" });
    const results = await resolve(headingPick(wrapped(`file://${chunkPath()}`), "16.0.3"));
    expect(states(results)).toEqual(["verified", "verified"]);
    const [first] = results;
    expect(first?.state === "verified" && first.sourceMap?.mapUrl).toMatch(/^file:/);
  });

  it("are read from the server's bare path the same way", async () => {
    writeChunk(["../../../../../app/page.tsx"]);
    const results = await resolve(headingPick(wrapped(chunkPath()), null));
    expect(states(results)).toEqual(["verified", "verified"]);
    expect(routeHits).toEqual([]);
  });

  it("go unresolved, rather than anywhere else, for a chunk outside the app", async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-next-out-")));
    try {
      const results = await resolve(
        headingPick(wrapped(`file://${outside}/.next/server/chunk.js`), null)
      );
      expect(states(results)).toEqual(["outside-workspace", "outside-workspace"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a Webpack server component's frames", () => {
  const MODULE = "webpack-internal:///(rsc)/./app/page.tsx";

  it("are mapped through the route, its sources named as Webpack names them", async () => {
    route = (filename) =>
      filename === MODULE
        ? { status: 200, body: routeMap(["webpack://_N_E/./app/page.tsx?7c1e"]) }
        : { status: 204 };
    const results = await resolve(headingPick(wrapped(MODULE), "16.0.3"));
    expect(states(results)).toEqual(["verified", "verified"]);
    expect(targetOf(results[0])).toMatchObject({
      file: { path: "app/page.tsx" },
      location: { line: 4 },
    });
  });

  it("name their file and no line when the route is not asked, since Webpack's code is not the file's", async () => {
    const results = await resolve(headingPick(wrapped(MODULE), null));
    expect(results.map((result) => [result.state, targetOf(result)])).toEqual([
      ["observed", { file: { workspaceId: WORKSPACE, path: "app/page.tsx" }, location: null }],
      ["observed", { file: { workspaceId: WORKSPACE, path: "app/page.tsx" }, location: null }],
    ]);
    expect(routeHits).toEqual([]);
  });

  it("leave a module in a dependency to the library it is", async () => {
    const results = await resolve(
      headingPick(wrapped("webpack-internal:///(rsc)/./node_modules/next/dist/x.js"), "16.0.3")
    );
    expect(states(results)).toEqual(["unsupported", "unsupported"]);
    expect(routeHits).toEqual([]);
  });
});
