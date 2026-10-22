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
 * their first line, so every line a frame can land on is the line served.
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
    'import { App } from "./App";',
    "",
    "export function mount(root: Root) {",
    "  root.render(<App />);",
    "}",
    "",
  ].join("\n"),
  "src/App.tsx": [
    'import { Card } from "./Card";',
    'import { Badge } from "./ui";',
    "",
    "export function App() {",
    "  return (",
    '    <main className="app">',
    '      <Card title="Fixture" />',
    "      <Badge n={3} />",
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

/**
 * Runs what the dev server serves for `url`, and what it imports from the
 * app, the way a page would: under the module's own URL. Imports are hoisted
 * into a prologue on line 1, which only ever holds imports, and every other
 * line keeps its columns (`export` becomes as many spaces), so the generated
 * positions V8 reports are the dev server's own.
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
    let code = served.code
      .replace(IMPORT, (_all, named?: string, namespace?: string, single?: string, from = "") => {
        if (named) prologue.push(`var ${named.replace(AS, "$1: $2")} = ${bind(from)};`);
        else if (namespace) prologue.push(`var ${namespace} = ${bind(from)};`);
        else prologue.push(`var ${single} = ${bind(from)}.default;`);
        return "";
      })
      .replace(REEXPORT, (_all, named: string, from: string) => {
        const module = `__reexport${prologue.length}`;
        prologue.push(`var ${module} = ${bind(from)};`);
        for (const entry of named.slice(1, -1).split(",")) {
          const [name, alias = name] = entry.trim().split(/\s+as\s+/);
          if (name) exported.push(`${alias}: ${module}.${name}`);
        }
        return "";
      });
    for (const dependency of local) await this.load(dependency);
    exported.push(
      ...[...code.matchAll(/^export\s+(?:function|const|let|class)\s+([\w$]+)/gm)].map(
        (match) => match[1]!
      )
    );
    code = code.replace(/^export(?=\s+(?:function|const|let|class)\s)/gm, "      ");
    code = code.replaceAll("import.meta", "__meta");
    const run = vm.runInThisContext(
      `(function (__import, __meta) {${prologue.join(" ")}${code}\nreturn { ${exported.join(", ")} };\n})`,
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

  /** Each claim the host made for the selection, by component (null for the element's own) and kind. */
  async function trace(
    observation: SelectionObservation,
    knownRevisions: Array<{
      file: { workspaceId: string; path: string };
      revision: FileRevision;
    }> = []
  ) {
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

  /** The one verified result among a claim's frames: the frames below it are its callers. */
  function verified(results: ResolutionResult[]) {
    const found = results.filter((result) => result.state === "verified");
    expect(found).toHaveLength(1);
    const [result] = found;
    return result?.state === "verified"
      ? { file: result.target.file, location: result.target.location }
      : null;
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

  it("runs the variant it names", async () => {
    const served = (await server.transformRequest("/src/Card.tsx"))!.code;
    // A compiler bail-out would leave the "on" case proving nothing.
    expect(served.includes("react/compiler-runtime")).toBe(compiler);
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
      location: rangeOf(app, "export function App", "\n}"),
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

  it("calls a selection stale after an edit, never a line in the edited file, and traces it again once the page has it", async () => {
    const before = pick("h2.title");
    const pinned = [{ file: ref("src/Card.tsx"), revision: revision("src/Card.tsx") }];
    const edited = `// moved\n// down\n${FILES["src/Card.tsx"]}`;
    const cardPath = path.join(root, "src/Card.tsx");
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
        expect(results.filter((result) => result.state === "verified")).toEqual([]);
        expect(results).toContainEqual(
          expect.objectContaining({
            state: "stale",
            reason: "file-changed",
            currentFileRevision: revision("src/Card.tsx"),
          })
        );
      }
      // App.tsx is untouched, and still says where Card is called.
      expect(verified(lagging.component("Card").invocation)?.file).toEqual(ref("src/App.tsx"));

      // The dev server has the edit, the page does not: its frames are the old module's.
      const servedBefore = (await server.transformRequest("/src/Card.tsx"))!.code;
      server.watcher.emit("change", cardPath);
      await vi.waitFor(
        async () =>
          expect((await server.transformRequest("/src/Card.tsx"))!.code).not.toBe(servedBefore),
        { timeout: 5_000 }
      );
      const held = await trace(before, pinned);
      expect(held.element).toContainEqual(
        expect.objectContaining({
          state: "stale",
          reason: "file-changed",
          held: expect.objectContaining({ fileRevision: pinned[0]!.revision }),
          currentFileRevision: revision("src/Card.tsx"),
        })
      );
      expect(held.element.filter((result) => result.state === "verified")).toEqual([]);

      // The page runs the new module and the selection is made again: the new line.
      await render();
      const fresh = await trace(pick("h2.title"));
      expect(verified(fresh.element)).toEqual({
        file: ref("src/Card.tsx"),
        location: rangeOf(edited, "<h2", "</h2>"),
      });
      expect(rangeOf(edited, "<h2", "</h2>").line).toBe(
        rangeOf(FILES["src/Card.tsx"]!, "<h2", "</h2>").line + 2
      );
    } finally {
      fs.writeFileSync(cardPath, FILES["src/Card.tsx"]!);
      server.watcher.emit("change", cardPath);
    }
  });
});
