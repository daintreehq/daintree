import { transform } from "esbuild";
import { beforeEach, describe, expect, it } from "vitest";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import type {
  ResolveResponse,
  ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { checkResolveResponse } from "../checkResponse.js";
import { observationCandidates } from "../outcomes.js";
import { revisionOf } from "../sourceAccess.js";
import { locateMapSource } from "../sourceLocator.js";
import { reactResolver } from "../worker/resolvers/react.js";
import { parseSource } from "../worker/resolvers/react/source.js";
import { clearDecodedMapCache } from "../worker/symbolication.js";
import { observation, request } from "./fixtures.js";

/**
 * The React resolver's choices, frame by frame, against modules transformed
 * the way a dev server serves them (esbuild's `jsxDEV` output, its map inline
 * and its sources named relative to the module, as Vite names them) and a
 * workspace held in memory, so each case says exactly which bytes the page
 * ran and which are on disk. Sources are located by main's own locator and
 * every response is held to main's own check of what this job served. A real
 * Vite dev server and real React stacks are `reactResolver.test.ts`'s.
 */

const WORKSPACE = "ws-react";
const ORIGIN = "http://localhost:5173";
const ROOTS = { worktreePath: "/work/app", appRoot: "/work/app" };
const encoder = new TextEncoder();

const revision = (text: string | Uint8Array) =>
  revisionOf(typeof text === "string" ? encoder.encode(text) : text);

interface FrameAt {
  file: string;
  line: number;
  column: number;
}

interface ServeOptions {
  /** The map lists its source as library code. */
  ignored?: boolean;
  /** The map embeds a copy of the source to compare the file with. */
  withContent?: boolean;
  /** What the map names its source; the module's own file name by default. */
  sourcefile?: string;
}

/** A dev server that has served some modules, over a workspace that may have moved on since. */
class DevServer {
  readonly files = new Map<string, Uint8Array>();
  readonly fetched: string[] = [];
  /** Paths whose reads are refused as over budget. */
  readonly overBudget = new Set<string>();
  /** Called as each map is fetched, before it is answered. */
  onFetch: (url: string) => void = () => {};
  private readonly modules = new Map<string, { code: string; map: string }>();
  private readonly servedRevisions = new Map<string, FileRevision>();
  private readonly servedMaps = new Set<FileRevision>();

  async serve(path: string, source: string, options: ServeOptions = {}): Promise<void> {
    const out = await transform(source, {
      loader: "tsx",
      jsx: "automatic",
      jsxDev: true,
      format: "esm",
      sourcemap: "external",
      sourcefile: options.sourcefile ?? path.split("/").at(-1),
      sourcesContent: options.withContent ?? true,
    });
    const map = JSON.parse(out.map) as Record<string, unknown>;
    if (options.ignored) map.x_google_ignoreList = [0];
    this.modules.set(`/${path}`, { code: out.code, map: JSON.stringify(map) });
    this.write(path, source);
  }

  write(path: string, contents: string | Uint8Array): void {
    this.files.set(path, typeof contents === "string" ? encoder.encode(contents) : contents);
  }

  /**
   * Where V8 reports the `nth` call that starts with `call` in what was
   * served: 1-based, at the callee, as a stack frame prints it.
   */
  at(path: string, call: string, nth = 0): FrameAt {
    const lines = this.modules.get(`/${path}`)!.code.split("\n");
    let seen = 0;
    for (const [index, line] of lines.entries()) {
      for (
        let column = line.indexOf(call);
        column !== -1;
        column = line.indexOf(call, column + 1)
      ) {
        if (seen++ === nth) {
          return { file: `${ORIGIN}/${path}?t=1`, line: index + 1, column: column + 1 };
        }
      }
    }
    throw new Error(`${call} is not called ${nth + 1} times in ${path}`);
  }

  /** One job's access: what it served is all that job's response may cite. */
  access(): ResolverSourceAccess {
    this.servedRevisions.clear();
    this.servedMaps.clear();
    return {
      fetchSourceMap: async (url) => {
        this.fetched.push(url);
        this.onFetch(url);
        const module = this.modules.get(new URL(url).pathname);
        if (!module) return { ok: false, reason: "map-missing" };
        const mapRevision = revision(module.map);
        this.servedMaps.add(mapRevision);
        return { ok: true, value: { url: null, revision: mapRevision, text: module.map } };
      },
      // Main's own rules: relative to the module an inline map came with.
      locateSource: async ({ generatedUrl, source, sourceRoot }) =>
        locateMapSource(source, sourceRoot, {
          workspaceId: WORKSPACE,
          roots: ROOTS,
          previewOrigin: ORIGIN,
          base: generatedUrl,
        }),
      readSource: async (file) => {
        if (this.overBudget.has(file.path)) return { ok: false, reason: "budget-exhausted" };
        const bytes = this.files.get(file.path);
        if (bytes === undefined) return { ok: false, reason: "file-missing" };
        this.servedRevisions.set(file.path, revisionOf(bytes));
        return { ok: true, value: { file, revision: revisionOf(bytes), bytes } };
      },
      locateFile: async () => ({ ok: false, reason: "outside-workspace" }),
    };
  }

  /** Main's check of a response: only files, revisions and maps this job served. */
  admit(req: Parameters<typeof checkResolveResponse>[0], response: ResolveResponse) {
    return checkResolveResponse(req, response, {
      roots: ROOTS,
      servedRevision: (path) => this.servedRevisions.get(path),
      servedMap: (mapUrl, mapRevision) => mapUrl === null && this.servedMaps.has(mapRevision),
    });
  }
}

let nextCandidate = 0;

function stack(
  kind: "element-creation" | "component-invocation" | "component-definition",
  ...frames: FrameAt[]
): SourceCandidate[] {
  return frames.map((at, index) => ({
    kind,
    candidateId: `frame-${(nextCandidate += 1)}`,
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: index + 1 },
    file: at.file,
    location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", line: at.line, column: at.column },
  }));
}

