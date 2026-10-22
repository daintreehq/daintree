// @vitest-environment jsdom
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import {
  ElementPickerEventSchema,
  type ElementPickerEvent,
} from "../../../../shared/elementPicker/protocol.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import { ElementPickerHost } from "../ElementPickerHost.js";
import { createReactExtractor } from "../guest/extractors/reactExtractor.js";
import { createPicker, type PickerHandle } from "../guest/picker.js";
import { installExtractor } from "../guest/registry.js";
import { EXTRACTOR_REGISTRY_GLOBAL } from "../guestChannel.js";
import { revisionOf } from "../sourceAccess.js";
import { RESOLVER_LOADERS } from "../worker/resolverRegistry.js";
import { RuntimeChild, request } from "./fixtures.js";

/**
 * A React 19 selection traced end to end, with React Compiler off and on: a
 * real Vite 8 dev server transforms the app, the modules it serves run under
 * a real react-dom, so every `_debugStack` is one V8 captured in that served
 * code; the React extractor reads them off the rendered fibers, and the host
 * resolves them through the registry's own React resolver, fetching each
 * module's map from the dev server and reading the files from disk.
 *
 * The page's module loader is the one piece stood in for: served modules are
 * run with `vm` under their dev-server URL, imports bound by a prologue on
 * their first line, so every call is at the line and column served. React
 * and react-dom run as Node loads them, not as Vite pre-bundles them for a
 * browser; their frames are passed over either way.
 */

const require = createRequire(import.meta.url);
const REPO_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules"
);
const { act } = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");

const FILES: Record<string, string> = {
  "src/main.tsx": [
    'import type { Root } from "react-dom/client";',
    'import App from "./App";',
    "",
    "export function mount(root: Root) {",
    "  root.render(<App />);",
    "}",
    "",
  ].join("\n"),
  "src/App.tsx": [
    'import type { ReactNode } from "react";',
    'import { Card } from "./Card";',
    'import { Badge } from "./ui";',
    "",
    "function Frame({ children }: { children: ReactNode }) {",
    "  return children;",
    "}",
    "",
    "function List({ items }: { items: string[] }) {",
    "  return (",
    "    <>",
    "      {items.map((item) => (",
    '        <li key={item} className="entry">',
    "          {item}",
    "        </li>",
    "      ))}",
    "    </>",
    "  );",
    "}",
    "",
    "export default function App() {",
    "  return (",
    '    <main className="app">',
    '      <Card title="Fixture" />',
    "      <Badge n={3} />",
    '      <ul className="list">',
    "        <Frame>",
    '          <List items={["one", "two"]} />',
    "        </Frame>",
    "      </ul>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/Card.tsx": [
    'import { useState } from "react";',
    "",
    "function Title({ text }: { text: string }) {",
    '  return <h2 className="title">{text}</h2>;',
    "}",
    "",
    "export function Card({ title }: { title: string }) {",
    "  const [open, setOpen] = useState(false);",
    "  return (",
    '    <section className="card" onClick={() => setOpen(!open)}>',
    "      <Title text={title} />",
    "      {[1, 2].map((n) => (",
    '        <em key={n} className="item">',
    "          {n}",
    "        </em>",
    "      ))}",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n"),
  // Imported through a barrel: where Badge is written is not where App's import points.
  "src/ui/index.ts": 'export { Badge } from "./Badge";\n',
  "src/ui/Badge.tsx": [
    "export function Badge({ n }: { n: number }) {",
    '  return <span className="badge">{n}</span>;',
    "}",
    "",
  ].join("\n"),
};

/** `start` through the end of `end`: 1-based lines, 0-based columns, as a source map numbers them. */
function rangeOf(text: string, start: string, end: string): SourceLocation {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from) + end.length;
  if (from === -1 || to < end.length) throw new Error(`no ${start}…${end}`);
  const position = (offset: number) => {
    const lines = text.slice(0, offset).split("\n");
    return { line: lines.length, column: lines.at(-1)!.length };
  };
  return { lineBase: 1, columnBase: 0, columnUnit: "utf16", ...position(from), end: position(to) };
}

const REFRESH_RUNTIME = {
  register() {},
  registerExportsForReactRefresh() {},
  validateRefreshBoundaryAndEnqueueUpdate() {},
  createSignatureFunctionForTransform: () => () => {},
};

/** `import … from "x"` as Vite writes it once it has resolved `x`. */
const IMPORT = /import\s*(?:(\{[^}]*\})|\*\s*as\s+([\w$]+)|([\w$]+))\s*from\s*"([^"]+)";?/g;
const REEXPORT = /export\s*(\{[^}]*\})\s*from\s*"([^"]+)";?/g;
const AS = /([\w$]+)\s+as\s+([\w$]+)/g;
/** As wide as `import.meta`, so a line holding it keeps its columns. */
const META = "__vite_meta";

