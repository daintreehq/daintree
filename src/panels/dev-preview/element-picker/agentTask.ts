import type { AgentState } from "@shared/types/agent";
import type { RouteNode, SiteSelection } from "./legacyBridge.js";
import { isPageSelection, type ComposerSubjectSelection } from "./pageSelection.js";

/**
 * What a request is about: the clicked element, or one of the components
 * that contain it, innermost first. A component is named for the tag that
 * rendered it and located by the file its import at the call site resolves to,
 * read from source by main. `file` is null while that is still being read or
 * when it couldn't be proven; such a scope can be shown but never sent.
 */
export type TaskScope =
  | { kind: "element"; label: string }
  | {
      kind: "component";
      label: string;
      /** App-relative file the component is written in; null when not proven. */
      file: string | null;
      /** Where it is used, when a call site outside generated code is known. */
      usedAt: CallSite | null;
      /**
       * The label is the tag the page reported, not a name read from the
       * worktree — so a prompt naming this scope quotes it as a page
       * observation rather than presenting it as resolved evidence.
       */
      fromPage: boolean;
    };

/**
 * Where `chosen` sits in `scopes`, by what it is rather than where it sat: a
 * component added to the chain moves every index above it, and two scopes can
 * share a label. -1 when the chain no longer names it.
 */
export function matchScope(chosen: TaskScope | undefined, scopes: readonly TaskScope[]): number {
  if (chosen === undefined) return -1;
  return scopes.findIndex((candidate) =>
    candidate.kind !== chosen.kind
      ? false
      : candidate.kind === "element" ||
        (chosen.kind === "component" &&
          candidate.label === chosen.label &&
          candidate.file === chosen.file &&
          candidate.usedAt?.file === chosen.usedAt?.file &&
          candidate.usedAt?.line === chosen.usedAt?.line &&
          candidate.usedAt?.column === chosen.usedAt?.column)
  );
}

export interface CallSite {
  file: string;
  line: number;
  column: number;
}

/**
 * Where each component call site's component is written, keyed by
 * {@link callSiteKey}: a file, null when it couldn't be proven, or absent while
 * still unknown. `null` as a whole means the lookup hasn't answered yet.
 */
export type ComponentDefinitions = Readonly<Record<string, string | null>> | null;

export function callSiteKey(site: CallSite): string {
  return `${site.file}\n${site.line}\n${site.column}`;
}

/** Call sites whose definitions a selection's scopes need, deduplicated. */
export function componentCallSites(
  selection: SiteSelection,
  picked: PickedComponent | null
): CallSite[] {
  const sites = new Map<string, CallSite>();
  const add = (site: CallSite) => sites.set(callSiteKey(site), site);
  // Every authored call site the prompt can name, including ones outside a
  // generated or library frame — the same entries "Rendered inside" lists.
  for (const entry of selection.nodes[0]?.ancestry ?? []) {
    if (entry.kind !== "component" || entry.generated) continue;
    add({ file: entry.location.file, line: entry.location.line, column: entry.location.column });
  }
  if (picked) add({ file: picked.file, line: picked.line, column: picked.column });
  return [...sites.values()];
}

/** App-relative file → revision of the bytes a request's claims were read from. */
export type SourceRevisions = Readonly<Record<string, string | null>> | null;

/**
 * Every file a request about this selection can cite: each selected element's
 * own file, the call sites on the chain, and where the components are written.
 */
export function citedFiles(
  selection: SiteSelection,
  picked: PickedComponent | null,
  definitions: Readonly<Record<string, string | null>>
): string[] {
  const files = new Set<string>();
  for (const node of selection.nodes) {
    if (node.definition) files.add(node.definition.location.file);
  }
  for (const site of componentCallSites(selection, picked)) files.add(site.file);
  for (const file of Object.values(definitions)) if (file) files.add(file);
  return [...files];
}

/** Whether a scope names a component nobody has proven the file of yet. */
export function isUnresolvedScope(scope: TaskScope | undefined): boolean {
  return scope?.kind === "component" && scope.file === null;
}

