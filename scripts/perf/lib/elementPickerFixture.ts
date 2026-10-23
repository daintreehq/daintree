import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import nodeModule from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ElementPickerHost,
  HostChild,
} from "../../../electron/services/elementPicker/ElementPickerHost";
import type { SelectionObservation } from "../../../shared/elementPicker/observation";
import type { ResolutionResult } from "../../../shared/elementPicker/resolution";
import type { ResolveRequest } from "../../../shared/elementPicker/resolver";
import type { SourceCandidate } from "../../../shared/elementPicker/source";
import { UTILITY_HOST_CHILD } from "./ipcFixture";
import { createPerfTempRoot } from "./tempRoots";

/**
 * The Element Picker's source resolution, end to end below the renderer, for
 * PERF-410..412.
 *
 *   - REAL: `ElementPickerHost` in this process, as main runs it — admission,
 *     main's own file reads and map fetches, response checks — and the host
 *     process it forks: `host-bootstrap.ts` in its own OS process with the
 *     registry's own resolvers, the Svelte compiler, Babel's parser and the map
 *     decoder loaded the way a first selection loads them. The Svelte arm
 *     verifies an element in a real `.svelte` file; the React arm maps a
 *     `_debugStack`-shaped frame through the module's inline map, fetched over
 *     HTTP from a local origin, and verifies the JSX it lands on.
 *   - INDICATIVE: process start. Node's `fork` stands in for Electron's
 *     `utilityProcess.fork`, and the host's own TypeScript is transpiled by tsx
 *     as it loads, which a packaged build has done ahead of time. The packages
 *     that dominate a cold start — the compiler, the parser, the decoder — are
 *     plain JavaScript and load as they would.
 *   - ABSENT: the renderer, the page and its extractors, Chromium, and the
 *     Electron transport. Nothing here is a click-to-inspector latency.
 */

const HOST_BOOTSTRAP = fileURLToPath(
  new URL("../../../electron/services/elementPicker/host-bootstrap.ts", import.meta.url)
);
const PLUGIN_BOOTSTRAP = fileURLToPath(
  new URL("../../../electron/services/elementPicker/plugin-resolver-bootstrap.ts", import.meta.url)
);
/** The packaged fixture plugin's resolver, built here as its own build would. */
const LIT_RESOLVER_SOURCE = fileURLToPath(
  new URL(
    "../../../electron/services/elementPicker/__tests__/fixtures/plugins/lit-picker/src/resolver.ts",
    import.meta.url
  )
);
const SVELTE_FIXTURE = fileURLToPath(
  new URL(
    "../../../electron/services/elementPicker/__tests__/fixtures/svelte/native.svelte",
    import.meta.url
  )
);

export const SVELTE_FILE = "src/lib/native.svelte";
export const REACT_FILE = "src/Card.tsx";
export const LIT_FILE = "src/lit-card.ts";
const LIT_TAG = "fixture-lit-card";

const LIT_CARD = [
  'import { html } from "lit";',
  "",
  "export const card = (heading: string) => html`",
  `  <${LIT_TAG} heading=\${heading}></${LIT_TAG}>`,
  "`;",
  "",
].join("\n");

const CARD = [
  'import { useState } from "react";',
  "",
  "export function Card({ title }: { title: string }) {",
  "  const [open, setOpen] = useState(false);",
  "  return (",
  '    <section className="card" onClick={() => setOpen(!open)}>',
  '      <h2 className="card-title">{title}</h2>',
  "    </section>",
  "  );",
  "}",
  "",
].join("\n");

/** The selection's own ceilings, so the deadline a cold start races is the product's. */
const BUDGET: ResolveRequest["budget"] = {
  maxFiles: 32,
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
};

// --- electron stand-in --------------------------------------------------------

const ELECTRON_STUB_URL = `data:text/javascript,${encodeURIComponent(`
export const utilityProcess = { fork() { throw new Error("perf forks the host itself"); } };
export const app = { getPath: () => "", isPackaged: false, getAppPath: () => "" };
export default { utilityProcess, app };
`)}`;

let hooksInstalled = false;

