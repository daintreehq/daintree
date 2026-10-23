import type {
  ComponentRecord,
  ElementPickerProviderId,
  FileRevision,
  ProjectContextOutcome,
  ResolutionResult,
  SelectionObservation,
  SelectionScope,
  SourceCandidate,
  SourceFileRef,
  SourceLocation,
  SvelteEvidence,
} from "@shared/elementPicker";
import { untestedVersionNotes } from "@shared/elementPicker/sveltekit/versionNotes";
import type { AgentPromptInput, PromptProject, PromptScope } from "./agentPrompt.js";
import { untestedToolchainPromptLine } from "./copy.js";

/**
 * One selection as the picker holds it: what the page observed, exactly as it
 * reported it, beside what the host made of each claim. Nothing in it is
 * rewritten into another shape; everything a surface shows is read off these
 * two, so a name, a file or a line never loses the provenance it came with.
 *
 * A page with no source to trace — no framework metadata, no worktree, or a
 * workspace that could not be opened — gives a selection like any other, with
 * nothing resolved; the request built from it says so.
 */
export interface PickedSelection {
  selectionId: string;
  previewPanelId: string;
  sessionId: string;
  documentEpoch: number;
  /** The workspace its claims were resolved in; null when none was asked. */
  workspaceId: string | null;
  /** That workspace's app, worktree-relative; `.` for the worktree itself. */
  appPath: string | null;
  /** Redacted, and still the page's to influence. */
  displayedUrl: string;
  viewport: Viewport;
  /** The selected elements, primary first, as the page reported them. */
  observations: SelectionObservation[];
  /** What the host made of each element's claims, by element id; absent for one nothing was asked about. */
  results: Readonly<Record<string, readonly ResolutionResult[]>>;
  scope: SelectionScope;
  capturedAt: string;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface SourcePoint {
  file: string;
  line: number;
  column: number;
}

/** A place the host holds in the worktree: a file, and a 1-based line when it found one. */
export interface HeldPlace {
  path: string;
  line: number | null;
}

/** The picture of a selection, cropped from the preview, or why there isn't one. */
export type PageScreenshot =
  { status: "attached"; path: string } | { status: "omitted"; reason: string };

export function primaryObservation(selection: PickedSelection): SelectionObservation | undefined {
  return selection.observations[0];
}

/** Whether the page reported anything about the selection's source: a claim, or a component around it. */
export function isTraced(selection: PickedSelection): boolean {
  return selection.observations.some(
    (observation) =>
      observation.sourceCandidates.length > 0 || observation.componentChain.components.length > 0
  );
}

export function resultsOf(
  selection: PickedSelection,
  observation: SelectionObservation
): readonly ResolutionResult[] {
  return selection.results[observation.elementId] ?? [];
}

/**
 * The host's answer to one claim. Matched by claim as well as id: a result for
 * another claim about the same candidate would cite one fact as another.
 */
export function resultFor(
  results: readonly ResolutionResult[],
  candidate: SourceCandidate
): ResolutionResult | undefined {
  return results.find(
    (result) => result.candidateId === candidate.candidateId && result.claim === candidate.kind
  );
}

/** 1-based, whichever base the runtime counted from. */
export function displayLine(location: SourceLocation): number {
  return location.line - location.lineBase + 1;
}

/** Where a result holds its claim now; null for a result that holds nothing. */
function heldBy(result: ResolutionResult | undefined): HeldPlace | null {
  if (
    result === undefined ||
    (result.state !== "verified" && result.state !== "mapped" && result.state !== "observed")
  ) {
    return null;
  }
  const location = result.claim === "file-hint" ? null : result.target.location;
  return {
    path: result.target.file.path,
    line: location === null ? null : displayLine(location),
  };
}

const ELEMENT_CLAIMS: ReadonlySet<SourceCandidate["kind"]> = new Set([
  "template-location",
  "element-creation",
]);

/**
 * Where the element itself is written, as the host found it: its template
 * location or creation site, else a file it was hinted to be in. Null when
 * the host holds no place for it; the page's own report is never shown as one.
 */
export function elementPlace(
  selection: PickedSelection,
  observation: SelectionObservation | undefined = primaryObservation(selection)
): HeldPlace | null {
  if (observation === undefined) return null;
  const results = resultsOf(selection, observation);
  let hinted: HeldPlace | null = null;
  for (const candidate of observation.sourceCandidates) {
    const held = heldBy(resultFor(results, candidate));
    if (held === null) continue;
    if (ELEMENT_CLAIMS.has(candidate.kind)) return held;
    hinted ??= held;
  }
  return hinted;
}

/** The first claim of this kind the page made about the element, with the host's answer to it. */
export function elementClaim(
  selection: PickedSelection,
  observation: SelectionObservation
): { candidate: SourceCandidate; result: ResolutionResult | undefined } | null {
  const results = resultsOf(selection, observation);
  const candidate = observation.sourceCandidates.find((entry) => ELEMENT_CLAIMS.has(entry.kind));
  return candidate === undefined ? null : { candidate, result: resultFor(results, candidate) };
}

export function svelteEvidence(observation: SelectionObservation): SvelteEvidence | undefined {
  return observation.frameworkEvidence.find(
    (entry): entry is SvelteEvidence => entry.kind === "svelte"
  );
}

/**
 * The components an element sits inside, innermost first. Render edges where
 * the page reported them, walked from the nearest; a page that reported no
 * edges at all (Svelte's parent chain names call sites, not a render tree)
 * keeps the order it listed them in. An omitted edge ends the walk: it was not
 * observed, which is not the same as there being nothing further out.
 */
export function chainOf(
  observation: Pick<SelectionObservation, "componentChain">
): ComponentRecord[] {
  const chain = observation.componentChain;
  if (!chain.components.some((record) => record.renderParentId !== undefined)) {
    return [...chain.components];
  }
  const byId = new Map(chain.components.map((record) => [record.componentId, record]));
  const walked: ComponentRecord[] = [];
  const seen = new Set<string>();
  for (let id = chain.nearestId; id !== null && !seen.has(id);) {
    const record = byId.get(id);
    if (record === undefined) break;
    seen.add(id);
    walked.push(record);
    id = record.renderParentId ?? null;
  }
  return walked;
}

/** One component on the chain, as the trail and the request scopes show it. */
export interface ComponentView {
  componentId: string;
  framework: ElementPickerProviderId;
  /** The name the page gave it; null for one it didn't name. */
  name: string | null;
  /**
   * The call site the page reported, in its own spelling: what the page is
   * asked for the component by, and what tells two invocations apart.
   */
  usedAt: SourcePoint | null;
  /** Where the host found that call site, when it did. */
  usedAtPlace: HeldPlace | null;
  /** The file the host found the component written in; null until proven. */
  definedIn: HeldPlace | null;
  /** Whether the file came from following the import at the call site, rather than a claim of its own. */
  definedByImport: boolean;
}

export function componentView(
  results: readonly ResolutionResult[],
  record: ComponentRecord
): ComponentView {
  const invocation = record.sourceCandidates.find(
    (candidate): candidate is Extract<SourceCandidate, { kind: "component-invocation" }> =>
      candidate.kind === "component-invocation"
  );
  const invoked = invocation ? resultFor(results, invocation) : undefined;
  let definedIn: HeldPlace | null = null;
  let definedByImport = false;
  if (invoked?.state === "verified" && invoked.definition) {
    definedIn = { path: invoked.definition.file.path, line: null };
    definedByImport = true;
  } else {
    for (const candidate of record.sourceCandidates) {
      if (candidate.kind !== "component-definition" && candidate.kind !== "file-hint") continue;
      const held = heldBy(resultFor(results, candidate));
      if (held !== null) {
        definedIn = held;
        break;
      }
    }
  }
  return {
    componentId: record.componentId,
    framework: record.framework,
    name: record.name?.value ?? null,
    usedAt: invocation
      ? {
          file: invocation.file,
          line: invocation.location.line,
          column: invocation.location.column,
        }
      : null,
    usedAtPlace: heldBy(invoked),
    definedIn,
    definedByImport,
  };
}

/** Framework output and dependencies: real ancestors of what the page shows, never the user's to edit. */
const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".svelte-kit"]);

