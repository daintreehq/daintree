import { randomUUID } from "node:crypto";
import { MAX_WRITTEN_CHARS } from "../shared/model.js";
import type {
  AncestryEntry as ModelAncestryEntry,
  EditCapability,
  EditSupport,
  SelectedNode,
  UnsupportedReason,
} from "../shared/model.js";
import type {
  GuestNodeObservation,
  SelectionResolveArgs,
  SelectionResolveResult,
  SelectionMismatch,
} from "../shared/protocol.js";
import type {
  ResolvedElement,
  SurfaceSupport,
  UnsupportedSurfaceReason,
} from "@daintreehq/svelte-source-model";
import { loadParse, loadSourceModel, loadTokenModel, type SourceModel } from "./engine.js";
import {
  containsRealPath,
  isGeneratedPath,
  readSource,
  resolveReportedPath,
  type SourceRead,
} from "./source.js";
import type { Workspace } from "./workspace.js";

type Surface = EditCapability["surface"];
const SURFACES: readonly Surface[] = ["text", "classes", "attributes", "props"];

function everySurface(support: EditSupport, reason?: UnsupportedReason): EditCapability[] {
  return SURFACES.map((surface) =>
    reason === undefined ? { surface, support } : { surface, support, reason }
  );
}

/**
 * The package's reasons describe the source; the model's describe what the
 * user can do about it. "Present but not a literal" is agent work — the agent
 * can rewrite an expression — while "absent" or "not a component" leaves
 * nothing to edit at all.
 */
function capabilityFor(surface: Surface, reason: UnsupportedSurfaceReason): EditCapability {
  switch (reason) {
    case "absent":
    case "not-a-component":
      return { surface, support: "inspect-only" };
    case "dynamic-expression":
    case "mixed-text-and-expression":
      return { surface, support: "agent-assisted", reason: "dynamic-expression" };
    case "class-directive":
      return { surface, support: "agent-assisted", reason: "class-directive" };
    case "spread-attribute":
      return { surface, support: "agent-assisted", reason: "spread-attribute" };
    case "not-a-writable-literal":
    case "multiple-children":
      return { surface, support: "agent-assisted" };
  }
}

function fromSupport(surface: Surface, support: SurfaceSupport | undefined): EditCapability {
  if (support === undefined) return { surface, support: "inspect-only" };
  if (support.support === "direct") return { surface, support: "direct" };
  return capabilityFor(surface, support.reason);
}

/** A named surface (attributes, props) is as editable as its most editable member. */
function aggregate(surface: Surface, members: Record<string, SurfaceSupport>): EditCapability {
  const capabilities = Object.values(members).map((member) => fromSupport(surface, member));
  return (
    capabilities.find((capability) => capability.support === "direct") ??
    capabilities.find((capability) => capability.support === "agent-assisted") ?? {
      surface,
      support: "inspect-only",
    }
  );
}

/**
 * What each surface of a resolved element supports. `editApply` enforces the
 * same rules independently — these are what the inspector may offer, not the
 * gate itself.
 */
export function capabilitiesOf(element: ResolvedElement): EditCapability[] {
  let classes = fromSupport("classes", element.classes);
  // A spread emitted after the literal wins at runtime, so a token edit could
  // change nothing visible. The literal is real; the authority is not.
  if (classes.support === "direct" && element.hasSpread) {
    classes = { surface: "classes", support: "agent-assisted", reason: "spread-attribute" };
  }
  let attributes = aggregate("attributes", element.attributes);
  // `editApply` refuses attribute writes next to a spread, so none is offered.
  if (element.hasSpread) {
    attributes = { surface: "attributes", support: "agent-assisted", reason: "spread-attribute" };
  }
  return [
    fromSupport("text", element.text),
    classes,
    attributes,
    aggregate("props", element.props),
  ];
}