/**
 * `ElementPickerHost` imports `utilityProcess` at module scope; the fixture
 * hands it a `fork` of its own, so the specifier only has to resolve.
 * Registered lazily, as every fixture here must (`moduleHookHygiene.test.ts`).
 */
function installElectronStub(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;
  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown
        ) => unknown;
      }) => void;
    }
  ).registerHooks;
  if (typeof registerHooks !== "function") {
    throw new Error("the Element Picker scenarios need module.registerHooks (Node 22.15+)");
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

// --- the fixed corpus -----------------------------------------------------------

interface Position {
  line: number;
  column: number;
}

interface Corpus {
  worktree: string;
  origin: string;
  svelte: { meta: Position; line: number };
  react: { url: string; frame: Position; line: number };
  /** The stamp a Lit element carries: 1-based line and column of its tag. */
  lit: Position;
  /** The fixture plugin's resolver, bundled to one ES module. */
  litResolver: string;
}

/** 1-based line and 0-based column of the first occurrence of `needle`. */
function positionOf(text: string, needle: string): Position {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`${needle} is not in the fixture`);
  return { line: index + 1, column: lines[index]!.indexOf(needle) };
}

let corpus: Promise<Corpus> | null = null;

/** Built once per process, outside every timed bracket. */
function loadCorpus(): Promise<Corpus> {
  corpus ??= (async () => {
    const worktree = createPerfTempRoot("daintree-perf-picker-", { canonical: true });
    process.env.DAINTREE_USER_DATA ??= createPerfTempRoot("daintree-perf-picker-userdata-");
    const put = (relative: string, contents: string) => {
      const target = join(worktree, ...relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    };
    put(
      "package.json",
      JSON.stringify({
        name: "picker-perf",
        private: true,
        devDependencies: { svelte: "^5.57.1", react: "^19.2.0", vite: "^8.0.0" },
      })
    );
    const svelteSource = readFileSync(SVELTE_FIXTURE, "utf8");
    put(SVELTE_FILE, svelteSource);
    put(REACT_FILE, CARD);
    put(LIT_FILE, LIT_CARD);

    // What a dev server serves for the module: JSX compiled to `jsxDEV` calls,
    // with its map inline, naming the file on disk.
    const { transform } = await import("esbuild");
    const served = await transform(CARD, {
      loader: "tsx",
      jsx: "automatic",
      jsxDev: true,
      format: "esm",
      sourcemap: "inline",
      sourcefile: join(worktree, ...REACT_FILE.split("/")),
    });
    const server = createServer((request, response) => {
      if (request.url?.startsWith(`/${REACT_FILE}`)) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(served.code);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    server.unref();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = positionOf(served.code, 'jsxDEV("h2"');
    const resolverBuild = await (
      await import("esbuild")
    ).build({
      entryPoints: [LIT_RESOLVER_SOURCE],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      write: false,
      logLevel: "silent",
      outfile: "resolver.mjs",
    });
    const litTag = positionOf(LIT_CARD, `<${LIT_TAG}`);

    return {
      worktree,
      origin,
      svelte: { meta: positionOf(svelteSource, "<h1"), line: positionOf(svelteSource, "<h1").line },
      react: {
        url: `${origin}/${REACT_FILE}?t=1`,
        // V8 numbers a frame's column from 1.
        frame: { line: call.line, column: call.column + 1 },
        line: positionOf(CARD, "<h2").line,
      },
      lit: { line: litTag.line, column: litTag.column + 1 },
      litResolver: resolverBuild.outputFiles[0]!.text,
    };
  })();
  return corpus;
}

// --- requests -------------------------------------------------------------------

export type PickerArm = "svelte" | "react";

const UNKNOWN = { state: "unknown" } as const;
let nextRequest = 0;

function observation(
  elementId: string,
  tagName: string,
  candidate: SourceCandidate
): SelectionObservation {
  return {
    phase: "selection",
    elementId,
    tagName,
    label: tagName,
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    detections: [],
    componentChain: { nearestId: null, components: [], truncated: false },
    sourceCandidates: [candidate],
    capabilities: {
      names: UNKNOWN,
      chain: UNKNOWN,
      componentSelection: UNKNOWN,
      file: UNKNOWN,
      line: UNKNOWN,
      exactRange: UNKNOWN,
    },
    frameworkEvidence: [],
  };
}

function observationFor(arm: PickerArm, data: Corpus): SelectionObservation {
  if (arm === "svelte") {
    return observation("el-svelte", "h1", {
      kind: "template-location",
      candidateId: "svelte-loc",
      framework: "svelte",
      extraction: { kind: "runtime-field", field: "__svelte_meta.loc" },
      file: SVELTE_FILE,
      location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", ...data.svelte.meta },
    });
  }
  return observation("el-react", "h2", {
    kind: "element-creation",
    candidateId: "react-frame",
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 1 },
    file: data.react.url,
    location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...data.react.frame },
  });
}

/** The authored line each arm's element is on: what a correct answer names. */
function expectedLine(arm: PickerArm, data: Corpus): number {
  return arm === "svelte" ? data.svelte.line : data.react.line;
}

function expectedPath(arm: PickerArm): string {
  return arm === "svelte" ? SVELTE_FILE : REACT_FILE;
}

/** Verified, in the right file, on the authored line: anything less is a miss. */
function isCorrect(arm: PickerArm, data: Corpus, result: ResolutionResult | undefined): boolean {
  if (result?.state !== "verified") return false;
  const target = result.target as { file: { path: string }; location: { line: number } | null };
  return (
    target.file.path === expectedPath(arm) && target.location?.line === expectedLine(arm, data)
  );
}

// --- the host -------------------------------------------------------------------

/** Bounded stderr tail kept per host, so a boot failure can say why. */
const STDERR_TAIL_LIMIT = 1500;

/** A forked host process, in the shape `ElementPickerHost` drives a utility process. */
class ForkedHost extends EventEmitter implements HostChild {
  readonly forkedAt = performance.now();
  readyAt: number | null = null;
  /** Null while running; 0 is a host that left on its own, as retirement does. */
  exitCode: number | null = null;
  stderrTail = "";
  /** Settles once the process's output has drained, which can be after `exit`. */
  readonly closed: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    super();
    this.closed = new Promise((resolve) => child.once("close", () => resolve()));
    child.on("spawn", () => this.emit("spawn"));
    child.on("message", (message: unknown) => {
      if (this.readyAt === null && (message as { type?: unknown })?.type === "ready") {
        this.readyAt = performance.now();
      }
      this.emit("message", message);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.on("exit", (code, signal) => this.end(code ?? (signal === null ? 0 : 1)));
    // A process that never started emits `error` and `close` with no `exit`.
    child.on("close", (code) => this.end(code ?? 1));
    child.on("error", (error) => this.emit("error", error));
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: unknown): void {
    this.child.send(message as object);
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }

  private end(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    liveChildren.delete(this.child);
    this.emit("exit", code);
  }
}

const liveChildren = new Set<ChildProcess>();
let reaperInstalled = false;

/** A host stranded by a throw or a signal must not outlive the run that forked it. */
function installReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const child of liveChildren) child.kill("SIGKILL");
    liveChildren.clear();
  };
  process.on("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      reap();
      process.exit(1);
    });
  }
}

