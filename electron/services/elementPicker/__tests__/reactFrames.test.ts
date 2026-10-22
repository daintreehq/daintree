import { createHash } from "node:crypto";
import { transform } from "esbuild";
import { beforeEach, describe, expect, it } from "vitest";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import {
  ResolveResponseSchema,
  type ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { reactResolver } from "../worker/resolvers/react.js";
import { clearDecodedMapCache } from "../worker/symbolication.js";
import { observation, request } from "./fixtures.js";

/**
 * The React resolver's choices, frame by frame, against modules transformed
 * the way a dev server serves them (esbuild's `jsxDEV` output and its map)
 * and a workspace held in memory, so each case says exactly which bytes the
 * page ran and which are on disk. A real Vite dev server and real React
 * stacks are `reactResolver.test.ts`'s.
 */

const WORKSPACE = "ws-react";
const ORIGIN = "http://localhost:5173";

function revisionOf(bytes: Uint8Array | string): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface FrameAt {
  file: string;
  line: number;
  column: number;
}

/** A dev server that has served some modules, over a workspace that may have moved on since. */
class DevServer {
  readonly files = new Map<string, string>();
  readonly fetched: string[] = [];
  private readonly modules = new Map<string, { code: string; map: string }>();

  async serve(
    path: string,
    source: string,
    options: { ignored?: boolean; withContent?: boolean; sourcefile?: string } = {}
  ): Promise<void> {
    const out = await transform(source, {
      loader: "tsx",
      jsx: "automatic",
      jsxDev: true,
      format: "esm",
      sourcemap: "external",
      sourcefile: options.sourcefile ?? path,
      sourcesContent: options.withContent ?? true,
    });
    const map = JSON.parse(out.map) as Record<string, unknown>;
    if (options.ignored) map.x_google_ignoreList = [0];
    this.modules.set(`/${path}`, { code: out.code, map: JSON.stringify(map) });
    this.files.set(path, source);
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
        if (seen++ === nth)
          return { file: `${ORIGIN}/${path}?t=1`, line: index + 1, column: column + 1 };
      }
    }
    throw new Error(`${call} is not called ${nth + 1} times in ${path}`);
  }

  access(): ResolverSourceAccess {
    const encoder = new TextEncoder();
    return {
      fetchSourceMap: async (url) => {
        this.fetched.push(url);
        const module = this.modules.get(new URL(url).pathname);
        if (!module) return { ok: false, reason: "map-missing" };
        return {
          ok: true,
          value: { url: null, revision: revisionOf(module.map), text: module.map },
        };
      },
      locateSource: async ({ source }) =>
        source.startsWith("../")
          ? { ok: false, reason: "outside-workspace" }
          : { ok: true, value: { workspaceId: WORKSPACE, path: source } },
      readSource: async (file) => {
        const text = this.files.get(file.path);
        if (text === undefined) return { ok: false, reason: "file-missing" };
        const bytes = encoder.encode(text);
        return { ok: true, value: { file, revision: revisionOf(bytes), bytes } };
      },
      locateFile: async () => ({ ok: false, reason: "outside-workspace" }),
    };
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
  components: SourceCandidate[][] = []
): SelectionObservation {
  return {
    ...observation("el-1", element),
    tagName,
    componentChain: {
      nearestId: components.length > 0 ? "component-0" : null,
      components: components.map((sourceCandidates, index) => ({
        componentId: `component-${index}`,
        framework: "react",
        name: null,
        environment: "client",
        rootElementIds: ["el-1"],
        rootsComplete: true,
        sourceCandidates,
      })),
      truncated: false,
    },
  };
}

