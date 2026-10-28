import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/CopyButton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import type { SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import type { Capability } from "@shared/elementPicker";
import {
  elementClaim,
  elementPlace,
  isTraced,
  primaryObservation,
  scopesFor,
  type PickedSelection,
  type SourcePoint,
} from "./selection.js";
import { STALE_COPY } from "./copy.js";
import { middleTruncatePath } from "@/utils/textParsing";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";
import { PickerIconButton } from "./PickerIconButton.js";

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
  onSelectComponent,
}: {
  selection: ReadySelection;
  /** Needed only for Open in editor, which wants an absolute path. */
  worktreePath?: string | null;
  /** Select the component invoked at a call site the trail names. Read-only without it. */
  onSelectComponent?: (usedAt: SourcePoint) => void;
}) {
  const picked = selection.selection;
  const observation = primaryObservation(picked);
  if (!observation) return null;
  // While the page is being asked for the element again, "select again" would
  // be an instruction the next second usually withdraws.
  const stale = selection.stale && !selection.reproving ? STALE_COPY[selection.stale] : null;
  // A component picked on the page is named as the component, with the element
  // it was reached through left to the trail below.
  const scopes = scopesFor(picked);
  const pickedScope = picked.scope.kind === "component" ? scopes.scopes[scopes.pickedIndex] : null;
  const component = pickedScope?.kind === "component" ? pickedScope.label : null;
  const place = component
    ? pickedScope?.kind === "component" && pickedScope.file
      ? { path: pickedScope.file, line: null }
      : null
    : elementPlace(picked, observation);
  const file = place?.path ?? null;
  const line = place?.line ?? null;
  const source = file ? `${file}${line === null ? "" : `:${line}`}` : null;
  const absolute = file ? absolutePath(worktreePath, file) : null;
  // The header names the selection, so the trail shows only what is above it.
  const trail = trailFor(picked);
  const crumbs = trail.above;
  const label = component ?? displayLabel(observation.label, observation.tagName);

  return (
    // Focusable so a crumb activated from the keyboard has somewhere to land
    // once the answer replaces this block; never in the tab order.
    <section aria-label="Selected element" tabIndex={-1} className="flex flex-col gap-1">
      {/* Row 1, 28px: what it is. */}
      <div className="flex h-7 min-w-0 items-center gap-2">
        <Badge size="sm" tone="neutral" className={component ? undefined : "font-mono"}>
          {component ? "Component" : observation.tagName.toLowerCase()}
        </Badge>
        <TruncatedTooltip content={component ?? observation.label}>
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{label}</span>
        </TruncatedTooltip>
      </div>

      {/* Row 2, 24px: where it lives — and two things to do about that. The
          filename and line are a non-shrinking suffix so a narrow drawer
          contracts the directories, never the one part the reader came for. */}
      <div className="flex h-6 min-w-0 items-center gap-1">
        {source && file ? (
          <>
            <SourcePath file={file} line={line} className="min-w-0 flex-1" />
            <CopyButton
              size="icon-xs"
              text={source}
              aria-label="Copy path"
              announcement="Path copied"
              tooltipSide="bottom"
            />
            {absolute ? (
              <PickerIconButton
                icon={<ExternalLink aria-hidden="true" />}
                // The glyph, not the hit box, sits on the column edge the
                // fields below end at.
                className="-mr-1"
                aria-label="Open in editor"
                onClick={() =>
                  void actionService.dispatch(
                    "file.openInEditor",
                    line === null ? { path: absolute } : { path: absolute, line },
                    { source: "user" }
                  )
                }
              />
            ) : null}
          </>
        ) : !isTraced(picked) && observation.context ? (
          // Nothing to locate it by but the page's own account: the selector
          // a request quotes, shown the way it will be read.
          <TruncatedTooltip content={observation.context.selector}>
            <span className="min-w-0 truncate font-mono text-2xs text-text-secondary">
              {observation.context.selector}
            </span>
          </TruncatedTooltip>
        ) : (
          <p className="text-2xs text-text-secondary">
            {component ? "Couldn't find where it's written" : "Source unknown"}
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
              currentLabel={label}
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
          <span>{chainNote(observation.capabilities.chain, isTraced(picked))}</span>
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

      <MappingNotice selection={picked} located={place !== null} />
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
  const shownDir = middleTruncatePath(dir, 40);
  return (
    <span
      className={cn(
        "flex min-w-0 items-baseline font-mono text-2xs text-text-secondary",
        className
      )}
    >
      {dir ? (
        // Only the directories ever shorten, so they carry the disclosure.
        <TruncatedTooltip content={full} isTruncated={shownDir !== dir || undefined}>
          <span className="min-w-0 shrink truncate">{shownDir}</span>
        </TruncatedTooltip>
      ) : null}
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
 * What an empty trail means, as far as the page said: an element with nothing
 * around it, or a page that names no components at all. Never "top level" for
 * a chain the page didn't report.
 */
function chainNote(chain: Capability, traced: boolean): string {
  if (chain.state === "unavailable") return "The page doesn't name the components around it";
  return traced ? "at the top level" : "No components reported";
}

/**
 * The element's own name without its tag prefix: the badge beside it already
 * carries the tag, and `button` `button "Start Pro"` said it twice.
 */
function displayLabel(label: string, tagName: string): string {
  const tag = tagName.toLowerCase();
  const shown = label || tag || "element";
  const prefix = `${tag} `;
  return shown.startsWith(prefix) ? shown.slice(prefix.length) : shown;
}

function MappingNotice({
  selection,
  located,
}: {
  selection: PickedSelection;
  /** The host holds a place for what the identity names. */
  located: boolean;
}) {
  const observation = primaryObservation(selection);
  const count = selection.observations.length;
  // A component with several root elements is one thing, not a multi-selection.
  if (count > 1 && selection.scope.kind !== "component") {
    return (
      <InspectorNotice tone="info" title={`${count} elements selected`}>
        A request names one element. Select a single one, or pick the component around them.
      </InspectorNotice>
    );
  }
  if (observation === undefined) return null;
  if (elementClaim(selection, observation)?.result?.state === "ambiguous") {
    return (
      <InspectorNotice tone="warning" title="More than one source could own this element">
        A request about it can't say which file to change. Pick the component around it instead.
      </InspectorNotice>
    );
  }
  if (!isTraced(selection)) {
    const chain = observation.capabilities.chain;
    return (
      <InspectorNotice tone="info" title="Not traced to source">
        {chain.state === "unavailable" && chain.reason === "production-build"
          ? "This page is a production build, which carries no source locations. "
          : "The page reported no source for this element. "}
        A request carries its selector, markup, styles and a screenshot instead.
      </InspectorNotice>
    );
  }
  if (selection.workspaceId === null) {
    return (
      <InspectorNotice tone="info" title="Source not checked">
        The page said where this is written, but no source is open here to check it against, so a
        request quotes the page's own report.
      </InspectorNotice>
    );
  }
  if (!located && selection.scope.kind !== "component") {
    return (
      <InspectorNotice tone="info" title="Not traced to source">
        {/* What we know is that no source location came back. Content drawn at
            runtime is the usual reason, offered as the likely one rather than
            asserted — a missing location is not by itself evidence of it. */}
        A request about it can't name a file or line. Content drawn at runtime — raw HTML, a canvas
        or a shadow root — is the usual reason.
      </InspectorNotice>
    );
  }
  return null;
}