function isGeneratedPath(file: string): boolean {
  return file
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => GENERATED_DIRECTORIES.has(segment));
}

/**
 * The chain of the selection's primary element, innermost first, as views.
 * A component called from generated code is left off: nothing the user wrote
 * invoked it, so the trail does not offer it and no request is about it.
 */
export function componentsOf(selection: PickedSelection): ComponentView[] {
  const observation = primaryObservation(selection);
  if (observation === undefined) return [];
  const results = resultsOf(selection, observation);
  return chainOf(observation)
    .map((record) => componentView(results, record))
    .filter((component) => component.usedAt === null || !isGeneratedPath(component.usedAt.file));
}

/** The component a component selection is of, when the primary element's chain names it. */
export function pickedComponent(selection: PickedSelection): ComponentView | null {
  const scope = selection.scope;
  if (scope.kind !== "component") return null;
  const observation = primaryObservation(selection);
  const record = observation?.componentChain.components.find(
    (entry) => entry.componentId === scope.componentId
  );
  return observation && record ? componentView(resultsOf(selection, observation), record) : null;
}

export function samePoint(a: SourcePoint | null, b: SourcePoint | null): boolean {
  return (
    a !== null && b !== null && a.file === b.file && a.line === b.line && a.column === b.column
  );
}