export function taskScopes(
  selection: SiteSelection,
  definitions: ComponentDefinitions = null
): TaskScope[] {
  const node = selection.nodes[0];
  if (!node) return [];
  const definition = node.definition;
  const scopes: TaskScope[] = [
    { kind: "element", label: node.label || definition?.tagName || "element" },
  ];
  if (!definition) return scopes;
  let outermost = node.sourceFile ?? definition.location.file;
  // The element's own file was resolved by main against the worktree; every
  // file the chain contributes past that point is the page's own report.
  let outermostFromPage = false;
  for (const entry of node.ancestry) {
    if (entry.kind !== "component") continue;
    if (entry.generated) break;
    const usedAt = {
      file: entry.location.file,
      line: entry.location.line,
      column: entry.location.column,
    };
    const file = definitions?.[callSiteKey(usedAt)] ?? null;
    scopes.push({
      kind: "component",
      label: entry.componentTag ?? (file ? componentName(file) : "component"),
      file,
      usedAt,
      fromPage: entry.componentTag !== undefined,
    });
    outermost = entry.location.file;
    outermostFromPage = true;
  }
  // The outermost user file is itself a component — a route page or layout
  // rendered by generated code. It holds the outermost call site (or the
  // element), so its file is observed rather than inferred.
  scopes.push({
    kind: "component",
    label: componentName(outermost),
    file: outermost,
    usedAt: null,
    fromPage: outermostFromPage,
  });
  return scopes;
}

/** The component a selection on the page stands for: its call site and tag. */
export interface PickedComponent extends CallSite {
  name: string;
}

/**
 * The scopes a request can be about, with the component picked on the page
 * placed by its call site rather than by a position in the chain. The element
 * is always scope 0, so `pickedIndex` always points at a real scope. Until main
 * has proven where the picked component is written it is `unresolved`, and the
 * request may not quietly become about the element, or about a neighbour.
 */
export function scopesFor(
  selection: SiteSelection,
  picked: PickedComponent | null,
  definitions: ComponentDefinitions = null
): { scopes: TaskScope[]; pickedIndex: number; unresolved: boolean } {
  const scopes = taskScopes(selection, definitions);
  if (picked === null || scopes.length === 0) return { scopes, pickedIndex: 0, unresolved: false };
  const file = definitions?.[callSiteKey(picked)] ?? null;
  const scope: TaskScope = {
    kind: "component",
    label: picked.name,
    file,
    usedAt: { file: picked.file, line: picked.line, column: picked.column },
    fromPage: true,
  };
  const index = scopes.findIndex(
    (candidate) =>
      candidate.kind === "component" &&
      candidate.usedAt !== null &&
      callSiteKey(candidate.usedAt) === callSiteKey(picked)
  );
  const pickedIndex = index > 0 ? index : 1;
  if (index > 0) scopes[index] = scope;
  // Not on the transmitted chain (a generated invocation, a trimmed ancestry):
  // still what the user picked, so it is offered first.
  else scopes.splice(1, 0, scope);
  return { scopes, pickedIndex, unresolved: file === null };
}

/**
 * {@link scopesFor} for anything a composer can be about. A page selection
 * has no component chain the page vouched for, so the element is its one scope.
 */
export function scopesForSubject(
  selection: ComposerSubjectSelection,
  picked: PickedComponent | null,
  definitions: ComponentDefinitions = null
): { scopes: TaskScope[]; pickedIndex: number; unresolved: boolean } {
  if (!isPageSelection(selection)) return scopesFor(selection, picked, definitions);
  const node = selection.nodes[0];
  if (!node) return { scopes: [], pickedIndex: 0, unresolved: false };
  return {
    scopes: [{ kind: "element", label: node.label || node.tagName || "element" }],
    pickedIndex: 0,
    unresolved: false,
  };
}

function componentName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  return base.startsWith("+") ? base : base.replace(/\.svelte$/, "");
}

/** An agent terminal the task can be delivered to. */
export interface AgentTarget {
  terminalId: string;
  title: string;
  agentState: AgentState | null;
  /** Which CLI is running there, for the destination's own mark. Unknown is possible. */
  agentId: string | null;
}

export const MAX_INSTRUCTION_CHARS = 4000;

export interface PagePlace {
  /** Worktree-relative app directory; "" when the app is the worktree. */
  appPath: string;
  versions: { svelte: string | null; kit: string | null; tailwind: string | null };
  /** The route serving the page's URL, matched against the project's routes. */
  route: RouteNode | null;
}

/** Agents that are mid-turn must not receive a second prompt on top of it. */
export function isAgentBusy(state: AgentState | null): boolean {
  return state === "working" || state === "directing";
}
