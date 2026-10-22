import {
  COORDINATE_CONVENTIONS,
  type ComponentRecord,
  type ResolutionResult,
  type SourceCandidate,
  type SourceFileRef,
  type SourceLocation,
} from "@shared/elementPicker";
import { untestedVersionNotes, type SelectedNode, type SiteSelection } from "./legacyBridge.js";
import { untestedToolchainPromptLine } from "./copy.js";
import type { AgentPromptInput, PromptElement, PromptProject, PromptScope } from "./agentPrompt.js";
import type { CallSite, PagePlace, TaskScope } from "./agentTask.js";
import type { PageNode, PageScreenshot, PageSelection } from "./pageSelection.js";

// What the plugin's resolve says, in the neutral terms the prompt is built
// from, until the core picker's own observations replace it (#13886). Every
// value keeps the provenance it had: the page's spelling stays a report, and
// only what main checked against the worktree becomes a resolved target.

const LOC_FIELD = "__svelte_meta.loc";
const PARENT_FIELD = "__svelte_meta.parent";

function svelteLocation(line: number, column: number): SourceLocation {
  return { ...COORDINATE_CONVENTIONS.svelteMeta, columnUnit: "utf16", line, column };
}

function invocation(candidateId: string, site: CallSite): SourceCandidate {
  return {
    kind: "component-invocation",
    candidateId,
    framework: "svelte",
    extraction: { kind: "runtime-field", field: PARENT_FIELD },
    file: site.file,
    location: svelteLocation(site.line, site.column),
  };
}

/** `apps/site/` for an app at `<worktree>/apps/site`; null when it isn't inside the worktree. */
function appPrefixIn(worktreePath: string | null, appRoot: string): string | null {
  if (!worktreePath) return null;
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normalize(worktreePath);
  const app = normalize(appRoot);
  if (app === root) return "";
  return app.startsWith(`${root}/`) ? `${app.slice(root.length + 1)}/` : null;
}

function siteElement(
  node: SelectedNode,
  ref: (appRelative: string) => SourceFileRef,
  shown: PageNode | undefined
): PromptElement {
  const definition = node.definition;
  const sourceCandidates: SourceCandidate[] = [];
  const resolutions: ResolutionResult[] = [];
  if (definition) {
    const location = svelteLocation(definition.location.line, definition.location.column);
    sourceCandidates.push({
      kind: "template-location",
      candidateId: "loc",
      framework: "svelte",
      extraction: { kind: "runtime-field", field: LOC_FIELD },
      file: definition.location.file,
      location,
    });
    // Main found the element at that place in the file and hashed the bytes it
    // read. Without the file in the host's own spelling there is nothing to
    // cite but the page's, so the claim goes out as reported.
    if (node.sourceFile !== undefined) {
      resolutions.push({
        state: "verified",
        candidateId: "loc",
        claim: "template-location",
        target: { file: ref(node.sourceFile), location },
        fileRevision: `sha256:${definition.revision}`,
      });
    }
  }
  // The page's parent chain names call sites, innermost first; each is where
  // the component around the one before it was used. Generated frames are
  // nothing the user wrote, so no request names them.
  const calls = node.ancestry.filter((entry) => entry.kind === "component" && !entry.generated);
  const components: ComponentRecord[] = calls.map((entry, index) => ({
    componentId: `c${index}`,
    framework: "svelte",
    name:
      entry.componentTag === undefined
        ? null
        : { value: entry.componentTag, extraction: { kind: "runtime-field", field: PARENT_FIELD } },
    environment: "client",
    ...(index + 1 < calls.length ? { renderParentId: `c${index + 1}` } : {}),
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates: [invocation(`c${index}:at`, entry.location)],
  }));
  return {
    observation: {
      elementId: node.runtimeOccurrenceId,
      tagName: shown?.tagName ?? definition?.tagName ?? "element",
      label: node.label,
      componentChain: {
        nearestId: components[0]?.componentId ?? null,
        components,
        truncated: false,
      },
      sourceCandidates,
      frameworkEvidence: definition
        ? [
            {
              kind: "svelte",
              ancestry: node.ancestry.map((entry) => ({
                type: entry.kind,
                file: entry.location.file,
                line: entry.location.line,
                column: entry.location.column,
                ...(entry.componentTag === undefined ? {} : { componentTag: entry.componentTag }),
              })),
              sameLocCount: definition.renderedOccurrences,
              ...(definition.renderedOccurrencesAtLeast
                ? { sameLocCountPartial: true as const }
                : {}),
              unmapped: node.mapping === "visual-only",
            },
          ]
        : [],
      ...(shown?.context ? { context: shown.context } : {}),
    },
    resolutions,
  };
}

/**
 * The component a scope names, as a record of its own beside the first
 * element's chain: the scope carries the name the request is about, which a
 * pick makes on the page and the chain need not share. The outermost scope has
 * no call site, only the file the chain ran out in — or, with no chain, the
 * element's own file, which main checked.
 */