function forkHost(entry = HOST_BOOTSTRAP): ForkedHost {
  installReaper();
  const child = fork(UTILITY_HOST_CHILD.entry, [], {
    execArgv: ["--import", "tsx"],
    // Structured clone, as Electron's MessagePort carries the host protocol.
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, [UTILITY_HOST_CHILD.hostEnv]: entry },
  });
  liveChildren.add(child);
  return new ForkedHost(child);
}

export interface PickerHostHarness {
  readonly host: ElementPickerHost;
  /** Every host process this harness forked, in order. */
  readonly forks: readonly ForkedHost[];
  /** Directory watches the host holds open right now. */
  activeWatches(): number;
  /** Host processes still running. */
  liveForks(): number;
  /** What opening the picker on a preview does to the host: register its worktree. */
  open(): Promise<string>;
  close(workspaceId: string): void;
  /** One selection per arm, in one request, as a page with both frameworks would send. */
  resolve(workspaceId: string, arms: readonly PickerArm[]): Promise<number>;
  /** Waits for every forked process to exit, up to `timeoutMs`. */
  settle(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
  /** Kills whatever is still running; for after a reading, never before one. */
  reap(): void;
  /** Every plugin resolver host this harness forked, in order. */
  readonly pluginForks: readonly ForkedHost[];
  /** Plugin resolver hosts still running. */
  livePluginForks(): number;
  /**
   * Installs `count` copies of the Lit fixture plugin, each its own plugin
   * with its own resolver host, plus `failing` plugins whose resolver kills
   * its own process. Registered as `loadPlugin` registers them; nothing starts.
   */
  installPlugins(count: number, failing?: number): Promise<{ lit: string[]; failing: string[] }>;
  /**
   * One selection naming a Lit element for each provider in `lit`, plus one
   * candidate per `failing` provider and, with `withSvelte`, a Svelte element.
   * Returns the Lit and Svelte answers that were NOT correct; a failing
   * provider's candidates must come back `unavailable`, or they count too.
   */
  resolvePlugins(
    workspaceId: string,
    lit: readonly string[],
    options?: { failing?: readonly string[]; withSvelte?: boolean }
  ): Promise<number>;
  /** Resident memory of a running process, in bytes, or null where `ps` cannot say. */
  residentBytes(pid: number | undefined): number | null;
}

let modules: Promise<
  typeof import("../../../electron/services/elementPicker/ElementPickerHost")
> | null = null;

function loadHostModule() {
  modules ??= (async () => {
    await loadCorpus();
    installElectronStub();
    return import("../../../electron/services/elementPicker/ElementPickerHost");
  })();
  return modules;
}

/** The registry the host reads, as the same module instance it imports. */
async function loadRegistry() {
  await loadHostModule();
  return import("../../../electron/services/elementPickerProviderRegistry");
}

let nextPlugin = 0;

/** A plugin resolver that takes its own process down mid-selection, as a crashing one would. */
const CRASHING_RESOLVER =
  "export default () => ({ resolve() { setImmediate(() => process.exit(70)); return new Promise(() => {}); } });\n";

function litObservation(elementId: string, providerId: string, data: Corpus): SelectionObservation {
  return {
    ...observation(elementId, LIT_TAG, {
      kind: "template-location",
      candidateId: "lit-source",
      framework: providerId,
      extraction: { kind: "attribute", attribute: "data-fixture-lit-source" },
      file: LIT_FILE,
      location: { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...data.lit },
    }),
    frameworkEvidence: [
      { kind: "generic", framework: providerId, fields: [{ name: "tag", value: LIT_TAG }] },
    ],
  };
}

function isLitCorrect(data: Corpus, result: ResolutionResult | undefined): boolean {
  if (result?.state !== "verified") return false;
  const target = result.target as { file: { path: string }; location: { line: number } | null };
  return target.file.path === LIT_FILE && target.location?.line === data.lit.line;
}

function residentBytes(pid: number | undefined): number | null {
  if (pid === undefined || process.platform === "win32") return null;
  try {
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }));
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * A fresh `ElementPickerHost`, as main builds one on the picker's first use.
 * `resolve` returns the number of arms that were NOT answered correctly.
 */