/** Only an import's or an export's own line changes, and no call on any line moves. */
function expectSamePositions(served: string, run: string): void {
  const before = served.split("\n");
  const after = run.split("\n");
  expect(after).toHaveLength(before.length);
  before.forEach((line, index) => {
    if (after[index] === line) return;
    expect(line, `line ${index + 1} changed`).toMatch(/^(?:import|export)\b|import\.meta/);
    if (!/^(?:import|export\s*\{)/.test(line)) expect(after[index]).toHaveLength(line.length);
    expect(line).not.toMatch(/_jsxDEV\(/);
  });
}

/**
 * Runs what the dev server serves for `url`, and what it imports from the
 * app, the way a page would: under the module's own URL. Imports are hoisted
 * into a prologue on line 1 and leave their newlines behind, `export` becomes
 * as many spaces and `import.meta` a name as wide, so every call keeps the
 * line and column Vite gave it, as `expectSamePositions` holds it to.
 */
class PageModules {
  private readonly loaded = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly server: ViteDevServer,
    private readonly origin: string
  ) {}

  forget(): void {
    this.loaded.clear();
  }

  async load(url: string): Promise<Record<string, unknown>> {
    const key = url.replace(/[?#].*$/, "");
    const known = this.loaded.get(key);
    if (known) return known;
    const exports: Record<string, unknown> = {};
    this.loaded.set(key, exports);
    const served = await this.server.transformRequest(key);
    if (!served) throw new Error(`${key} was not served`);
    const prologue: string[] = [];
    const local: string[] = [];
    const exported: string[] = [];
    const bind = (specifier: string) => {
      if (specifier.startsWith("/src/")) local.push(specifier);
      return `__import(${JSON.stringify(specifier)})`;
    };
    const newlines = (text: string) => text.replace(/[^\n]/g, "");
    let code = served.code
      .replace(IMPORT, (all, named?: string, namespace?: string, single?: string, from = "") => {
        if (named) prologue.push(`var ${named.replace(AS, "$1: $2")} = ${bind(from)};`);
        else if (namespace) prologue.push(`var ${namespace} = ${bind(from)};`);
        else prologue.push(`var ${single} = ${bind(from)}.default;`);
        return newlines(all);
      })
      .replace(REEXPORT, (all, named: string, from: string) => {
        const module = `__reexport${prologue.length}`;
        prologue.push(`var ${module} = ${bind(from)};`);
        for (const entry of named.slice(1, -1).split(",")) {
          const [name, alias = name] = entry.trim().split(/\s+as\s+/);
          if (name) exported.push(`${alias}: ${module}.${name}`);
        }
        return newlines(all);
      });
    for (const dependency of local) await this.load(dependency);
    for (const match of code.matchAll(/^export\s+(?:function|const|let|class)\s+([\w$]+)/gm)) {
      exported.push(match[1]!);
    }
    for (const match of code.matchAll(/^export default\s+(?:function|class)\s+([\w$]+)/gm)) {
      exported.push(`default: ${match[1]!}`);
    }
    code = code
      .replace(/^export default(?=\s+(?:function|class)\s)/gm, " ".repeat("export default".length))
      .replace(/^export(?=\s+(?:function|const|let|class)\s)/gm, " ".repeat("export".length))
      .replaceAll("import.meta", META);
    expectSamePositions(served.code, code);
    const run = vm.runInThisContext(
      `(function (__import, ${META}) {${prologue.join(" ")}${code}\nreturn { ${exported.join(", ")} };\n})`,
      { filename: `${this.origin}${key}` }
    ) as (load: (specifier: string) => unknown, meta: object) => Record<string, unknown>;
    Object.assign(
      exports,
      run((specifier) => this.imported(specifier), {})
    );
    return exports;
  }

  private imported(specifier: string): unknown {
    const bare = specifier.replace(/[?#].*$/, "");
    if (bare === "/@vite/client") return { createHotContext: () => undefined };
    if (bare === "/@react-refresh") return REFRESH_RUNTIME;
    if (bare.startsWith("/@fs/")) return require(bare.slice("/@fs".length));
    const local = this.loaded.get(bare);
    if (local) return local;
    throw new Error(`the page imported ${specifier}`);
  }
}

/** Whether the compiler memoized the function `name` declares, rather than bailing out of it. */
function compiled(code: string, name: string): boolean {
  const start = code.search(new RegExp(`function ${name}\\(`));
  if (start === -1) throw new Error(`no function ${name} was served`);
  const body = code.slice(start, code.indexOf("\n}", start));
  return /= _c\(\d+\)/.test(body);
}

const CHANNEL = "react-resolver-test";
const scope = globalThis as Record<string, unknown>;
const actFlag = Object.getOwnPropertyDescriptor(scope, "IS_REACT_ACT_ENVIRONMENT");

beforeAll(() => {
  scope.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (actFlag) Object.defineProperty(scope, "IS_REACT_ACT_ENVIRONMENT", actFlag);
  else delete scope.IS_REACT_ACT_ENVIRONMENT;
});

describe.each([
  ["off", false],
  ["on", true],
] as const)("tracing a React selection to source, React Compiler %s", (_label, compiler) => {
  let root: string;
  let server: ViteDevServer;
  let origin: string;
  let host: ElementPickerHost;
  let workspaceId: string;
  let page: PageModules;
  let reactRoot: ReturnType<typeof createRoot> | null = null;
  let picker: PickerHandle | null = null;
  let events: ElementPickerEvent[] = [];

  const ref = (file: string) => ({ workspaceId, path: file });
  const revision = (file: string): FileRevision =>
    revisionOf(fs.readFileSync(path.join(root, file)));

  async function render(): Promise<void> {
    picker?.dispose();
    (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
    act(() => reactRoot?.unmount());
    document.body.innerHTML = '<div id="root"></div>';
    page.forget();
    const { mount } = (await page.load("/src/main.tsx")) as { mount: (root: unknown) => void };
    reactRoot = createRoot(document.getElementById("root")!);
    act(() => mount(reactRoot));
    installExtractor(
      { channel: CHANNEL, framework: "react", installed: false },
      createReactExtractor()
    );
    events = [];
    picker = createPicker({
      channel: CHANNEL,
      mode: "select",
      post: (event) => {
        const parsed = ElementPickerEventSchema.safeParse(event);
        if (!parsed.success) throw new Error(`host would reject ${event.type}: ${parsed.error}`);
        events.push(event);
      },
    });
  }

  function pick(selector: string): SelectionObservation {
    const node = document.querySelector(selector);
    if (node === null) throw new Error(`no ${selector}`);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const last = events.filter((event) => event.type === "selectionChanged").at(-1);
    const observation = last?.type === "selectionChanged" ? last.observations[0] : undefined;
    if (observation === undefined) throw new Error(`nothing selected for ${selector}`);
    return observation;
  }

  type Pinned = Array<{ file: { workspaceId: string; path: string }; revision: FileRevision }>;

  /** Each claim the host made for the selection: the element's own, and each component's by kind. */
  async function trace(observation: SelectionObservation, knownRevisions: Pinned = []) {
    const response = await host.resolve({ ...request(workspaceId, [observation]), knownRevisions });
    const results = new Map(
      response.outcomes[0]!.results.map((result) => [result.candidateId, result])
    );
    const of = (candidates: SelectionObservation["sourceCandidates"]) =>
      candidates.map((candidate) => results.get(candidate.candidateId)!);
    const byKind = (candidates: SelectionObservation["sourceCandidates"], kind: string) =>
      of(candidates.filter((candidate) => candidate.kind === kind));
    const component = (name: string) => {
      const record = observation.componentChain.components.find(
        (entry) => entry.name?.value === name
      );
      if (!record) throw new Error(`no ${name} in the chain`);
      return {
        invocation: byKind(record.sourceCandidates, "component-invocation"),
        definition: byKind(record.sourceCandidates, "component-definition"),
      };
    };
    return { element: of(observation.sourceCandidates), component };
  }

  /**
   * A claim's one verified frame. Every other frame is a library's, a caller
   * or outside the app, and none of them is made any claim for.
   */
  function verified(results: ResolutionResult[]) {
    expect(results.filter((result) => result.state !== "unavailable").map((r) => r.state)).toEqual([
      "verified",
    ]);
    const result = results.find((entry) => entry.state === "verified");
    return result?.state === "verified"
      ? { file: result.target.file, location: result.target.location }
      : null;
  }

  /** A claim's one stale frame, with nothing verified or placed for any other. */
  function stale(results: ResolutionResult[]) {
    expect(results.filter((result) => result.state !== "unavailable").map((r) => r.state)).toEqual([
      "stale",
    ]);
    return results.find((entry) => entry.state === "stale");
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-react-")));
    for (const [file, contents] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    fs.symlinkSync(REPO_NODE_MODULES, path.join(root, "node_modules"), "junction");
    server = await createServer({
      root,
      configFile: false,
      envFile: false,
      logLevel: "silent",
      cacheDir: path.join(root, ".vite"),
      plugins: [
        react(),
        ...(compiler ? [babel({ presets: [reactCompilerPreset({ target: "19" })] })] : []),
      ],
      server: { host: "127.0.0.1", watch: null },
      optimizeDeps: { disabled: true },
    });
    await server.listen();
    origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
    page = new PageModules(server, origin);
    host = new ElementPickerHost({
      fork: () => new RuntimeChild(RESOLVER_LOADERS),
      kill: vi.fn(),
      watch: () => () => undefined,
      idleMs: 60_000,
    });
    workspaceId = await host.registerWorkspace({
      worktreePath: root,
      previewOrigin: origin,
      onSourceChanged: () => undefined,
    });
    await render();
  }, 60_000);

  afterAll(async () => {
    picker?.dispose();
    (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
    act(() => reactRoot?.unmount());
    document.body.innerHTML = "";
    await host?.dispose();
    await server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs every component it traces compiled, or not, as the variant says", async () => {
    // A bail-out in any one of them would leave the "on" case proving nothing for it.
    for (const [module, names] of [
      ["/src/Card.tsx", ["Title", "Card"]],
      ["/src/App.tsx", ["App", "List"]],
      ["/src/ui/Badge.tsx", ["Badge"]],
    ] as const) {
      const code = (await server.transformRequest(module))!.code;
      for (const name of names) expect(compiled(code, name), name).toBe(compiler);
    }
  });

  it("places a picked element at the JSX that made it", async () => {
    const { element } = await trace(pick("h2.title"));
    expect(verified(element)).toEqual({
      file: ref("src/Card.tsx"),
      location: rangeOf(FILES["src/Card.tsx"]!, "<h2", "</h2>"),
    });
    expect(element.find((result) => result.state === "verified")).toMatchObject({
      fileRevision: revision("src/Card.tsx"),
      sourceMap: { mapUrl: null, sourceCheck: "matches" },
    });

    // Made in a callback the compiler may hoist out of the component entirely.
    const item = await trace(pick("em.item"));
    expect(verified(item.element)).toEqual({
      file: ref("src/Card.tsx"),
      location: rangeOf(FILES["src/Card.tsx"]!, "<em", "</em>"),
    });
  });

  it("places each component at its call site and, apart, at its definition", async () => {
    const { component } = await trace(pick("h2.title"));
    const card = FILES["src/Card.tsx"]!;
    const app = FILES["src/App.tsx"]!;
    expect(verified(component("Title").invocation)).toEqual({
      file: ref("src/Card.tsx"),
      location: rangeOf(card, "<Title", "/>"),
    });
    expect(verified(component("Title").definition)).toEqual({
      file: ref("src/Card.tsx"),
      location: rangeOf(card, "function Title", "\n}"),
    });
    expect(verified(component("Card").invocation)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "<Card", "/>"),
    });
    expect(verified(component("Card").definition)).toEqual({
      file: ref("src/Card.tsx"),
      location: rangeOf(card, "export function Card", "\n}"),
    });
    expect(verified(component("App").invocation)).toEqual({
      file: ref("src/main.tsx"),
      location: rangeOf(FILES["src/main.tsx"]!, "<App", "/>"),
    });
    expect(verified(component("App").definition)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "export default function App", "\n}"),
    });
  });

  it("finds a definition behind a re-export, which the call site's import never names", async () => {
    const { element, component } = await trace(pick("span.badge"));
    const badge = FILES["src/ui/Badge.tsx"]!;
    expect(verified(element)).toEqual({
      file: ref("src/ui/Badge.tsx"),
      location: rangeOf(badge, "<span", "</span>"),
    });
    expect(verified(component("Badge").invocation)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(FILES["src/App.tsx"]!, "<Badge", "/>"),
    });
    expect(verified(component("Badge").definition)).toEqual({
      file: ref("src/ui/Badge.tsx"),
      location: rangeOf(badge, "export function Badge", "\n}"),
    });
  });

  it("finds a component whose elements a callback makes, and claims nothing for one that only passes children on", async () => {
    const { element, component } = await trace(pick("li.entry"));
    const app = FILES["src/App.tsx"]!;
    expect(verified(element)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "<li", "</li>"),
    });
    expect(verified(component("List").invocation)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "<List", "/>"),
    });
    // The frame React called List through stands at `items.map(…)`, not at any JSX.
    expect(verified(component("List").definition)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "function List", "\n}"),
    });
    expect(verified(component("Frame").invocation)).toEqual({
      file: ref("src/App.tsx"),
      location: rangeOf(app, "<Frame>", "</Frame>"),
    });
    // Every element under Frame was made by App or List: nothing says where Frame is written.
    expect(component("Frame").definition).toEqual([]);
  });

  it("calls a selection stale after an edit, never a line in the edited file, and traces it again once the page has it", async () => {
    const before = pick("h2.title");
    const first = await trace(before);
    const traced = first.element.find((result) => result.state === "verified");
    const pinnedRevision = traced?.state === "verified" ? traced.fileRevision : null;
    expect(pinnedRevision).toBe(revision("src/Card.tsx"));
    const pinned = [{ file: ref("src/Card.tsx"), revision: pinnedRevision! }];
    const edited = `// moved\n// down\n${FILES["src/Card.tsx"]}`;
    const cardPath = path.join(root, "src/Card.tsx");
    const original = (await server.transformRequest("/src/Card.tsx"))!.code;
    fs.writeFileSync(cardPath, edited);
    try {
      // On disk, but neither the dev server nor the page has it yet.
      const lagging = await trace(before);
      for (const results of [
        lagging.element,
        lagging.component("Title").invocation,
        lagging.component("Title").definition,
        lagging.component("Card").definition,
      ]) {
        expect(stale(results)).toMatchObject({
          reason: "file-changed",
          held: { state: "mapped", target: { file: ref("src/Card.tsx") } },
          currentFileRevision: revision("src/Card.tsx"),
        });
      }
      // App.tsx is untouched, and still says where Card is called.
      expect(verified(lagging.component("Card").invocation)?.file).toEqual(ref("src/App.tsx"));

      // The dev server has the edit, the page does not: its frames are the old module's.
      server.watcher.emit("change", cardPath);
      await vi.waitFor(
        async () =>
          expect((await server.transformRequest("/src/Card.tsx"))!.code).not.toBe(original),
        { timeout: 5_000 }
      );
      const held = await trace(before, pinned);
      for (const results of [
        held.element,
        held.component("Title").invocation,
        held.component("Title").definition,
        held.component("Card").definition,
      ]) {
        expect(stale(results)).toMatchObject({
          reason: "file-changed",
          held: {
            state: "observed",
            target: { file: ref("src/Card.tsx"), location: null },
            fileRevision: pinnedRevision,
          },
          currentFileRevision: revision("src/Card.tsx"),
        });
      }

      // The page runs the new module and the selection is made again: the new line.
      await render();
      const fresh = await trace(pick("h2.title"));
      expect(verified(fresh.element)).toEqual({
        file: ref("src/Card.tsx"),
        location: rangeOf(edited, "<h2", "</h2>"),
      });
    } finally {
      // The page, the dev server and the disk back where the other cases expect them.
      fs.writeFileSync(cardPath, FILES["src/Card.tsx"]!);
      server.watcher.emit("change", cardPath);
      // Served again with its HMR timestamp in the self-import, and otherwise as it was.
      const untimed = (code: string) => code.replace(/\?t=\d+/g, "");
      await vi.waitFor(
        async () =>
          expect(untimed((await server.transformRequest("/src/Card.tsx"))!.code)).toBe(
            untimed(original)
          ),
        { timeout: 5_000 }
      );
      await render();
    }
  }, 30_000);
});
