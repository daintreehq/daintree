import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { SourceLocation } from "../../../../shared/elementPicker/coordinates.js";
import type { ComponentRecord } from "../../../../shared/elementPicker/component.js";
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
import { preactResolver } from "../worker/resolvers/preact.js";

/**
 * The Preact resolver against real files through main's own source access: a
 * temp worktree whose app is not at its root, real containment and bounded
 * reads, and every answer held to the checks main applies before it passes
 * one on.
 */

export const WORKSPACE = "ws-1";
/** Where the app sits in the worktree, so every ref the resolver names starts here. */
export const APP = "apps/web";

export interface Sandbox {
  root: string;
  roots: SourceRoots;
  /** App-relative to absolute, as a jsx-source `fileName` names a module. */
  file(appRelative: string): string;
  write(appRelative: string, contents: string | Uint8Array): Promise<void>;
  remove(appRelative: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "picker-preact-")));
  const worktree = path.join(root, "worktree");
  const appRoot = path.join(worktree, ...APP.split("/"));
  const put = async (target: string, contents: string | Uint8Array) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  };
  await put(path.join(worktree, "package.json"), JSON.stringify({ name: "mono", private: true }));
  await put(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "web", dependencies: { preact: "^11.0.1" } })
  );
  await put(path.join(root, "Outside.tsx"), "export const Outside = () => <p>outside</p>;\n");
  const file = (appRelative: string) => path.join(appRoot, ...appRelative.split("/"));
  return {
    root,
    roots: { worktreePath: worktree, appRoot },
    file,
    write: (appRelative, contents) => put(file(appRelative), contents),
    remove: (appRelative) => fs.rm(file(appRelative), { force: true }),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export function revisionOf(bytes: Uint8Array | string): FileRevision {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The ref the resolver should name for an app-relative file. */
export function ref(appRelative: string) {
  return { workspaceId: WORKSPACE, path: `${APP}/${appRelative}` };
}

/** Where `marker` starts in `source`, as jsx-source numbers it: 1-based line and column. */
export function at(source: string, marker: string, from = 0): SourceLocation {
  const offset = source.indexOf(marker, from);
  if (offset < 0) throw new Error(`marker ${marker} not found`);
  return { lineBase: 1, columnBase: 1, columnUnit: "utf16", ...positionOf(source, offset) };
}

export function positionOf(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  return { line: before.split("\n").length, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

let nextId = 1;
const id = (prefix: string) => `${prefix}-${nextId++}`;

export function creation(
  file: string,
  location: SourceLocation,
  extraction: SourceCandidate["extraction"] = { kind: "runtime-field", field: "__source" }
): SourceCandidate {
  return {
    kind: "element-creation",
    candidateId: id("c"),
    framework: "preact",
    extraction,
    file,
    location,
  };
}

export function invocation(file: string, location: SourceLocation): SourceCandidate {
  return {
    kind: "component-invocation",
    candidateId: id("c"),
    framework: "preact",
    extraction: { kind: "runtime-field", field: "__source" },
    file,
    location,
  };
}

export function component(sourceCandidates: SourceCandidate[]): ComponentRecord {
  return {
    componentId: id("component"),
    framework: "preact",
    name: null,
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates,
  };
}

export function selection(
  options: {
    tagName?: string;
    sourceCandidates?: SourceCandidate[];
    components?: ComponentRecord[];
  } = {}
): SelectionObservation {
  const unknown = { state: "unknown" } as const;
  const components = options.components ?? [];
  return {
    phase: "selection",
    elementId: id("el"),
    tagName: options.tagName ?? "div",
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
    frameworkEvidence: [],
  };
}

const FULL_BUDGET: ResolveBudget = {
  maxFiles: 32,
  maxFileBytes: 1024 * 1024,
  maxNetworkRequests: 8,
  maxNetworkBytes: 4 * 1024 * 1024,
  deadlineMs: 5_000,
};

export interface Resolved {
  response: ResolveResponse;
  results: ResolutionResult[];
  /** Every ref the resolver asked main to read, worktree-relative, in order. */
  reads: string[];
  /** Source maps the resolver asked main for. */
  maps: string[];
}

export async function resolveIn(
  sandbox: Sandbox,
  observations: SelectionObservation[],
  options: {
    knownRevisions?: ResolveRequest["knownRevisions"];
    /** Runs as each read is asked for, with a way to withdraw the job right there. */
    beforeRead?: (file: string, cancel: () => void) => void;
  } = {}
): Promise<Resolved> {
  const controller = new AbortController();
  const job = new JobSourceAccess({
    workspaceId: WORKSPACE,
    roots: sandbox.roots,
    budget: FULL_BUDGET,
    signal: controller.signal,
    expired: () => false,
    previewOrigin: null,
    sourceMaps: async () => ({ ok: false, reason: "unsupported" }),
    onRead: () => {},
  });
  const reads: string[] = [];
  const maps: string[] = [];
  const access: ResolverSourceAccess = {
    readSource: (file) => {
      reads.push(file.path);
      options.beforeRead?.(file.path, () => controller.abort());
      return job.readSource(file);
    },
    fetchSourceMap: (generatedUrl) => {
      maps.push(generatedUrl);
      return job.fetchSourceMap(generatedUrl);
    },
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
    budget: FULL_BUDGET,
  };
  const response = await preactResolver.resolve(request, access, controller.signal);

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
      servedMap: (mapUrl, revision) => job.servedMap(mapUrl, revision),
    })
  ).toEqual(response);
  controller.abort();
  return {
    response,
    results: response.outcomes.flatMap((outcome) => outcome.results),
    reads,
    maps,
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
