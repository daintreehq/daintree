import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { ComponentRecord } from "../../../../shared/elementPicker/component.js";
import type { SvelteEvidence } from "../../../../shared/elementPicker/evidence.js";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import type {
  FileRevision,
  ResolutionResult,
} from "../../../../shared/elementPicker/resolution.js";
import type {
  ResolveBudget,
  ResolveRequest,
  ResolveResponse,
  ResolverSourceAccess,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { checkResolveResponse } from "../checkResponse.js";
import { observationCandidates } from "../outcomes.js";
import { JobSourceAccess, type SourceRoots } from "../sourceAccess.js";
import { svelteResolver } from "../worker/resolvers/svelte.js";

/**
 * The Svelte resolver against real files through main's own source access: a
 * temp monorepo whose app is not its worktree, real containment and bounded
 * reads, and every answer held to the checks main applies before it passes one
 * on.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures", "svelte");

export const WORKSPACE = "ws-1";
/** Where the app sits in the worktree, so every ref the resolver names starts here. */
export const APP = "apps/site";

export interface Sandbox {
  root: string;
  worktree: string;
  appRoot: string;
  roots: SourceRoots;
  /** App-relative, as Svelte reports a file, to absolute. */
  file(appRelative: string): string;
  write(appRelative: string, contents: string | Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * A worktree whose app lives at `apps/site`, with a shared UI package beside
 * it and a file outside the worktree: the layout where "relative to the Vite
 * root" and "relative to the worktree" differ. `kit: false` is a plain Svelte
 * app, which depends on Svelte and Vite and nothing of SvelteKit's.
 */
export async function createSandbox(options: { kit?: boolean } = {}): Promise<Sandbox> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "picker-svelte-")));
  const worktree = path.join(root, "worktree");
  const appRoot = path.join(worktree, ...APP.split("/"));
  const put = async (target: string, contents: string | Uint8Array) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  };
  const dependencies =
    options.kit === false
      ? { svelte: "^5.57.1", vite: "^8.0.0" }
      : { "@sveltejs/kit": "^2.0.0", svelte: "^5.57.1", vite: "^8.0.0" };

  await put(path.join(worktree, "package.json"), JSON.stringify({ name: "mono", private: true }));
  await put(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "site", devDependencies: dependencies })
  );
  for (const name of ["native.svelte", "invocations.svelte", "card.svelte"]) {
    await put(path.join(appRoot, "src", "lib", name), await fs.readFile(path.join(FIXTURES, name)));
  }
  await put(path.join(appRoot, "src", "routes", "+page.svelte"), "<h1>Home</h1>\n");
  await put(
    path.join(appRoot, ".svelte-kit", "generated", "root.svelte"),
    '<div id="svelte-announcer">x</div>\n'
  );
  await put(
    path.join(worktree, "packages", "ui", "Button.svelte"),
    '<button class="p-2">Go</button>\n'
  );
  await put(path.join(root, "outside.svelte"), '<p class="secret">outside</p>\n');

  const file = (appRelative: string) => path.join(appRoot, ...appRelative.split("/"));
  return {
    root,
    worktree,
    appRoot,
    roots: { worktreePath: worktree, appRoot },
    file,
    write: (appRelative, contents) => put(file(appRelative), contents),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export function revisionOf(bytes: Uint8Array | string): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function revisionOfFile(absolute: string): Promise<FileRevision> {
  return revisionOf(await fs.readFile(absolute));
}

/** The ref the resolver should name for an app-relative file. */
export function ref(appRelative: string) {
  return { workspaceId: WORKSPACE, path: `${APP}/${appRelative}` };
}

/** Where a marker starts, as `__svelte_meta` reports it: 1-based line, 0-based column. */
export function locationOf(source: string, marker: string, from = 0): SourceLocation {
  const offset = source.indexOf(marker, from);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  return { ...positionOf(source, offset), lineBase: 1, columnBase: 0, columnUnit: "utf16" };
}

function positionOf(source: string, offset: number) {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) };
}

/** The location a verified element or tag resolves to: from its `<` to the end of its closing tag. */
export function rangeOf(source: string, start: string, end: string, from = 0): SourceLocation {
  const startOffset = source.indexOf(start, from);
  const endOffset = source.indexOf(end, startOffset) + end.length;
  return { ...locationOf(source, start, from), end: positionOf(source, endOffset) };
}

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

export function templateLocation(file: string, location: SourceLocation | null): SourceCandidate {
  return {
    kind: "template-location",
    candidateId: id("c"),
    framework: "svelte",
    extraction: { kind: "runtime-field", field: "__svelte_meta.loc" },
    file,
    location,
  };
}