function scopedElement(
  scope: Extract<TaskScope, { kind: "component" }>,
  element: PromptElement,
  node: SelectedNode | undefined,
  ref: (appRelative: string) => SourceFileRef
): { element: PromptElement; componentId: string } {
  const { observation } = element;
  const usedAt = scope.usedAt;
  const record = (sourceCandidates: SourceCandidate[]): ComponentRecord => ({
    componentId: "scope",
    framework: "svelte",
    name:
      usedAt !== null && scope.fromPage
        ? { value: scope.label, extraction: { kind: "runtime-field", field: PARENT_FIELD } }
        : null,
    environment: "client",
    rootElementIds: [],
    rootsComplete: false,
    sourceCandidates,
  });
  const withRecord = (added: ComponentRecord, resolutions = element.resolutions) => ({
    element: {
      observation: {
        ...observation,
        componentChain: {
          ...observation.componentChain,
          components: [...observation.componentChain.components, added],
        },
      },
      resolutions,
    },
    componentId: added.componentId,
  });
  if (usedAt !== null) return withRecord(record([invocation("scope:at", usedAt)]));
  // A chain that names nothing leaves the element's own file at the top, read
  // from where the page placed the element and checked by main with it.
  const own = !scope.fromPage && node?.definition ? node.definition : null;
  if (scope.file === null) return withRecord(record([]));
  const hint: SourceCandidate = {
    kind: "file-hint",
    candidateId: "scope:file",
    framework: "svelte",
    extraction: { kind: "runtime-field", field: own === null ? PARENT_FIELD : LOC_FIELD },
    file: own?.location.file ?? scope.file,
  };
  if (own === null || node?.sourceFile === undefined) return withRecord(record([hint]));
  return withRecord(record([hint]), [
    ...element.resolutions,
    {
      state: "verified",
      candidateId: "scope:file",
      claim: "file-hint",
      target: { file: ref(node.sourceFile), location: null },
      fileRevision: `sha256:${own.revision}`,
    },
  ]);
}

function projectOf(place: PagePlace): PromptProject {
  const { svelte, kit, tailwind } = place.versions;
  const untested = untestedVersionNotes(place.versions);
  const route = place.route;
  return {
    appPath: place.appPath,
    stack: [
      kit ? `SvelteKit ${kit}` : null,
      svelte ? `Svelte ${svelte}` : null,
      tailwind ? `Tailwind ${tailwind}` : "no Tailwind",
    ].filter((part): part is string => part !== null),
    // Version skew is the agent's problem, not ours to hide: the locations
    // were resolved by a compiler tested against other majors, so the agent is
    // told to check the file rather than trust the line number.
    notes: untested.length > 0 ? [untestedToolchainPromptLine(untested)] : [],
    route: route
      ? {
          id: route.routeId,
          files: [
            ...route.layoutFiles.map((path) => ({ role: "layout" as const, path })),
            ...(route.dataFiles ?? []).map((path) => ({ role: "data" as const, path })),
            ...(route.pageFile ? [{ role: "page" as const, path: route.pageFile }] : []),
          ],
        }
      : null,
  };
}

export interface SitePromptContext {
  instruction: string;
  selection: SiteSelection;
  /** Worktree-relative file that owns the element's markup, when known. */
  file: string | null;
  worktreePath: string | null;
  /** The app and the route files around the page, when the project model answered. */
  place: PagePlace | null;
  /** Which of the selection's scopes the request is about. Defaults to the element. */
  scope?: TaskScope;
  picture: PageScreenshot;
  /** What the page itself showed of each element, by occurrence id; null once no longer kept. */
  shown: ReadonlyMap<string, PageNode> | null;
}

export function sitePromptInput(context: SitePromptContext): AgentPromptInput {
  const { selection, file, worktreePath } = context;
  // App-relative paths from the page map onto the worktree through the app's
  // own place in it — not through the element's file, which a visual-only
  // root doesn't have.
  const owner = selection.nodes[0];
  const ownerLocation = owner?.sourceFile ?? owner?.definition?.location.file;
  const appPrefix =
    appPrefixIn(worktreePath, selection.appRoot) ??
    (file && ownerLocation && file.endsWith(ownerLocation)
      ? file.slice(0, file.length - ownerLocation.length)
      : "");
  const ref = (appRelative: string): SourceFileRef => ({
    workspaceId: selection.workspaceSessionId,
    path: `${appPrefix}${appRelative}`,
  });
  const elements = selection.nodes.map((node) =>
    siteElement(node, ref, context.shown?.get(node.runtimeOccurrenceId))
  );
  const scope = context.scope;
  let promptScope: PromptScope = { kind: "element" };
  if (scope?.kind === "component" && elements[0]) {
    const scoped = scopedElement(scope, elements[0], owner, ref);
    elements[0] = scoped.element;
    promptScope = {
      kind: "component",
      componentId: scoped.componentId,
      // Main followed the import at the call site to this file; the outermost
      // scope has no call site, and its file is a claim on its own record.
      ...(scope.usedAt !== null && scope.file !== null ? { importedFrom: ref(scope.file) } : {}),
    };
  }
  return {
    instruction: context.instruction,
    worktreePath,
    page: {
      displayedUrl: selection.displayedUrl,
      reportedRouteId: selection.routeId,
      viewport: selection.viewport,
    },
    project: context.place ? projectOf(context.place) : null,
    elements,
    scope: promptScope,
    screenshot: context.picture,
  };
}

export interface PagePromptContext {
  instruction: string;
  selection: PageSelection;
  worktreePath: string | null;
  picture: PageScreenshot;
}

/** A selection with no source behind it: the page's account of each element and nothing else. */
export function pagePromptInput(context: PagePromptContext): AgentPromptInput {
  const { selection } = context;
  return {
    instruction: context.instruction,
    worktreePath: context.worktreePath,
    page: {
      displayedUrl: selection.displayedUrl,
      reportedRouteId: null,
      viewport: selection.viewport,
    },
    project: null,
    elements: selection.nodes.map((node, index) => ({
      observation: {
        elementId: `${selection.selectionId}:${index}`,
        tagName: node.tagName,
        label: node.label,
        componentChain: { nearestId: null, components: [], truncated: false },
        sourceCandidates: [],
        frameworkEvidence: [],
        ...(node.context ? { context: node.context } : {}),
      },
      resolutions: [],
    })),
    scope: { kind: "element" },
    screenshot: context.picture,
  };
}
