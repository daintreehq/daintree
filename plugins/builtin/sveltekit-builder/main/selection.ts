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
import { loadParse, loadSourceModel, type SourceModel } from "./engine.js";
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
      capabilities,
    },
  };
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