function selection(
  tagName: string,
  element: SourceCandidate[],
  components: SourceCandidate[][] = [],
  elementId = "el-1"
): SelectionObservation {
  return {
    ...observation(elementId, element),
    tagName,
    componentChain: {
      nearestId: components.length > 0 ? "component-0" : null,
      components: components.map((sourceCandidates, index) => ({
        componentId: `component-${index}`,
        framework: "react",
        name: null,
        environment: "client",
        rootElementIds: [elementId],
        rootsComplete: true,
        sourceCandidates,
      })),
      truncated: false,
    },
  };
}

interface ResolveOptions {
  known?: Array<[string, FileRevision]>;
  signal?: AbortSignal;
}

async function resolveAll(
  server: DevServer,
  observed: SelectionObservation[],
  options: ResolveOptions = {}
): Promise<ResolutionResult[][]> {
  const req = {
    ...request(WORKSPACE, observed),
    knownRevisions: (options.known ?? []).map(([path, pinned]) => ({
      file: { workspaceId: WORKSPACE, path },
      revision: pinned,
    })),
  };
  const response = await reactResolver.resolve(
    req,
    server.access(),
    options.signal ?? new AbortController().signal
  );
  // What main would pass on, and nothing it would refuse.
  expect(server.admit(req, response)).toEqual(response);
  // Every candidate answered once, in the order it was sent.
  expect(
    response.outcomes.map((outcome) => outcome.results.map((result) => result.candidateId))
  ).toEqual(
    observed.map((entry) => observationCandidates(entry).map((candidate) => candidate.candidateId))
  );
  return response.outcomes.map((outcome) => outcome.results);
}

async function resolve(
  server: DevServer,
  observed: SelectionObservation,
  options: ResolveOptions = {}
): Promise<ResolutionResult[]> {
  return (await resolveAll(server, [observed], options))[0]!;
}

/** `start` through the end of `end`, as a source map numbers it: 1-based lines, 0-based columns. */
function rangeOf(text: string, start: string, end: string): SourceLocation {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from) + end.length;
  if (from === -1 || to < end.length) throw new Error(`no ${start}…${end}`);
  const position = (offset: number) => {
    const before = text.slice(0, offset).split("\n");
    return { line: before.length, column: before.at(-1)!.length };
  };
  return { lineBase: 1, columnBase: 0, columnUnit: "utf16", ...position(from), end: position(to) };
}

const ref = (path: string) => ({ workspaceId: WORKSPACE, path });

/** What each result came to, a reason standing in for `unavailable`. */
const outcomes = (results: ResolutionResult[]) =>
  results.map((result) => (result.state === "unavailable" ? result.reason : result.state));