/**
 * Query values can carry tokens and personal data, and this string is shown
 * and may be handed to an agent. Keys stay — they say which page this is —
 * values and the fragment go.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const cut = raw.search(/[?#]/);
    return cut === -1 ? raw : raw.slice(0, cut);
  }
  const keys = [...new Set(url.searchParams.keys())];
  url.hash = "";
  url.search = "";
  if (keys.length === 0) return url.toString();
  return `${url.toString()}?${keys.map((key) => `${encodeURIComponent(key)}=`).join("&")}`;
}

interface NodeContext {
  workspace: Workspace;
  model: SourceModel;
  readCached: (absolutePath: string) => Promise<SourceRead>;
}

type NodeOutcome =
  { status: "ok"; node: SelectedNode } | { status: "stale"; mismatch?: SelectionMismatch };

function interpret(model: SourceModel, workspace: Workspace, observation: GuestNodeObservation) {
  const interpreted = model.interpretAncestry(observation.ancestry);
  const ancestry: ModelAncestryEntry[] = interpreted.entries.map((entry) => {
    const out: ModelAncestryEntry = {
      kind: entry.kind,
      location: entry.location,
      generated: entry.generated,
    };
    if (entry.componentTag !== undefined) out.componentTag = entry.componentTag;
    return out;
  });
  // A call site outside the app is not one this workspace can act on, and the
  // chain is guest-reported: it is shown, but never promoted to an invocation.
  const invocation = interpreted.invocation;
  const invocationContained =
    invocation !== null && resolveReportedPath(workspace, invocation.location.file).ok;
  const invocationEntry =
    invocation !== null && invocationContained
      ? (ancestry[interpreted.entries.indexOf(invocation)] ?? null)
      : null;
  return { ancestry, invocation: invocationEntry };
}

async function resolveNode(
  context: NodeContext,
  observation: GuestNodeObservation
): Promise<NodeOutcome> {
  const { workspace, model } = context;
  const { ancestry, invocation } = interpret(model, workspace, observation);
  const base = {
    runtimeOccurrenceId: observation.runtimeOccurrenceId,
    invocation,
    ancestry,
    label: observation.label,
    bounds: observation.bounds,
  };
  const inspectOnly = (reason?: UnsupportedReason): NodeOutcome => ({
    status: "ok",
    node: {
      ...base,
      definition: null,
      mapping: "visual-only",
      capabilities: everySurface("inspect-only", reason),
      surfaces: { classes: null, text: null },
    },
  });

  if (observation.unmapped) return inspectOnly("unmapped-content");
  // An unstamped element the page could still place by shape is asked for at
  // the head of its template; the location comes from the walk.
  const loc =
    observation.loc ??
    (observation.structure ? { file: observation.structure.file, line: 1, column: 0 } : null);
  if (loc === null) return inspectOnly("unmapped-content");
  if (model.isGeneratedSourceFile(loc.file)) return inspectOnly("generated-file");
  const target = resolveReportedPath(workspace, loc.file);
  // Outside the app root is a workspace package or a dependency: real markup,
  // but not this app's to edit.
  if (!target.ok || !(await containsRealPath(workspace.appRoot, target.absolute))) {
    return inspectOnly("dependency-owned");
  }
  if (isGeneratedPath(model.isGeneratedSourceFile, target.appRelative)) {
    return inspectOnly("generated-file");
  }
  if (!target.appRelative.endsWith(".svelte")) return { status: "stale" };

  const read = await context.readCached(target.absolute);
  if (read.status !== "ok") return { status: "stale" };
  workspace.tracker.observe(target.absolute, target.worktreeRelative, read.revision);

  const parse = await loadParse();
  const reported = observation.tagName.toLowerCase();
  const attempt = (
    at: typeof loc
  ):
    | { status: "ok"; element: ResolvedElement }
    | { status: "stale"; mismatch?: SelectionMismatch }
    | { status: "inspect-only" } => {
    const resolved = model.resolveElementAtLocation(read.text, at, parse);
    if (resolved.status !== "resolved") {
      if (resolved.reason === "generated-file") return { status: "inspect-only" };
      // Out of range, ambiguous, or unparseable: the file is not the one this
      // node was rendered from. Never a nearest match. Nothing starting there
      // is said as such, so the caller can tell a location the page got wrong
      // from a document that moved on.
      if (resolved.reason === "no-element-at-location") {
        return { status: "stale", mismatch: { ...at, reported, found: null } };
      }
      return { status: "stale" };
    }
    // The guest's coordinates carry no revision, so an observation captured
    // before an HMR update can land exactly on a different element in the new
    // bytes. The tag is the one independent witness available; a mismatch is
    // a stale selection. Same-tag shifts remain undetectable here.
    const element = resolved.node;
    if (element.kind === "RegularElement" && element.tagName.toLowerCase() !== reported) {
      return {
        status: "stale",
        mismatch: { ...at, reported, found: element.tagName.toLowerCase() },
      };
    }
    return { status: "ok", element };
  };

  const stamped = observation.loc !== null;
  let outcome = stamped
    ? attempt(loc)
    : { status: "stale" as const, mismatch: { ...loc, reported, found: null } };
  let location = loc;
  let placedByStructure = false;
  // A location the file contradicts, or none at all, on a node that reported
  // its place in the template: on a hydrated page Svelte stamps an element
  // with its neighbour's location and drops the tail's, and the shape is what
  // still identifies it. Exact or nothing — the path has to land on an element
  // of the reported tag in one fragment through levels the page and the
  // source count alike — and the answer is re-proved at the location it
  // names. A stamp the file agrees with is kept as it is: the page can move an
  // element after stamping it, and its new place says nothing about its
  // source; a same-tag neighbour's stamp cannot be told from it here.
  if (outcome.status === "stale" && outcome.mismatch !== undefined && observation.structure) {
    const frame = observation.ancestry[0] ?? null;
    const placed = model.resolveElementByStructure(
      read.text,
      loc.file,
      { frame, path: observation.structure.path, hint: stamped ? loc : null },
      parse
    );
    if (placed.status === "resolved") {
      const retried = attempt(placed.location);
      if (retried.status === "ok") {
        outcome = retried;
        location = placed.location;
        placedByStructure = true;
      }
    }
  }
  if (outcome.status === "inspect-only") return inspectOnly("generated-file");
  if (outcome.status === "stale") return outcome;
  const element = outcome.element;
  const capabilities =
    workspace.support.level === "full"
      ? capabilitiesOf(element)
      : everySurface("inspect-only", "unsupported-framework-version");

  return {
    status: "ok",
    node: {
      ...base,
      definition: {
        location,
        range: element.range,
        tagName: element.tagName,
        revision: read.revision,
        // The page counted the copies sharing the location it stamped; for an
        // element placed by shape that count describes some other element, and
        // the one copy in hand is all that is known.
        renderedOccurrences: placedByStructure ? 1 : observation.sameLocCount,
        ...(observation.sameLocCountPartial || placedByStructure
          ? { renderedOccurrencesAtLeast: true as const }
          : {}),
      },
      mapping: invocation === null ? "definition-only" : "exact",
      ...(await withWritten(
        read.text,
        element,
        await surfacesOf(read.text, element, capabilities)
      )),
    },
  };
}

/**
 * The source of each surface the inspector won't edit, so a dynamic class list
 * or an expression in the text still says something useful. Read off the
 * compiler's own AST for the element — the attribute and directive nodes, the
 * child nodes — and never decoded or evaluated.
 */