async function resolve(
  server: DevServer,
  observed: SelectionObservation,
  options: { known?: Array<[string, FileRevision]>; signal?: AbortSignal } = {}
): Promise<ResolutionResult[]> {
  const req = {
    ...request(WORKSPACE, [observed]),
    knownRevisions: (options.known ?? []).map(([path, revision]) => ({
      file: { workspaceId: WORKSPACE, path },
      revision,
    })),
  };
  const response = await reactResolver.resolve(
    req,
    server.access(),
    options.signal ?? new AbortController().signal
  );
  // Only what the host would pass on: every result well formed and for a candidate it was sent.
  return ResolveResponseSchema.parse(response).outcomes[0]!.results;
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

describe("an element's creation frames", () => {
  it("are verified at the JSX element the first frame of the app's code maps to", async () => {
    const [result] = await resolve(
      server,
      selection("h2", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')))
    );
    expect(result).toEqual({
      state: "verified",
      candidateId: expect.any(String),
      claim: "element-creation",
      target: { file: ref("src/Card.tsx"), location: rangeOf(CARD, "<h2", "</h2>") },
      fileRevision: revisionOf(CARD),
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
      read: { file: ref("src/Card.tsx"), fileRevision: revisionOf(CARD) },
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
    expect(results.map((result) => result.state)).toEqual([
      "unavailable",
      "verified",
      "unavailable",
    ]);
    expect(results[0]).toMatchObject({ reason: "unsupported" });
    // The call below the claim is a caller, not a second creation site.
    expect(results[2]).toMatchObject({ reason: "unsupported" });
    expect(server.fetched.some((url) => url.includes("node_modules"))).toBe(false);
  });

  it("pass over a source the map lists as library code, and one outside the workspace", async () => {
    const WRAP = "export const wrap = (tag: string) => <i data-tag={tag} />;\n";
    await server.serve("src/vendor/wrap.tsx", WRAP, { ignored: true });
    await server.serve("src/shared.tsx", WRAP, { sourcefile: "../shared/wrap.tsx" });
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
    expect(
      results.map((result) => (result.state === "unavailable" ? result.reason : result.state))
    ).toEqual(["unsupported", "outside-workspace", "verified"]);
  });

  it("stop at a frame that cannot be mapped rather than take a caller in its place", async () => {
    const results = await resolve(
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
    expect(results).toMatchObject([
      { state: "unavailable", reason: "map-missing" },
      { state: "unavailable", reason: "unsupported" },
    ]);
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
    expect(ambiguous).toMatchObject({
      state: "ambiguous",
      claim: "element-creation",
      alternatives: [
        {
          state: "mapped",
          target: {
            file: ref("src/List.tsx"),
            location: { line: 4, column: rangeOf(LIST, "createElement(", "(").column },
          },
          fileRevision: revisionOf(LIST),
        },
        {
          state: "mapped",
          target: {
            file: ref("src/List.tsx"),
            location: { line: 8, column: rangeOf(LIST, 'item("one")', "(").column },
          },
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

  it("answer work not begun before the request was withdrawn as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await resolve(
      server,
      selection("h2", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"'))),
      { signal: controller.signal }
    );
    expect(results).toMatchObject([{ state: "unavailable", reason: "cancelled" }]);
    expect(server.fetched).toEqual([]);
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
});

describe("staleness", () => {
  const h2 = () =>
    selection("h2", stack("element-creation", server.at("src/Card.tsx", 'jsxDEV("h2"')));

  it("is reported when the file changed under the map the page ran, never a line in the new file", async () => {
    const edited = `// a comment\n// and another\n${CARD}`;
    server.files.set("src/Card.tsx", edited);
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
      currentFileRevision: revisionOf(edited),
      reason: "file-changed",
    });
  });

  it("is reported when the file moved on from the revision an earlier result held", async () => {
    const earlier = revisionOf("export function Card() { return null; }\n");
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
      currentFileRevision: revisionOf(CARD),
    });

    const [same] = await resolve(server, h2(), { known: [["src/Card.tsx", revisionOf(CARD)]] });
    expect(same).toMatchObject({ state: "verified" });
  });

  it("is reported for a pinned file the map no longer places the frame in, or that has gone", async () => {
    // Old coordinates against the module as it is served now: past anything it maps.
    const lost = stack("element-creation", {
      file: `${ORIGIN}/src/Card.tsx?t=1`,
      line: 999,
      column: 1,
    });
    const earlier = revisionOf("export function Card() { return null; }\n");
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
      currentFileRevision: revisionOf(CARD),
    });
    // Nothing pinned: a position the map does not place is just that.
    const [unpinned] = await resolve(server, selection("h2", lost));
    expect(unpinned).toMatchObject({ state: "unavailable", reason: "map-missing" });

    server.files.delete("src/Card.tsx");
    const [gone] = await resolve(server, h2(), { known: [["src/Card.tsx", revisionOf(CARD)]] });
    expect(gone).toMatchObject({
      state: "stale",
      reason: "file-missing",
      held: { target: { file: ref("src/Card.tsx"), location: null } },
      currentFileRevision: null,
    });
  });

  it("leaves a map with no copy of the source to the file, and says it was not compared", async () => {
    await server.serve("src/Card.tsx", CARD, { withContent: false });
    const [result] = await resolve(server, h2());
    expect(result).toMatchObject({
      state: "verified",
      fileRevision: revisionOf(CARD),
      sourceMap: { sourceCheck: "unchecked" },
    });
  });

  it("names what it read but places nothing in a file that no longer parses", async () => {
    await server.serve("src/Card.tsx", CARD, { withContent: false });
    const broken = CARD.replace("</section>", "");
    server.files.set("src/Card.tsx", broken);
    const [result] = await resolve(server, h2());
    expect(result).toEqual({
      state: "unavailable",
      candidateId: expect.any(String),
      claim: "element-creation",
      reason: "unsupported",
      read: { file: ref("src/Card.tsx"), fileRevision: revisionOf(broken) },
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
    "export const banner = <aside />;",
    "",
    "export { Badge };",
    "",
  ].join("\n");

  async function definitions(...calls: Array<[string, number?]>): Promise<ResolutionResult[]> {
    await server.serve("src/forms.tsx", DEFINITIONS);
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
    // What a component's own element was made through can be a helper it calls, or a method.
    const [helper, method] = await definitions(["renderRows(rows, total);"], ["map((row)", 1]);
    expect(declared(helper)).toEqual(rangeOf(DEFINITIONS, "export function Rows", "\n}"));
    expect(declared(method)).toEqual(rangeOf(DEFINITIONS, "export function Items", "\n}"));
    expect(results[0]).toMatchObject({
      state: "verified",
      claim: "component-definition",
      fileRevision: revisionOf(DEFINITIONS),
      sourceMap: { sourceCheck: "matches" },
    });
  });

  it("is a mismatch for a frame in no function, or one that stands at no call", async () => {
    // Where a frame from some other version of the file would land: in a function, at no call.
    const [outside, uncalled] = await definitions(['jsxDEV("aside"'], ["total = rows"]);
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