const CARD = [
  'import { Badge } from "./Badge";',
  "",
  "export function Card({ title }: { title: string }) {",
  "  return (",
  '    <section className="card">',
  '      <h2 className="title">{title}</h2>',
  "      {[1, 2].map((n) => (",
  "        <Badge key={n} n={n} />",
  "      ))}",
  "    </section>",
  "  );",
  "}",
  "",
].join("\n");

let server: DevServer;

beforeEach(async () => {
  clearDecodedMapCache();
  server = new DevServer();
  await server.serve("src/Card.tsx", CARD);
});

const h2 = () =>
  selection("h2", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')));

describe("an element's creation frames", () => {
  it("are verified at the JSX element the first frame of the app's code maps to", async () => {
    const [result] = await resolve(server, h2());
    expect(result).toEqual({
      state: "verified",
      candidateId: expect.any(String),
      claim: "element-creation",
      target: { file: ref("src/Card.tsx"), location: rangeOf(CARD, "<h2", "</h2>") },
      fileRevision: revision(CARD),
      sourceMap: {
        mapUrl: null,
        mapRevision: expect.stringMatching(/^sha256:/),
        sourceCheck: "matches",
      },
    });
  });

  it("are a mismatch where the JSX there is another tag, or a component", async () => {
    const results = await resolve(
      server,
      selection("span", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')))
    );
    expect(results[0]).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref("src/Card.tsx"), fileRevision: revision(CARD) },
    });
    const [component] = await resolve(
      server,
      selection("badge", stack("element-creation", server.at("src/Card.tsx", "jsxDEV(Badge")))
    );
    expect(component).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("pass over a dependency's frames unfetched, and answer every caller as not the claim", async () => {
    const library = {
      file: `${ORIGIN}/node_modules/.vite/deps/@emotion_react.js?v=4f1c`,
      line: 40,
      column: 12,
    };
    const results = await resolve(
      server,
      selection(
        "h2",
        stack(
          "element-creation",
          library,
          server.at("src/Card.tsx", 'jsxDEV("h2"'),
          server.at("src/Card.tsx", 'jsxDEV("section"')
        )
      )
    );
    // The call below the claim is a caller, not a second creation site.
    expect(outcomes(results)).toEqual(["unsupported", "verified", "unsupported"]);
    expect(server.fetched.some((url) => url.includes("node_modules"))).toBe(false);
  });

  it("pass over a source the map lists as library code, and one outside the workspace", async () => {
    const WRAP = "export const wrap = (tag: string) => <i data-tag={tag} />;\n";
    await server.serve("src/vendor/wrap.tsx", WRAP, { ignored: true });
    await server.serve("src/shared.tsx", WRAP, { sourcefile: "http://cdn.example.com/wrap.tsx" });
    const results = await resolve(
      server,
      selection(
        "h2",
        stack(
          "element-creation",
          server.at("src/vendor/wrap.tsx", 'jsxDEV("i"'),
          server.at("src/shared.tsx", 'jsxDEV("i"'),
          server.at("src/Card.tsx", 'jsxDEV("h2"')
        )
      )
    );
    expect(outcomes(results)).toEqual(["unsupported", "outside-workspace", "verified"]);
  });

  it("stop at a frame that cannot be mapped, or names no file, rather than take a caller in its place", async () => {
    const unmapped = await resolve(
      server,
      selection(
        "h2",
        stack(
          "element-creation",
          { file: `${ORIGIN}/src/Unserved.tsx?t=1`, line: 3, column: 10 },
          server.at("src/Card.tsx", 'jsxDEV("h2"')
        )
      )
    );
    expect(outcomes(unmapped)).toEqual(["map-missing", "unsupported"]);

    // A map naming a bundler's module, not a file: unknown whether it was the call.
    await server.serve("src/virtual.tsx", "export const v = () => <i />;\n", {
      sourcefile: "webpack://app/./virtual.tsx",
    });
    const virtual = await resolve(
      server,
      selection(
        "h2",
        stack(
          "element-creation",
          server.at("src/virtual.tsx", 'jsxDEV("i"'),
          server.at("src/Card.tsx", 'jsxDEV("h2"')
        )
      )
    );
    expect(outcomes(virtual)).toEqual(["unsupported", "unsupported"]);
  });

  it("take the stack's own order, however the candidates arrived", async () => {
    const frames = stack(
      "element-creation",
      { file: `${ORIGIN}/node_modules/.vite/deps/react-dom_client.js?v=1`, line: 9, column: 3 },
      server.at("src/Card.tsx", 'jsxDEV("h2"'),
      server.at("src/Card.tsx", 'jsxDEV("section"')
    );
    const results = await resolve(server, selection("h2", [...frames].reverse()));
    // Answered in the order sent; judged in the order captured.
    expect(outcomes(results)).toEqual(["unsupported", "verified", "unsupported"]);
  });

  it("offer the app's own frames as alternatives where the first holds no JSX, and choose none", async () => {
    const LIST = [
      'import { createElement } from "react";',
      "",
      "function item(label: string) {",
      '  return createElement("li", null, label);',
      "}",
      "",
      "export function List() {",
      '  return <ul>{item("one")}</ul>;',
      "}",
      "",
    ].join("\n");
    await server.serve("src/List.tsx", LIST);
    const helper = server.at("src/List.tsx", "createElement(");
    const caller = server.at("src/List.tsx", 'item("one")');
    const [ambiguous, below] = await resolve(
      server,
      selection("li", stack("element-creation", helper, caller))
    );
    const at = (needle: string) => {
      const { line, column } = rangeOf(LIST, needle, "(");
      return { line, column };
    };
    expect(ambiguous).toMatchObject({
      state: "ambiguous",
      claim: "element-creation",
      alternatives: [
        {
          state: "mapped",
          target: { file: ref("src/List.tsx"), location: at("createElement(") },
          fileRevision: revision(LIST),
        },
        {
          state: "mapped",
          target: { file: ref("src/List.tsx"), location: at('item("one")') },
          fileRevision: revision(LIST),
        },
      ],
    });
    expect(below).toMatchObject({ state: "unavailable", reason: "unsupported" });

    // With no caller of the app's own to offer, the frame is simply not a JSX site.
    const [alone] = await resolve(server, selection("li", stack("element-creation", helper)));
    expect(alone).toMatchObject({
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref("src/List.tsx") },
    });
  });

  it("offer each place once, the first ones, and no more than a result holds", async () => {
    const calls = Array.from({ length: 10 }, (_, index) => `  item("${index}");`);
    const MANY = [
      'import { createElement } from "react";',
      "",
      "function item(label: string) {",
      '  return createElement("li", null, label);',
      "}",
      "",
      "export function Many() {",
      ...calls,
      "  return null;",
      "}",
      "",
    ].join("\n");
    await server.serve("src/Many.tsx", MANY);
    const frames = [
      server.at("src/Many.tsx", "createElement("),
      server.at("src/Many.tsx", 'item("0")'),
      server.at("src/Many.tsx", 'item("0")'),
      ...Array.from({ length: 9 }, (_, index) => server.at("src/Many.tsx", `item("${index + 1}")`)),
    ];
    const results = await resolve(server, selection("li", stack("element-creation", ...frames)));
    const [first, ...rest] = results;
    const lines =
      first?.state === "ambiguous"
        ? first.alternatives.map((alt) => alt.target.location?.line)
        : [];
    // The helper, then its callers in stack order, the repeated one once, cut at eight.
    expect(lines).toEqual([4, 8, 9, 10, 11, 12, 13, 14]);
    expect(
      rest.every((result) => result.state === "unavailable" && result.reason === "unsupported")
    ).toBe(true);
  });

  it("answer work not begun before the request was withdrawn as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await resolve(server, h2(), { signal: controller.signal });
    expect(outcomes(results)).toEqual(["cancelled"]);
    expect(server.fetched).toEqual([]);
  });

  it("answer what was still to do as cancelled when the request is withdrawn part way", async () => {
    await server.serve("src/Badge.tsx", "export function Badge() {\n  return <span />;\n}\n");
    const controller = new AbortController();
    server.onFetch = () => controller.abort();
    const results = await resolve(
      server,
      selection("h2", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')), [
        stack("component-definition", server.at("src/Badge.tsx", 'jsxDEV("span"')),
      ]),
      { signal: controller.signal }
    );
    expect(outcomes(results)).toEqual(["cancelled", "cancelled"]);
    expect(server.fetched).toHaveLength(1);
  });

  it("answer each observation in one request on its own, sharing what they read", async () => {
    const [own] = stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"'));
    const [other] = stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("section"'));
    // Ids are the page's per observation, so two can repeat one.
    const [title, card] = await resolveAll(server, [
      selection("h2", [own!], [], "el-title"),
      selection("section", [{ ...other!, candidateId: own!.candidateId }], [], "el-card"),
    ]);
    expect(title?.[0]).toMatchObject({
      state: "verified",
      target: { location: rangeOf(CARD, "<h2", "</h2>") },
    });
    expect(card?.[0]).toMatchObject({
      state: "verified",
      target: { location: rangeOf(CARD, "<section", "</section>") },
      fileRevision: revision(CARD),
    });
    expect(server.fetched).toHaveLength(1);
  });
});

