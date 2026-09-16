import { randomUUID } from "node:crypto";
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

type NodeOutcome = { status: "ok"; node: SelectedNode } | { status: "stale" };

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

  if (observation.unmapped || observation.loc === null) return inspectOnly("unmapped-content");

  const loc = observation.loc;
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
  const resolved = model.resolveElementAtLocation(read.text, loc, parse);
  if (resolved.status !== "resolved") {
    if (resolved.reason === "generated-file") return inspectOnly("generated-file");
    // Out of range, no element starting there, ambiguous, or unparseable: the
    // file is not the one this node was rendered from. Never a nearest match.
    return { status: "stale" };
  }

  const element = resolved.node;
  // The guest's coordinates carry no revision, so an observation captured
  // before an HMR update can land exactly on a different element in the new
  // bytes. The tag is the one independent witness available; a mismatch is a
  // stale selection. Same-tag shifts remain undetectable here.
  if (
    element.kind === "RegularElement" &&
    element.tagName.toLowerCase() !== observation.tagName.toLowerCase()
  ) {
    return { status: "stale" };
  }
  const capabilities =
    workspace.support.level === "full"
      ? capabilitiesOf(element)
      : everySurface("inspect-only", "unsupported-framework-version");

  return {
    status: "ok",
    node: {
      ...base,
      definition: {
        location: loc,
        range: element.range,
        tagName: element.tagName,
        revision: read.revision,
        renderedOccurrences: observation.sameLocCount,
      },
      mapping: invocation === null ? "definition-only" : "exact",
      ...(await surfacesOf(read.text, element, capabilities)),
    },
  };
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
    if (outcome.status === "stale") return { status: "stale" };
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