export function fileHint(file: string): SourceCandidate {
  return {
    kind: "file-hint",
    candidateId: id("c"),
    framework: "svelte",
    extraction: { kind: "runtime-field", field: "__svelte_meta.loc.file" },
    file,
  };
}

export interface CallSite {
  file: string;
  line: number;
  column: number;
}

export function invocation(site: CallSite): SourceCandidate {
  return {
    kind: "component-invocation",
    candidateId: id("c"),
    framework: "svelte",
    extraction: { kind: "runtime-field", field: "__svelte_meta.parent" },
    file: site.file,
    location: {
      lineBase: 1,
      columnBase: 0,
      columnUnit: "utf16",
      line: site.line,
      column: site.column,
    },
  };
}

export function component(sourceCandidates: SourceCandidate[]): ComponentRecord {
  return {
    componentId: id("component"),
    framework: "svelte",
    name: null,
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates,
  };
}

export function evidence(overrides: Partial<SvelteEvidence> = {}): SvelteEvidence {
  return { kind: "svelte", ancestry: [], sameLocCount: 1, unmapped: false, ...overrides };
}

export function selection(
  options: {
    tagName?: string;
    sourceCandidates?: SourceCandidate[];
    components?: ComponentRecord[];
    evidence?: SvelteEvidence;
  } = {}
): SelectionObservation {
  const unknown = { state: "unknown" } as const;
  const components = options.components ?? [];
  return {
    phase: "selection",
    elementId: id("el"),
    tagName: options.tagName ?? "DIV",
    label: "node",
    bounds: [{ x: 0, y: 0, width: 10, height: 10 }],
    detections: [],
    componentChain: {
      nearestId: components[0]?.componentId ?? null,
      components,
      truncated: false,
    },
    sourceCandidates: options.sourceCandidates ?? [],
    capabilities: {
      names: unknown,
      chain: unknown,
      componentSelection: unknown,
      file: unknown,
      line: unknown,
      exactRange: unknown,
    },
    frameworkEvidence: options.evidence ? [options.evidence] : [],
  };
}

export const FULL_BUDGET: ResolveBudget = {
  maxFiles: 32,
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
};

export interface Resolved {
  request: ResolveRequest;
  response: ResolveResponse;
  results: ResolutionResult[];
  /** Every ref the resolver asked main to read, worktree-relative, in order. */
  reads: string[];
}

export async function resolveIn(
  sandbox: Sandbox,
  observations: SelectionObservation[],
  options: {
    knownRevisions?: ResolveRequest["knownRevisions"];
    budget?: Partial<ResolveBudget>;
  } = {}
): Promise<Resolved> {
  const controller = new AbortController();
  const budget = { ...FULL_BUDGET, ...options.budget };
  const job = new JobSourceAccess({
    workspaceId: WORKSPACE,
    roots: sandbox.roots,
    budget,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: null,
    sourceMaps: async () => ({ ok: false, reason: "unsupported" }),
    onRead: () => {},
  });
  const reads: string[] = [];
  const access: ResolverSourceAccess = {
    readSource: (file) => {
      reads.push(file.path);
      return job.readSource(file);
    },
    fetchSourceMap: (generatedUrl) => job.fetchSourceMap(generatedUrl),
    locateSource: ({ generatedUrl, source, sourceRoot }) =>
      job.locateSource(generatedUrl, source, sourceRoot),
    locateFile: async (reported) => job.locateFile(reported),
  };
  const request: ResolveRequest = {
    requestId: id("request"),
    sessionId: "session",
    documentEpoch: 3,
    workspaceId: WORKSPACE,
    observations,
    knownRevisions: options.knownRevisions ?? [],
    budget,
  };
  const response = await svelteResolver.resolve(request, access, controller.signal);

  // Exactly one answer per candidate, in the order the request listed them...
  expect(
    response.outcomes.map((outcome) => outcome.results.map((result) => result.candidateId))
  ).toEqual(
    request.observations.map((observation) =>
      observationCandidates(observation).map((candidate) => candidate.candidateId)
    )
  );
  // ...and one main would pass on: contained, revisions it served, claims kept.
  expect(
    checkResolveResponse(request, response, {
      roots: sandbox.roots,
      servedRevision: (file) => job.servedRevision(file),
    })
  ).toEqual(response);
  controller.abort();
  return {
    request,
    response,
    results: response.outcomes.flatMap((outcome) => outcome.results),
    reads,
  };
}

/** The one result a single-candidate resolve produced. */
export async function resolveOne(
  sandbox: Sandbox,
  observation: SelectionObservation,
  options: Parameters<typeof resolveIn>[2] = {}
): Promise<ResolutionResult> {
  const { results } = await resolveIn(sandbox, [observation], options);
  expect(results).toHaveLength(1);
  return results[0]!;
}
