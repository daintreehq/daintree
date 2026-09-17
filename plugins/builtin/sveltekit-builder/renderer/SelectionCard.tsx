import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { SelectedNode } from "../shared/model.js";
import { worktreeRelative, type SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { scopesFor, type CallSite } from "./agentTask.js";
import { STALE_COPY } from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";

type ReadySelection = Extract<SelectionState, { status: "ready" }>;

/**
 * What was selected and where it comes from.
 *
 * The one identity in the drawer. It used to be said three times — a mono
 * `button` badge beside the label `button "Start Pro"`, then the path, then the
 * composer's own `About button "Start Pro" · +page.svelte:6` sixty pixels
 * below — so the densest text in the panel was a repeat, and under a component
 * request scope the two disagreed outright. The composer now labels its scope
 * control instead of restating the subject, and this block is the only place
 * the selection is named.
 */
export function SelectionIdentity({
  selection,
  worktreePath = null,
  reselecting = false,
  onSelectComponent,
}: {
  selection: ReadySelection;
  /** Needed only for Open in editor, which wants an absolute path. */
  worktreePath?: string | null;
  /** The page is re-observing the element; the stale notice waits for its answer. */
  reselecting?: boolean;
  /** Select the component invoked at a call site the trail names. Read-only without it. */
  onSelectComponent?: (usedAt: CallSite) => void;
}) {
  const nodes = selection.selection.nodes;
  const node = nodes[0];
  const { copy, copiedText } = useCopyWithFeedback({ announcement: "Path copied" });
  if (!node) return null;
  const definition = node.definition;
  const stale = selection.stale && !reselecting ? STALE_COPY[selection.stale] : null;
  // A component picked on the page is named as the component, with the element
  // it was reached through left to the trail below.
  const picked =
    selection.scope === "component"
      ? scopesFor(selection.selection, selection.component, selection.definitions)
      : null;
  const pickedScope = picked ? picked.scopes[picked.pickedIndex] : null;
  const component = pickedScope?.kind === "component" ? pickedScope.label : null;
  // Main answers component definitions relative to the app; everything this
  // block shows, copies or opens is relative to the worktree.
  const componentFile =
    pickedScope?.kind === "component" && pickedScope.file
      ? worktreeRelative(selection.selection.appRoot, worktreePath, pickedScope.file)
      : null;
  const file = component
    ? componentFile
    : definition
      ? (selection.file ?? definition.location.file)
      : null;
  const line = component ? null : (definition?.location.line ?? null);
  const source = file ? `${file}${line === null ? "" : `:${line}`}` : null;
  const absolute = file ? absolutePath(worktreePath, file) : null;
  // The header names the selection, so the trail shows only what is above it.
  const trail = trailFor(
    node,
    pickedScope?.kind === "component"
      ? { label: pickedScope.label, usedAt: pickedScope.usedAt }
      : null
  );
  const crumbs = trail.above;

  return (
    // Focusable so a crumb activated from the keyboard has somewhere to land
    // once the answer replaces this block; never in the tab order.
    <section aria-label="Selected element" tabIndex={-1} className="flex flex-col gap-1">
      {/* Row 1, 28px: what it is. */}
      <div className="flex h-7 min-w-0 items-center gap-2">
        <Badge size="sm" tone="neutral" className={component ? undefined : "font-mono"}>
          {component ? "Component" : (definition?.tagName ?? tagFromLabel(node))}
        </Badge>
        <span
          className="min-w-0 truncate text-sm font-medium text-text-primary"
          title={component ?? node.label}
        >
          {component ?? displayLabel(node)}
        </span>
      </div>

      {/* Row 2, 24px: where it lives — and two things to do about that. The
          path used to be inert text with a title. The filename and line are
          a non-shrinking suffix so a narrow drawer contracts the directories,
          never the one part the reader came for. */}
      <div className="flex h-6 min-w-0 items-center gap-1">
        {source && file ? (
          <>
            <SourcePath file={file} line={line} className="min-w-0 flex-1" />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={copiedText === source ? "Path copied" : "Copy path"}
              title="Copy path"
              onClick={() => void copy(source)}
            >
              {copiedText === source ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
            {absolute ? (
              <Button
                variant="ghost"
                size="icon-xs"
                // The glyph, not the hit box, sits on the column edge the
                // fields below end at.
                className="-mr-1"
                aria-label="Open in editor"
                title="Open in editor"
                onClick={() =>
                  void actionService.dispatch(
                    "file.openInEditor",
                    line === null ? { path: absolute } : { path: absolute, line },
                    { source: "user" }
                  )
                }
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-2xs text-text-secondary">
            {component
              ? selection.definitions === null
                ? "Finding where it's written"
                : "Couldn't find where it's written"
              : "Source unknown"}
          </p>
        )}
      </div>

      {/* Row 3, 20px: how it was reached. The header names the selection, so
          the trail shows the route and carries the identity for assistive
          technology rather than repeating it visibly. */}
      <div className="flex h-5 min-w-0 items-center gap-1 text-2xs text-text-secondary">
        {crumbs.length > 0 ? (
          <>
            <span className="shrink-0">in</span>
            <SelectionTrail
              crumbs={crumbs}
              currentIndex={crumbs.length}
              currentLabel={component ?? displayLabel(node)}
              selectionSite={trail.current.usedAt}
              onSelect={
                onSelectComponent
                  ? (crumb) => {
                      if (crumb.usedAt) onSelectComponent(crumb.usedAt);
                    }
                  : undefined
              }
              className="min-w-0"
            />
          </>
        ) : (
          <span>at the top level</span>
        )}
      </div>

      {stale ? (
        <InspectorNotice
          tone="warning"
          title={stale.title}
          role="status"
          density="compact"
          className="mt-1"
        >
          {stale.detail}
        </InspectorNotice>
      ) : null}

      <MappingNotice node={node} nodeCount={nodes.length} scope={selection.scope} />
    </section>
  );
}

/**
 * A source location whose filename and line cannot be truncated away. The
 * directories are one flex child that shrinks and middle-truncates; the tail
 * is another that does not shrink at all.
 */
export function SourcePath({
  file,
  line,
  className,
}: {
  file: string;
  line: number | null;
  className?: string;
}) {
  const slash = file.lastIndexOf("/");
  const dir = slash === -1 ? "" : file.slice(0, slash + 1);
  const name = slash === -1 ? file : file.slice(slash + 1);
  const full = `${file}${line === null ? "" : `:${line}`}`;
  return (
    <span
      className={cn(
        "flex min-w-0 items-baseline font-mono text-2xs text-text-secondary",
        className
      )}
      title={full}
    >
      {dir ? <span className="min-w-0 shrink truncate">{middleTruncatePath(dir, 40)}</span> : null}
      <span className="shrink-0">
        {name}
        {/* Same tone as the path: `text-muted` has no dark-theme floor and the
            line number vanished on namib. */}
        {line === null ? null : <span>{`:${line}`}</span>}
      </span>
    </span>
  );
}

function absolutePath(worktreePath: string | null, file: string): string | null {
  if (file.startsWith("/")) return file;
  if (!worktreePath) return null;
  return `${worktreePath.replace(/\/+$/, "")}/${file}`;
}

/**
 * The element's own name without its tag prefix: the badge beside it already
 * carries the tag, and `button` `button "Start Pro"` said it twice.
 */
function displayLabel(node: SelectedNode): string {
  const tag = node.definition?.tagName;
  const label = node.label || tag || "element";
  if (!tag) return label;
  const prefix = `${tag} `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

function tagFromLabel(node: SelectedNode): string {
  return node.label.split(/\s/)[0] || "element";
}

function MappingNotice({
  node,
  nodeCount,
  scope,
}: {
  node: SelectedNode;
  nodeCount: number;
  scope: "element" | "component";
}) {
  // A component with several root elements is one thing, not a multi-selection.
  if (nodeCount > 1 && scope !== "component") {
    return (
      <InspectorNotice tone="info" title={`${nodeCount} elements selected`}>
        A request names one element. Select a single one, or pick the component around them.
      </InspectorNotice>
    );
  }
  if (node.mapping === "ambiguous") {
    return (
      <InspectorNotice tone="warning" title="More than one source could own this element">
        A request about it can't say which file to change. Pick the component around it instead.
      </InspectorNotice>
    );
  }
  if (node.mapping === "visual-only" || !node.definition) {
    return (
      <InspectorNotice tone="info" title="Not traced to source">
        {/* What we know is that no source location came back. Content drawn at
            runtime is the usual reason, offered as the likely one rather than
            asserted — a missing mapping is not by itself evidence of {@html},
            a canvas or a shadow root. */}
        A request about it can't name a file or line. Content drawn at runtime — by {"{@html}"}, a
        canvas or a shadow root — is the usual reason.
      </InspectorNotice>
    );
  }
  return null;
}
