import { fork, type ChildProcess } from "node:child_process";
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
const SVELTE_FIXTURE = fileURLToPath(
  new URL(
    "../../../electron/services/elementPicker/__tests__/fixtures/svelte/native.svelte",
    import.meta.url
  )
);

export const SVELTE_FILE = "src/lib/native.svelte";
export const REACT_FILE = "src/Card.tsx";

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

  constructor(private readonly child: ChildProcess) {
    super();
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

function forkHost(): ForkedHost {
  installReaper();
  const child = fork(UTILITY_HOST_CHILD.entry, [], {
    execArgv: ["--import", "tsx"],
    // Structured clone, as Electron's MessagePort carries the host protocol.
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, [UTILITY_HOST_CHILD.hostEnv]: HOST_BOOTSTRAP },
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

/**
 * A fresh `ElementPickerHost`, as main builds one on the picker's first use.
 * `resolve` returns the number of arms that were NOT answered correctly.
 */
export async function createPickerHost(
  options: { idleMs?: number } = {}
): Promise<PickerHostHarness> {
  const [{ ElementPickerHost }, data] = await Promise.all([loadHostModule(), loadCorpus()]);
  const forks: ForkedHost[] = [];
  let watches = 0;
  const host = new ElementPickerHost({
    fork: () => {
      const child = forkHost();
      forks.push(child);
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
        const tail = forks.at(-1)?.stderrTail.trim();
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
      while (forks.some((child) => !child.exited) && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async dispose() {
      await host.dispose();
    },
    reap() {
      for (const child of forks) child.kill();
    },
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