describe("a component's call site", () => {
  it("is verified at the component tag, and a host tag there is a mismatch", async () => {
    const results = await resolve(
      server,
      selection(
        "span",
        [],
        [
          stack("component-invocation", server.at("src/Card.tsx", "jsxDEV(Badge")),
          stack("component-invocation", server.at("src/Card.tsx", 'jsxDEV("h2"')),
        ]
      )
    );
    expect(results[0]).toMatchObject({
      state: "verified",
      claim: "component-invocation",
      target: { file: ref("src/Card.tsx"), location: rangeOf(CARD, "<Badge", "/>") },
    });
    expect(results[0]).not.toHaveProperty("definition");
    expect(results[1]).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("is found past a library component's own JSX wrapper", async () => {
    const results = await resolve(
      server,
      selection(
        "span",
        [],
        [
          stack(
            "component-invocation",
            {
              file: `${ORIGIN}/node_modules/.vite/deps/@emotion_react.js?v=1`,
              line: 12,
              column: 7,
            },
            server.at("src/Card.tsx", "jsxDEV(Badge")
          ),
        ]
      )
    );
    expect(outcomes(results)).toEqual(["unsupported", "verified"]);
  });
});

describe("staleness", () => {
  it("is reported when the file changed under the map the page ran, never a line in the new file", async () => {
    const edited = `// a comment\n// and another\n${CARD}`;
    server.write("src/Card.tsx", edited);
    const [result] = await resolve(server, h2());
    expect(result).toEqual({
      state: "stale",
      candidateId: expect.any(String),
      claim: "element-creation",
      held: {
        state: "mapped",
        target: {
          file: ref("src/Card.tsx"),
          location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 6, column: 6 },
        },
        fileRevision: null,
        sourceMap: expect.objectContaining({ sourceCheck: "differs" }),
      },
      currentFileRevision: revision(edited),
      reason: "file-changed",
    });
  });

  it("is reported when the file moved on from the revision an earlier result held", async () => {
    const earlier = revision("export function Card() { return null; }\n");
    const [result] = await resolve(server, h2(), { known: [["src/Card.tsx", earlier]] });
    expect(result).toMatchObject({
      state: "stale",
      reason: "file-changed",
      // The frame's own position is in the served module: no authored line is made up for it.
      held: {
        state: "observed",
        target: { file: ref("src/Card.tsx"), location: null },
        fileRevision: earlier,
      },
      currentFileRevision: revision(CARD),
    });

    const [same] = await resolve(server, h2(), { known: [["src/Card.tsx", revision(CARD)]] });
    expect(same).toMatchObject({ state: "verified" });
  });

  it("holds a pinned selection stale even where the new map places its old frame on another element of its tag", async () => {
    const TITLES = [
      "export function Titles() {",
      "  return (",
      "    <header>",
      '      <h2 className="first">First</h2>',
      '      <h2 className="second">Second</h2>',
      "    </header>",
      "  );",
      "}",
      "",
    ].join("\n");
    const swapped = TITLES.replace('"first">First', '"tmp">Tmp')
      .replace('"second">Second', '"first">First')
      .replace('"tmp">Tmp', '"second">Second');
    await server.serve("src/Titles.tsx", TITLES);
    const old = selection(
      "h2",
      stack("element-creation", server.at("src/Titles.tsx", 'jsxDEV("h2"'))
    );
    const [before] = await resolve(server, old);
    expect(before).toMatchObject({
      state: "verified",
      target: { location: rangeOf(TITLES, '<h2 className="first"', "</h2>") },
    });

    // The edit reaches the dev server; the page still runs the old module.
    await server.serve("src/Titles.tsx", swapped);
    // Where the old frame now lands is another <h2>, the one the user did not pick.
    const start = ({ line, column }: SourceLocation) => ({ line, column });
    expect(start(rangeOf(swapped, '<h2 className="second"', "</h2>"))).toEqual(
      start(rangeOf(TITLES, '<h2 className="first"', "</h2>"))
    );
    const [held] = await resolve(server, old, { known: [["src/Titles.tsx", revision(TITLES)]] });
    expect(held).toMatchObject({
      state: "stale",
      reason: "file-changed",
      held: { fileRevision: revision(TITLES), target: { location: null } },
      currentFileRevision: revision(swapped),
    });
  });

  it("is reported for a pinned file the map no longer places the frame in, or that has gone", async () => {
    // Old coordinates against the module as it is served now: past anything it maps.
    const lost = stack("element-creation", {
      file: `${ORIGIN}/src/Card.tsx?t=1`,
      line: 999,
      column: 1,
    });
    const earlier = revision("export function Card() { return null; }\n");
    const [moved] = await resolve(server, selection("h2", lost), {
      known: [["src/Card.tsx", earlier]],
    });
    expect(moved).toMatchObject({
      state: "stale",
      reason: "file-changed",
      held: {
        state: "observed",
        target: { file: ref("src/Card.tsx"), location: null },
        fileRevision: earlier,
      },
      currentFileRevision: revision(CARD),
    });
    // Nothing pinned: a position the map does not place is just that.
    const [unpinned] = await resolve(server, selection("h2", lost));
    expect(unpinned).toMatchObject({ state: "unavailable", reason: "map-missing" });

    server.files.delete("src/Card.tsx");
    const [gone] = await resolve(server, h2(), { known: [["src/Card.tsx", revision(CARD)]] });
    expect(gone).toMatchObject({
      state: "stale",
      reason: "file-missing",
      held: { target: { file: ref("src/Card.tsx"), location: null } },
      currentFileRevision: null,
    });
  });

  it("leaves a map with no copy of the source mapped, not verified: nothing ties it to the file", async () => {
    await server.serve("src/Card.tsx", CARD, { withContent: false });
    const [result] = await resolve(server, h2());
    expect(result).toEqual({
      state: "mapped",
      candidateId: expect.any(String),
      claim: "element-creation",
      target: {
        file: ref("src/Card.tsx"),
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 6, column: 6 },
      },
      fileRevision: revision(CARD),
      sourceMap: expect.objectContaining({ sourceCheck: "unchecked" }),
    });
    // What the file does contradict is still said.
    const [wrong] = await resolve(
      server,
      selection("span", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')))
    );
    expect(wrong).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("keeps a mapping it had no budget to read the file for, mapped and unchecked", async () => {
    server.overBudget.add("src/Card.tsx");
    const [result] = await resolve(server, h2());
    expect(result).toMatchObject({
      state: "mapped",
      target: { file: ref("src/Card.tsx"), location: { line: 6, column: 6 } },
      fileRevision: null,
      sourceMap: { sourceCheck: "unchecked" },
    });
  });

  it("names what it read but places nothing in a file that no longer parses, or is not text", async () => {
    await server.serve("src/Card.tsx", CARD, { withContent: false });
    for (const contents of [
      CARD.replace("</section>", ""),
      new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]),
    ]) {
      server.write("src/Card.tsx", contents);
      const [result] = await resolve(server, h2());
      expect(result).toEqual({
        state: "unavailable",
        candidateId: expect.any(String),
        claim: "element-creation",
        reason: "unsupported",
        read: { file: ref("src/Card.tsx"), fileRevision: revision(contents) },
      });
    }
  });

  it("places JSX in a file with a byte order mark and CRLF line endings by its own lines", async () => {
    const crlf = `\ufeff${CARD.replaceAll("\n", "\r\n")}`;
    await server.serve("src/Card.tsx", crlf);
    const [result] = await resolve(server, h2());
    expect(result).toMatchObject({
      state: "verified",
      target: { location: rangeOf(crlf, "<h2", "</h2>") },
      // Of the raw bytes, the mark and the carriage returns with them.
      fileRevision: revision(crlf),
      sourceMap: { sourceCheck: "matches" },
    });
  });
});

describe("a component's definition", () => {
  const DEFINITIONS = [
    'import { Component, forwardRef, memo } from "react";',
    "",
    "export function Card() {",
    '  return <section className="card" />;',
    "}",
    "",
    'const Badge = memo(() => <span className="badge">é{"😀"}<b /></span>);',
    "",
    "export const Field = forwardRef<HTMLInputElement>(function Field(_props, ref) {",
    "  return <input ref={ref} />;",
    "});",
    "",
    "export class Legacy extends Component {",
    "  render() {",
    '    return <div className="legacy" />;',
    "  }",
    "}",
    "",
    "export function withBorder(Inner: () => unknown) {",
    "  return function Bordered() {",
    '    return <div className="border">{Inner()}</div>;',
    "  };",
    "}",
    "",
    "export function Rows({ rows }: { rows: string[] }) {",
    "  const total = rows.length;",
    "  return renderRows(rows, total);",
    "}",
    "",
    "function renderRows(rows: string[], total: number) {",
    "  return <ol data-total={total}>{rows.map((row) => <li key={row}>{row}</li>)}</ol>;",
    "}",
    "",
    "export function Items({ rows }: { rows: string[] }) {",
    "  return rows.map((row) => <li key={row}>{row}</li>);",
    "}",
    "",
    "class Maker {",
    "  element = <s />;",
    "}",
    "",
    "export function Made() {",
    "  return new Maker().element;",
    "}",
    "",
    "export function Once() {",
    "  return (() => <u />)();",
    "}",
    "",
    "export const banner = <aside />;",
    "",
    "export { Badge };",
    "",
  ].join("\n");

  async function definitions(
    source: string,
    ...calls: Array<[string, number?]>
  ): Promise<ResolutionResult[]> {
    await server.serve("src/forms.tsx", source);
    return resolve(
      server,
      selection(
        "div",
        [],
        calls.map(([call, nth]) =>
          stack("component-definition", server.at("src/forms.tsx", call, nth))
        )
      )
    );
  }

  const declared = (result: ResolutionResult | undefined) =>
    result?.state === "verified" ? result.target.location : result;

  it("is the declaration of the function the frame runs in, through every wrapper around it", async () => {
    const results = await definitions(
      DEFINITIONS,
      ['jsxDEV("section"'],
      ['jsxDEV("b"'],
      ['jsxDEV("input"'],
      ['jsxDEV("div"', 0],
      ['jsxDEV("div"', 1]
    );
    expect(results.map(declared)).toEqual([
      rangeOf(DEFINITIONS, "export function Card", "\n}"),
      // A frame inside the arrow memo wraps, past an astral character on its line.
      rangeOf(DEFINITIONS, "const Badge", ");"),
      rangeOf(DEFINITIONS, "export const Field", "});"),
      // A class component's frame is its render method; the class is the definition.
      rangeOf(DEFINITIONS, "export class Legacy", "\n}"),
      // A component a factory returns is the inner function, not the factory.
      rangeOf(DEFINITIONS, "function Bordered", "\n  }"),
    ]);
    expect(results[0]).toMatchObject({
      state: "verified",
      claim: "component-definition",
      fileRevision: revision(DEFINITIONS),
      sourceMap: { sourceCheck: "matches" },
    });
  });

  it("is found through whatever call made the component's element: a helper, a method, a constructor", async () => {
    const results = await definitions(
      DEFINITIONS,
      ["renderRows(rows, total);"],
      ["map((row)", 1],
      ["new Maker()"],
      // An IIFE's callee starts where the call does: the function making it is Once.
      ['() => /* @__PURE__ */ jsxDEV("u"']
    );
    expect(results.map(declared)).toEqual([
      rangeOf(DEFINITIONS, "export function Rows", "\n}"),
      rangeOf(DEFINITIONS, "export function Items", "\n}"),
      rangeOf(DEFINITIONS, "export function Made", "\n}"),
      rangeOf(DEFINITIONS, "export function Once", "\n}"),
    ]);
  });

  it("takes a method call's frame on its dot as well as its name, as a compiled call's map puts it", () => {
    const source =
      "export function Items({ rows }) {\n  return rows?.map((row) => <li>{row}</li>);\n}\n";
    const parsed = parseSource("src/Items.jsx", source)!;
    const line = 2;
    const column = (needle: string) => source.split("\n")[line - 1]!.indexOf(needle);
    const declaration = rangeOf(source, "export function Items", "\n}");
    for (const at of [column("rows?."), column("?.map"), column("map(")]) {
      expect(parsed.definitionAt({ line, column: at }), String(at)).toEqual(declaration);
    }
    // Inside the receiver, or past the name, is no call.
    expect(parsed.definitionAt({ line, column: column("rows?.") + 1 })).toBeNull();
    expect(parsed.definitionAt({ line, column: column("map(") + 1 })).toBeNull();
  });

  it("takes the frame of a computed, optional or parenthesised call, or a tagged template, where V8 and a map put it", () => {
    const lines = [
      "export function Card({ helpers, key, fn, obj, tag, styled }) {",
      "  helpers[key]();",
      "  obj?.[key]?.();",
      "  (0, fn)();",
      "  tag`x`;",
      "  styled.div`x`;",
      "  return null;",
      "}",
      "",
    ];
    const source = lines.join("\n");
    const parsed = parseSource("src/Card.jsx", source)!;
    const declaration = rangeOf(source, "export function Card", "\n}");
    // Measured with V8 and Vite's transform: the call's `(`, its last `?.`, the
    // callee's closing `)`, and each template's backtick.
    const places: Array<[number, string]> = [
      [2, "]()"],
      [3, "?.()"],
      [4, ")()"],
      [5, "`x`"],
      [6, "`x`"],
    ];
    for (const [line, needle] of places) {
      const column = lines[line - 1]!.indexOf(needle) + (needle === "]()" ? 1 : 0);
      expect(parsed.definitionAt({ line, column }), `${line}:${needle}`).toEqual(declaration);
    }
    // Within an argument list, or past the call, is not where any frame stands.
    expect(parsed.definitionAt({ line: 2, column: lines[1]!.indexOf("]()") + 3 })).toBeNull();
    expect(parsed.definitionAt({ line: 7, column: 2 })).toBeNull();
  });

  it("is the default export, named, wrapped or anonymous", async () => {
    const cases: Array<[string, string, string, string]> = [
      [
        "export default function App() {\n  return <main />;\n}\n",
        'jsxDEV("main"',
        "export default function App",
        "\n}",
      ],
      [
        'import { memo } from "react";\nexport default memo(function Tile() {\n  return <i />;\n});\n',
        'jsxDEV("i"',
        "export default memo",
        "});",
      ],
      ["export default () => <b />;\n", 'jsxDEV("b"', "export default", ";"],
    ];
    for (const [source, call, start, end] of cases) {
      const [result] = await definitions(source, [call]);
      expect(declared(result), start).toEqual(rangeOf(source, start, end));
    }
  });

  it("is a mismatch for a frame in no function, or one that stands at no call", async () => {
    // Where a frame from some other version of the file would land: in a function, at no call.
    const [outside, uncalled] = await definitions(
      DEFINITIONS,
      ['jsxDEV("aside"'],
      ["total = rows"]
    );
    for (const result of [outside, uncalled]) {
      expect(result).toMatchObject({
        state: "unavailable",
        reason: "mismatch",
        read: { file: ref("src/forms.tsx") },
      });
    }
  });

  it("claims nothing for a component a dependency defines", async () => {
    const [library] = await resolve(
      server,
      selection(
        "div",
        [],
        [
          stack("component-definition", {
            file: `${ORIGIN}/node_modules/.vite/deps/@mui_material.js?v=1`,
            line: 900,
            column: 14,
          }),
        ]
      )
    );
    expect(library).toMatchObject({ state: "unavailable", reason: "unsupported" });
  });

  it("is reported apart from the call site, for the same record", async () => {
    await server.serve("src/forms.tsx", DEFINITIONS);
    const results = await resolve(
      server,
      selection(
        "span",
        [],
        [
          [
            ...stack("component-invocation", server.at("src/Card.tsx", "jsxDEV(Badge")),
            ...stack("component-definition", server.at("src/forms.tsx", 'jsxDEV("span"')),
          ],
        ]
      )
    );
    expect(results.map((result) => [result.claim, result.state])).toEqual([
      ["component-invocation", "verified"],
      ["component-definition", "verified"],
    ]);
    expect(results[0]?.state === "verified" && results[0].target.file.path).toBe("src/Card.tsx");
    expect(results[1]?.state === "verified" && results[1].target.file.path).toBe("src/forms.tsx");
  });
});