export async function createPickerHost(
  options: { idleMs?: number } = {}
): Promise<PickerHostHarness> {
  const [{ ElementPickerHost }, data, registry] = await Promise.all([
    loadHostModule(),
    loadCorpus(),
    loadRegistry(),
  ]);
  const forks: ForkedHost[] = [];
  const pluginForks: ForkedHost[] = [];
  const installed: string[] = [];
  let watches = 0;
  const host = new ElementPickerHost({
    fork: () => {
      const child = forkHost();
      forks.push(child);
      return child;
    },
    pluginFork: () => {
      const child = forkHost(PLUGIN_BOOTSTRAP);
      pluginForks.push(child);
      return child;
    },
    kill: (pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    },
    // Counted, never fired: the scenarios edit nothing, and a leftover watch
    // after a workspace closes is the leak this exists to see.
    watch: () => {
      watches += 1;
      let open = true;
      return () => {
        if (open) watches -= 1;
        open = false;
      };
    },
    idleMs: options.idleMs,
  });

  return {
    host,
    forks,
    activeWatches: () => watches,
    liveForks: () => forks.filter((child) => !child.exited).length,
    open: () =>
      host.registerWorkspace({
        worktreePath: data.worktree,
        previewOrigin: data.origin,
        onSourceChanged: () => {},
      }),
    close: (workspaceId) => {
      host.releaseWorkspace(workspaceId);
    },
    async resolve(workspaceId, arms) {
      nextRequest += 1;
      let response: Awaited<ReturnType<ElementPickerHost["resolve"]>>;
      try {
        response = await host.resolve({
          requestId: `perf-picker-${nextRequest}`,
          sessionId: "perf-picker",
          documentEpoch: 1,
          workspaceId,
          observations: arms.map((arm) => observationFor(arm, data)),
          knownRevisions: [],
          budget: BUDGET,
        } satisfies ResolveRequest);
      } catch (error) {
        const last = forks.at(-1);
        // A host that failed to boot may still be writing why.
        if (last?.exited) {
          await Promise.race([last.closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        }
        const tail = last?.stderrTail.trim();
        throw new Error(
          `the host failed the selection: ${error instanceof Error ? error.message : String(error)}` +
            (tail ? `\n${tail}` : ""),
          { cause: error }
        );
      }
      return arms.filter(
        (arm, index) => !isCorrect(arm, data, response.outcomes[index]?.results[0])
      ).length;
    },
    async settle(timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs;
      while (
        [...forks, ...pluginForks].some((child) => !child.exited) &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async dispose() {
      await host.dispose();
      for (const pluginId of installed.splice(0)) {
        registry.unregisterElementPickerProviders(pluginId);
      }
    },
    reap() {
      for (const child of [...forks, ...pluginForks]) child.kill();
    },
    pluginForks,
    livePluginForks: () => pluginForks.filter((child) => !child.exited).length,
    async installPlugins(count, failing = 0) {
      const install = (resolver: string) => {
        const name = `perf.lit${nextPlugin++}`;
        const dir = createPerfTempRoot("daintree-perf-picker-plugin-", { canonical: true });
        mkdirSync(join(dir, "dist", "picker"), { recursive: true });
        writeFileSync(join(dir, "dist", "picker", "resolver.mjs"), resolver);
        registry.registerElementPickerProviders(
          name,
          name,
          [
            {
              id: "lit",
              name: "Lit",
              detection: [{ kind: "global", name: "litElementVersions", match: "exact" }],
              guestEntry: "dist/picker/lit.js",
              resolverEntry: "dist/picker/resolver.mjs",
            },
          ],
          dir
        );
        installed.push(name);
        return `${name}.lit`;
      };
      return {
        lit: Array.from({ length: count }, () => install(data.litResolver)),
        failing: Array.from({ length: failing }, () => install(CRASHING_RESOLVER)),
      };
    },
    async resolvePlugins(workspaceId, lit, options = {}) {
      nextRequest += 1;
      const failing = options.failing ?? [];
      const observations: SelectionObservation[] = [
        ...(options.withSvelte ? [observationFor("svelte", data)] : []),
        ...lit.map((providerId, index) => litObservation(`el-lit-${index}`, providerId, data)),
        ...failing.map((providerId, index) =>
          litObservation(`el-failing-${index}`, providerId, data)
        ),
      ];
      const response = await host.resolve({
        requestId: `perf-picker-${nextRequest}`,
        sessionId: "perf-picker",
        documentEpoch: 1,
        workspaceId,
        observations,
        knownRevisions: [],
        budget: BUDGET,
      } satisfies ResolveRequest);
      const resultOf = (elementId: string) =>
        response.outcomes.find((outcome) => outcome.elementId === elementId)?.results[0];
      let misses = 0;
      if (options.withSvelte && !isCorrect("svelte", data, resultOf("el-svelte"))) misses += 1;
      lit.forEach((_, index) => {
        if (!isLitCorrect(data, resultOf(`el-lit-${index}`))) misses += 1;
      });
      failing.forEach((_, index) => {
        if (resultOf(`el-failing-${index}`)?.state !== "unavailable") misses += 1;
      });
      return misses;
    },
    residentBytes,
  };
}

/** Bytes of heap in use after a full collection; the dispatcher runs with `--expose-gc`. */
export function settledHeapBytes(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") {
    throw new Error("PERF-412 reads retained heap and needs node --expose-gc");
  }
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}