/**
 * What a request is about: the clicked element, a component around it, or the
 * file the outermost component (or the element, with none) is written in — a
 * route page or a layout. A component scope carries the file it is written in
 * once the host has proven one; until then it can be shown but never sent.
 */
export type TaskScope =
  | { kind: "element"; label: string }
  | {
      kind: "component";
      label: string;
      componentId: string;
      /** Worktree-relative file the component is written in; null when not proven. */
      file: string | null;
      usedAt: SourcePoint | null;
    }
  | { kind: "file"; label: string; file: string };

/** The label a file is offered under: `+page.svelte` as itself, `Card.svelte` as `Card`. */
export function fileLabel(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.startsWith("+")) return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function elementLabel(observation: SelectionObservation | undefined): string {
  if (observation === undefined) return "element";
  return observation.label || observation.tagName.toLowerCase() || "element";
}

/**
 * Every scope a request about this selection can take, innermost first. The
 * picked component, when there is one, is placed by its id; a component the
 * chain does not name is still what the user picked, so it is offered first.
 */
export function scopesFor(selection: PickedSelection): {
  scopes: TaskScope[];
  pickedIndex: number;
} {
  const observation = primaryObservation(selection);
  if (observation === undefined) return { scopes: [], pickedIndex: 0 };
  const scopes: TaskScope[] = [{ kind: "element", label: elementLabel(observation) }];
  const components = componentsOf(selection);
  for (const component of components) {
    scopes.push({
      kind: "component",
      label:
        component.name ?? (component.definedIn ? fileLabel(component.definedIn.path) : "component"),
      componentId: component.componentId,
      file: component.definedIn?.path ?? null,
      usedAt: component.usedAt,
    });
  }
  // The outermost file the host placed anything in: where the outermost call
  // site is written, or the element itself with no chain above it.
  const outermost =
    components.length > 0
      ? components[components.length - 1]!.usedAtPlace
      : elementPlace(selection, observation);
  if (
    outermost !== null &&
    !components.some((component) => component.definedIn?.path === outermost.path)
  ) {
    scopes.push({ kind: "file", label: fileLabel(outermost.path), file: outermost.path });
  }
  const picked = pickedComponent(selection);
  if (picked === null) return { scopes, pickedIndex: 0 };
  const index = scopes.findIndex(
    (scope) => scope.kind === "component" && scope.componentId === picked.componentId
  );
  if (index > 0) return { scopes, pickedIndex: index };
  scopes.splice(1, 0, {
    kind: "component",
    label: picked.name ?? "component",
    componentId: picked.componentId,
    file: picked.definedIn?.path ?? null,
    usedAt: picked.usedAt,
  });
  return { scopes, pickedIndex: 1 };
}

/**
 * Where `chosen` sits in `scopes`, by what it is rather than where it sat: a
 * component added to the chain moves every index above it, and ids are minted
 * per document, so a component is matched by its name, file and call site.
 * -1 when the chain no longer names it.
 */
export function matchScope(chosen: TaskScope | undefined, scopes: readonly TaskScope[]): number {
  if (chosen === undefined) return -1;
  return scopes.findIndex((candidate) => {
    if (candidate.kind !== chosen.kind) return false;
    if (candidate.kind === "element") return true;
    if (candidate.kind === "file") return chosen.kind === "file" && candidate.file === chosen.file;
    return (
      chosen.kind === "component" &&
      candidate.label === chosen.label &&
      candidate.file === chosen.file &&
      (candidate.usedAt === null) === (chosen.usedAt === null) &&
      (candidate.usedAt === null || samePoint(candidate.usedAt, chosen.usedAt))
    );
  });
}

/** Whether a scope names a component nobody has proven the file of. */
export function isUnresolvedScope(scope: TaskScope | undefined): boolean {
  return scope?.kind === "component" && scope.file === null;
}

/**
 * The revision every file the selection's claims were checked against had
 * when it was read, by worktree-relative path. A claim held without reading
 * its file (mapped, or as reported) cites no revision and is not here: the
 * request already says it was not checked. Two reads of one file that
 * disagree prove neither, and that file is null.
 */
