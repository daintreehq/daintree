import { randomUUID } from "node:crypto";
import type { AncestryEntry as ModelAncestryEntry, SelectedNode } from "../shared/model.js";
import type {
  GuestNodeObservation,
  SelectionResolveArgs,
  SelectionResolveResult,
  SelectionMismatch,
} from "../shared/protocol.js";
import type { ResolvedElement } from "@daintreehq/svelte-source-model";
import { loadParse, loadSourceModel, type SourceModel } from "./engine.js";
import {
  containsRealPath,
  isGeneratedPath,
  readSource,
  resolveReportedPath,
  type SourceRead,
} from "./source.js";
import type { Workspace } from "./workspace.js";

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
  const inspectOnly = (): NodeOutcome => ({
    status: "ok",
    node: { ...base, definition: null, mapping: "visual-only" },
  });

  if (observation.unmapped) return inspectOnly();
  // An unstamped element the page could still place by shape is asked for at
  // the head of its template; the location comes from the walk.
  const loc =
    observation.loc ??
    (observation.structure ? { file: observation.structure.file, line: 1, column: 0 } : null);
  if (loc === null) return inspectOnly();
  if (model.isGeneratedSourceFile(loc.file)) return inspectOnly();
  const target = resolveReportedPath(workspace, loc.file);
  // Outside the app root is a workspace package or a dependency: real markup,
  // but not this app's to claim.
  if (!target.ok || !(await containsRealPath(workspace.appRoot, target.absolute))) {
    return inspectOnly();
  }
  if (isGeneratedPath(model.isGeneratedSourceFile, target.appRelative)) {
    return inspectOnly();
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
  // Walked once, whatever the stamp said, and read for two different things.
  const placed = observation.structure
    ? model.resolveElementByStructure(
        read.text,
        loc.file,
        {
          frame: observation.ancestry[0] ?? null,
          path: observation.structure.path,
          hint: stamped ? loc : null,
        },
        parse
      )
    : null;
  if (
    outcome.status === "stale" &&
    outcome.mismatch !== undefined &&
    placed?.status === "resolved"
  ) {
    const retried = attempt(placed.location);
    if (retried.status === "ok") {
      outcome = retried;
      location = placed.location;
      placedByStructure = true;
    }
  }
  if (outcome.status === "inspect-only") return inspectOnly();
  if (outcome.status === "stale") return outcome;
  const element = outcome.element;

  /**
   * What the walk can say about this placement, for a caller deciding whether
   * a selection may be re-acquired after the page changed under it.
   * `resolveElementByStructure` documents what the counts rule out and — more
   * to the point — what they do not.
   *
   * `agrees` is reported because the resolve above deliberately keeps a
   * same-tag stamp the shape would have placed elsewhere: right for a fresh
   * pick the user made and watched land, not good enough to re-adopt a
   * selection on nobody's behalf.
   */
  const shape =
    placed?.status === "resolved"
      ? {
          levelCounts: [...placed.levelCounts],
          agrees:
            placed.location.line === location.line && placed.location.column === location.column,
        }
      : null;

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
        ...(shape === null ? {} : { shape }),
      },
      mapping: invocation === null ? "definition-only" : "exact",
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