async function withWritten(
  source: string,
  element: ResolvedElement,
  resolved: { surfaces: SelectedNode["surfaces"]; capabilities: EditCapability[] }
): Promise<{
  surfaces: SelectedNode["surfaces"];
  capabilities: EditCapability[];
  written?: NonNullable<SelectedNode["written"]>;
}> {
  const direct = (surface: Surface) =>
    resolved.capabilities.some((c) => c.surface === surface && c.support === "direct") &&
    resolved.surfaces[surface as "classes" | "text"] !== null;
  if (direct("classes") && direct("text")) return resolved;
  const node = await elementNodeAt(source, element.range.start);
  if (node === null) return resolved;
  // Verbatim: whitespace inside a string, a regex or a comment is part of what
  // the expression says. Only the ends are trimmed, and the length is bounded.
  const bounded = (text: string) =>
    text.length > MAX_WRITTEN_CHARS ? `${text.slice(0, MAX_WRITTEN_CHARS)}…` : text;
  // Each class-bearing attribute on its own — never the span between them,
  // which would pull in whatever unrelated attribute sits in the middle. HTML
  // attribute names are case-insensitive on elements; component props are not.
  const isElement = node.type !== "Component" && node.type !== "SvelteComponent";
  const classParts = (node.attributes ?? []).filter(
    (attribute) =>
      (attribute.type === "Attribute" &&
        (isElement ? attribute.name?.toLowerCase() : attribute.name) === "class") ||
      attribute.type === "ClassDirective" ||
      attribute.type === "SpreadAttribute"
  );
  const classes =
    direct("classes") || classParts.length === 0
      ? null
      : bounded(classParts.map((part) => source.slice(part.start, part.end)).join(" "));
  const children = node.fragment?.nodes ?? [];
  const text =
    direct("text") || children.length === 0
      ? null
      : bounded(source.slice(children[0]!.start, children[children.length - 1]!.end).trim()) ||
        null;
  if (classes === null && text === null) return resolved;
  return { ...resolved, written: { classes, text } };
}

interface AstElement {
  type: string;
  start: number;
  end: number;
  attributes?: Array<{ type: string; name?: string; start: number; end: number }>;
  fragment?: { nodes: Array<{ start: number; end: number }> };
}

const ELEMENT_TYPES = new Set(["RegularElement", "SvelteElement", "Component", "SvelteComponent"]);

