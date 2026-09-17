import type { AgentState } from "@shared/types/agent";
import type { TerminalSubmissionPhase } from "@shared/types/terminalSubmission";
import type { SiteSelection } from "../shared/model.js";
import type { RouteNode } from "../shared/protocol.js";

/**
 * The context an agent task carries. Everything here is observed or resolved
 * source identity — never a conclusion the Inspector drew — so an agent reading
 * it can check each claim against the files itself.
 *
 * References, not contents: files, locations and the route that serves the
 * page. The agent is working in the same worktree and reads what it needs;
 * pasting source into its input would go stale the moment either side edits,
 * and spends the agent's context on code it may not need.
 */
export interface AgentTaskContext {
  instruction: string;
  selection: SiteSelection;
  /** Worktree-relative file that owns the element's markup, when known. */
  file: string | null;
  worktreePath: string | null;
  /** The app and the route files around the page, when the project model answered. */
  place: PagePlace | null;
  /** Which of {@link taskScopes} the request is about. Defaults to the element. */
  scope?: TaskScope;
}

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
    };

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
  let outermost = definition.location.file;
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
    });
    outermost = entry.location.file;
  }
  // The outermost user file is itself a component — a route page or layout
  // rendered by generated code. It holds the outermost call site (or the
  // element), so its file is observed rather than inferred.
  scopes.push({
    kind: "component",
    label: componentName(outermost),
    file: outermost,
    usedAt: null,
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

export function buildAgentTaskPrompt(context: AgentTaskContext): string {
  const { selection, file, worktreePath, place } = context;
  // App-relative paths from the page map onto the worktree through the app's
  // own place in it — not through the element's file, which a visual-only
  // root doesn't have.
  const ownerLocation = selection.nodes[0]?.definition?.location.file;
  const appPrefix =
    appPrefixIn(worktreePath, selection.appRoot) ??
    (file && ownerLocation && file.endsWith(ownerLocation)
      ? file.slice(0, file.length - ownerLocation.length)
      : "");
  const inWorktree = (appRelative: string) => `${appPrefix}${appRelative}`;
  const node = selection.nodes[0];
  const definition = node?.definition ?? null;
  const lines: string[] = [];

  lines.push(context.instruction.trim());
  // A Markdown rule between what the user wrote and what the builder added, so
  // an agent reading the prompt can tell the request from its context at a
  // glance instead of inferring the boundary from a blank line.
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Context from the Daintree Site Builder — file references only; read the files for the code:"
  );
  if (worktreePath) lines.push(`- Worktree: ${worktreePath}`);
  if (place) {
    const { svelte, kit, tailwind } = place.versions;
    const stack = [
      kit ? `SvelteKit ${kit}` : null,
      svelte ? `Svelte ${svelte}` : null,
      tailwind ? `Tailwind ${tailwind}` : "no Tailwind",
    ].filter((part): part is string => part !== null);
    lines.push(
      `- App: ${place.appPath === "" ? "the worktree root" : place.appPath} (${stack.join(", ")})`
    );
  }
  const route = place?.route ?? null;
  lines.push(
    `- Page: ${selection.displayedUrl}${route ? ` (route ${route.routeId})` : selection.routeId ? ` (route ${selection.routeId})` : ""}`
  );
  lines.push(`- Viewport: ${selection.viewport.width}×${selection.viewport.height}`);
  if (route) {
    const files = [
      ...route.layoutFiles.map((layout) => `  - layout: ${layout}`),
      ...(route.dataFiles ?? []).map((data) => `  - data: ${data}`),
      ...(route.pageFile ? [`  - page: ${route.pageFile}`] : []),
    ];
    if (files.length > 0) {
      lines.push("- Route files, outermost layout first:");
      lines.push(...files);
    }
  }
  const scope = context.scope;
  if (scope?.kind === "component") {
    const used = scope.usedAt
      ? `, used at ${inWorktree(scope.usedAt.file)}:${scope.usedAt.line}`
      : "";
    const where = scope.file ? inWorktree(scope.file) : "file not traced";
    lines.push(`- Target: the ${scope.label} component (${where}${used})`);
    lines.push("- Picked by clicking this element inside it:");
  }
  if (node) {
    lines.push(`- Selected element: ${node.label || definition?.tagName || "unknown element"}`);
  }
  if (definition) {
    const location = `${file ?? definition.location.file}:${definition.location.line}:${definition.location.column + 1}`;
    lines.push(`- Source: <${definition.tagName}> at ${location}`);
    if (definition.renderedOccurrencesAtLeast) {
      lines.push(
        `- This markup renders at least ${definition.renderedOccurrences} ${definition.renderedOccurrences === 1 ? "copy" : "copies"} on the page (the page could not count them all); changing it changes every copy`
      );
    } else if (definition.renderedOccurrences > 1) {
      lines.push(
        `- This markup renders ${definition.renderedOccurrences} copies on the page; changing it changes all of them`
      );
    }
  } else {
    lines.push("- Source: not traced — find the markup from the page and element above");
  }
  const components = (node?.ancestry ?? [])
    .filter((entry) => entry.kind === "component" && !entry.generated)
    .map(
      (entry) =>
        `${entry.componentTag ?? "component"} (${inWorktree(entry.location.file)}:${entry.location.line})`
    );
  if (components.length > 0) lines.push(`- Rendered inside: ${components.join(" ← ")}`);
  // Every selected element goes out, not just the first: "make these match"
  // is meaningless with one of them missing.
  for (const other of selection.nodes.slice(1)) {
    const where = other.definition
      ? `${inWorktree(other.definition.location.file)}:${other.definition.location.line}:${other.definition.location.column + 1}`
      : "source not traced";
    lines.push(
      `- Also selected: ${other.label || other.definition?.tagName || "element"} (${where})`
    );
  }

  lines.push("");
  lines.push(
    scope?.kind === "component"
      ? `Keep the change inside the ${scope.label} component unless the request needs more. If it needs a wider change, say so and name what else you touched.`
      : "Keep the change to this element unless the request needs more. If it needs a wider change, say so and name what else you touched."
  );
  return lines.join("\n");
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

/** Agents that are mid-turn must not receive a second prompt on top of it. */
export function isAgentBusy(state: AgentState | null): boolean {
  return state === "working" || state === "directing";
}

export type DeliveryState =
  | { status: "sending" }
  /** A fresh session is starting; the request goes in once it is at its prompt. */
  | { status: "starting" }
  /** The session is asking its user something (trust, approval) before it can take the request. */
  | { status: "needs-you" }
  /** No sign yet whether the agent can take typed input; the user may send anyway. */
  | { status: "unknown-readiness" }
  | { status: "sent" }
  | { status: "unconfirmed" }
  /** `partial` when typing had started: some of the prompt may be in the agent's input. */
  | { status: "failed"; message: string; partial?: true };

/**
 * Whether a freshly launched agent can take a typed request now. Only an agent
 * observed waiting at its own prompt qualifies: a trust or approval question is
 * also "waiting", and a request typed into it would answer the question.
 */
export function launchReadiness(
  agentState: AgentState | null | undefined,
  waitingReason: string | undefined
): "ready" | "needs-you" | "not-yet" {
  if (agentState === "waiting") {
    return waitingReason === "question" || waitingReason === "approval" || waitingReason === "error"
      ? "needs-you"
      : "ready";
  }
  if (agentState === "idle") return "ready";
  return "not-yet";
}

/**
 * Only `pty_written` is evidence the prompt reached the agent's terminal. Every
 * other outcome is reported as what it is rather than rounded up to "sent".
 */
export function deliveryFromPhase(phase: TerminalSubmissionPhase | null): DeliveryState | null {
  switch (phase) {
    case "pty_written":
      return { status: "sent" };
    // Part of the prompt may already sit in the agent's input, so neither of
    // these says resending is safe.
    case "failed":
      return {
        status: "failed",
        message: "The terminal didn't accept the whole prompt",
        partial: true,
      };
    case "cancelled":
      return {
        status: "failed",
        message: "Sending was stopped before the prompt finished",
        partial: true,
      };
    case "queued":
    case "writing":
    case null:
      return null;
    case "unknown":
      return { status: "unconfirmed" };
  }
}