export function citedRevisions(selection: PickedSelection): Record<string, FileRevision | null> {
  const revisions: Record<string, FileRevision | null> = {};
  const record = (path: string, revision: FileRevision | null) => {
    if (revision === null) return;
    revisions[path] = path in revisions && revisions[path] !== revision ? null : revision;
  };
  for (const results of Object.values(selection.results)) {
    for (const result of results) {
      if (result.state === "verified" || result.state === "mapped" || result.state === "observed") {
        record(result.target.file.path, result.fileRevision);
      }
      if (result.state === "verified" && result.definition) {
        record(result.definition.file.path, result.definition.fileRevision);
      }
    }
  }
  return revisions;
}

/**
 * Every file the host placed one of the selection's claims in, read or not:
 * the files whose change puts what the selection says in doubt. A mapped
 * claim carries no revision to compare, but an edit to its file still moves
 * the line it names.
 */
export function heldPaths(selection: PickedSelection): Set<string> {
  const paths = new Set<string>();
  for (const results of Object.values(selection.results)) {
    for (const result of results) {
      if (result.state === "verified" || result.state === "mapped" || result.state === "observed") {
        paths.add(result.target.file.path);
      }
      if (result.state === "verified" && result.definition) paths.add(result.definition.file.path);
    }
  }
  return paths;
}

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The app and the route around the page, as the host read them. Null when
 * nothing was read and there is no app to name.
 */
export function promptProject(
  selection: PickedSelection,
  outcome: ProjectContextOutcome | null
): PromptProject | null {
  const appPath = selection.appPath === null || selection.appPath === "." ? "" : selection.appPath;
  let project: PromptProject | null =
    selection.appPath === null ? null : { appPath, stack: [], notes: [], route: null };
  if (outcome?.status === "described") {
    const context = outcome.context;
    const { svelte, kit, tailwind } = context.toolchain.versions;
    const untested = untestedVersionNotes({ svelte, kit });
    project = {
      appPath: context.appPath === "." ? "" : context.appPath,
      stack: [
        kit ? `SvelteKit ${kit}` : null,
        svelte ? `Svelte ${svelte}` : null,
        tailwind ? `Tailwind ${tailwind}` : "no Tailwind",
      ].filter((part): part is string => part !== null),
      // Version skew is the agent's to know about: the locations were checked
      // by a compiler tested against other majors.
      notes: untested.length > 0 ? [untestedToolchainPromptLine(untested)] : [],
      route: context.route
        ? {
            id: context.route.routeId,
            files: context.route.files.map((entry) => ({
              role: entry.role,
              path: entry.file.path,
            })),
          }
        : null,
    };
  }
  if (project === null || project.appPath === "") return project;
  // Svelte reports files relative to the app, so in a monorepo a quoted path
  // is only findable from the worktree with the app's place in front of it.
  return {
    ...project,
    notes: [...project.notes, "- Files the page reports are relative to the app, not the worktree"],
  };
}

function promptScope(selection: PickedSelection, scope: TaskScope | undefined): PromptScope {
  if (scope === undefined || scope.kind === "element") return { kind: "element" };
  const workspaceId = selection.workspaceId;
  if (scope.kind === "file") {
    return workspaceId === null
      ? { kind: "element" }
      : { kind: "file", file: { workspaceId, path: scope.file } };
  }
  const component = componentsOf(selection).find(
    (entry) => entry.componentId === scope.componentId
  );
  const importedFrom: SourceFileRef | undefined =
    component?.definedByImport && component.definedIn && workspaceId !== null
      ? { workspaceId, path: component.definedIn.path }
      : undefined;
  return {
    kind: "component",
    componentId: scope.componentId,
    ...(importedFrom ? { importedFrom } : {}),
  };
}

export interface PromptRequest {
  instruction: string;
  selection: PickedSelection;
  scope: TaskScope | undefined;
  worktreePath: string | null;
  project: ProjectContextOutcome | null;
  picture: PageScreenshot;
}

/** The request as the prompt takes it: the page's observations and the host's answers, as they are. */
export function promptInputFor(request: PromptRequest): AgentPromptInput {
  const { selection } = request;
  return {
    instruction: request.instruction,
    worktreePath: request.worktreePath,
    page: {
      displayedUrl: selection.displayedUrl,
      reportedRouteId: null,
      viewport: selection.viewport,
    },
    project: promptProject(selection, request.project),
    elements: selection.observations.map((observation) => ({
      observation,
      resolutions: resultsOf(selection, observation),
    })),
    scope: promptScope(selection, request.scope),
    screenshot: request.picture,
  };
}

/**
 * The box a picture of these elements needs: every measured rect, joined.
 * Null when nothing had a size, which is nothing to take a picture of.
 */
export function unionBounds(
  rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): { x: number; y: number; width: number; height: number } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    if (!(rect.width > 0 && rect.height > 0)) continue;
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