async function elementNodeAt(source: string, start: number): Promise<AstElement | null> {
  const parse = await loadParse();
  let ast: { fragment: unknown };
  try {
    ast = parse(source, { modern: true }) as { fragment: unknown };
  } catch {
    return null;
  }
  const seen = new Set<object>();
  let found: AstElement | null = null;
  const visit = (value: unknown): void => {
    if (found !== null || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as Partial<AstElement>;
    if (typeof node.type === "string" && ELEMENT_TYPES.has(node.type) && node.start === start) {
      found = node as AstElement;
      return;
    }
    for (const [key, child] of Object.entries(value)) if (key !== "parent") visit(child);
  };
  visit(ast.fragment);
  return found;
}

/**
 * The values the inspector shows and edits, decoded exactly as the planner
 * compares them. Offered only for a surface this selection calls `direct`, so
 * the view never displays a value it cannot write back.
 */
async function surfacesOf(
  source: string,
  element: ResolvedElement,
  capabilities: EditCapability[]
): Promise<{ surfaces: SelectedNode["surfaces"]; capabilities: EditCapability[] }> {
  const { splitClassValue, decodeEntities, validateToken } = await loadTokenModel();
  const isDirect = (surface: Surface) =>
    capabilities.some(
      (capability) => capability.surface === surface && capability.support === "direct"
    );
  const downgraded = new Set<Surface>();

  let classes: SelectedNode["surfaces"]["classes"] = null;
  if (isDirect("classes") && element.classes.support === "direct") {
    // Decoded exactly as `planSetClassTokens` compares, so every token shown
    // is one a removal by that same string finds.
    const tokens = splitClassValue(
      source.slice(element.classes.range.start, element.classes.range.end)
    )
      .filter((segment) => segment.kind === "token")
      .map((segment) => decodeEntities(segment.raw));
    // A token the planner would refuse to name cannot be removed, so the list
    // is not editable as a list.
    if (tokens.every((token) => validateToken(token) === null)) classes = { tokens };
    else downgraded.add("classes");
  }

  let text: SelectedNode["surfaces"]["text"] = null;
  if (isDirect("text") && element.text.support === "direct") {
    const tag = element.tagName.toLowerCase();
    const decoded = RAW_TEXT_ELEMENTS.has(tag)
      ? null
      : await compilerTextOf(source, element.text.range);
    if (decoded === null) {
      downgraded.add("text");
    } else {
      // The HTML parser drops one newline straight after `<pre>`, and the
      // planner re-adds it on write; showing it would grow one per edit.
      const eaten =
        NEWLINE_EATING_ELEMENTS.has(tag) && source[element.text.range.start - 1] === ">"
          ? decoded.replace(/^\r?\n/, "")
          : decoded;
      text = { text: eaten };
    }
  }

  return {
    surfaces: { classes, text },
    capabilities: capabilities.map((capability) =>
      downgraded.has(capability.surface)
        ? { surface: capability.surface, support: "agent-assisted" as const }
        : capability
    ),
  };
}

/** Mirrors the planner's refusal list: raw text is not escapable text. */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
const NEWLINE_EATING_ELEMENTS = new Set(["pre", "textarea", "listing"]);

/**
 * The text as Svelte itself decodes it (full named and numeric entity tables),
 * which is what renders. The planner's own decoder covers only the subset it
 * needs for token comparison and would show `&copy;` literally.
 */
async function compilerTextOf(
  source: string,
  range: { start: number; end: number }
): Promise<string | null> {
  const parse = await loadParse();
  const ast = parse(source, { modern: true });
  const seen = new Set<object>();
  let found: string | null = null;
  const visit = (value: unknown): void => {
    if (found !== null || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as { type?: unknown; start?: unknown; end?: unknown; data?: unknown };
    if (
      node.type === "Text" &&
      node.start === range.start &&
      node.end === range.end &&
      typeof node.data === "string"
    ) {
      found = node.data;
      return;
    }
    for (const [key, child] of Object.entries(value)) if (key !== "parent") visit(child);
  };
  visit(ast.fragment);
  return found as string | null;
}

export async function resolveSelection(
  workspace: Workspace,
  args: SelectionResolveArgs
): Promise<SelectionResolveResult> {
  const model = await loadSourceModel();
  // One read per file per request: two nodes in one component must be
  // resolved against the same bytes and report the same revision.
  const reads = new Map<string, Promise<SourceRead>>();
  const readCached = (absolutePath: string): Promise<SourceRead> => {
    let pending = reads.get(absolutePath);
    if (!pending) {
      pending = readSource(workspace.fs, absolutePath);
      reads.set(absolutePath, pending);
    }
    return pending;
  };

  const nodes: SelectedNode[] = [];
  for (const observation of args.nodes) {
    const outcome = await resolveNode({ workspace, model, readCached }, observation);
    // One unresolvable node makes the whole selection untrustworthy: a partial
    // selection would silently drop the element the user actually clicked.
    if (outcome.status === "stale") return outcome;
    nodes.push(outcome.node);
  }

  return {
    status: "ok",
    selection: {
      selectionId: randomUUID(),
      workspaceSessionId: workspace.id,
      projectId: workspace.projectId,
      worktreeId: workspace.worktreeId,
      appRoot: workspace.appRoot,
      previewPanelId: args.previewPanelId,
      documentEpoch: args.documentEpoch,
      routeId: args.routeId,
      displayedUrl: redactUrl(args.url),
      viewport: args.viewport,
      nodes,
      capturedAt: new Date().toISOString(),
    },
  };
}
