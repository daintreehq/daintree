import { ExternalLink } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import type { SelectionState } from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import type { Capability } from "@shared/elementPicker";
import {
  displayLine,
  elementClaim,
  elementPlace,
  isTraced,
  primaryObservation,
  scopesFor,
  type PickedSelection,
} from "./selection.js";
import { STALE_COPY, issueSaysUntraced, missingComponentSource } from "./copy.js";
import { SelectionTrail, trailFor, type CrumbSelect, type TrailCrumb } from "./SelectionTrail.js";
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
  pageVerdict,
  onChooseApp,
  noWorktree = false,
}: {
  selection: ReadySelection;
  /** Needed only for Open in editor, which wants an absolute path. */
  worktreePath?: string | null;
  /** Select a component the trail names. Read-only without it. */
  onSelectComponent?: CrumbSelect;
  /** The page's own verdict on itself, when the drawer is already saying it. */
  pageVerdict?: string;
  /** Take the user to the Site source choice, when choosing an app is what's missing. */
  onChooseApp?: () => void;
  /** The preview has no worktree; Site source says so for the whole drawer. */
  noWorktree?: boolean;
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
  const reported = place === null && picked.workspaceId === null ? reportedPlace(picked) : null;
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
          actions keep their column; the path takes what is left, directories
          yielding first and the extension and line never. */}
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
        ) : reported ? (
          // The page said where it is and nothing here could check it: shown
          // as the page's word, so the notice below has something to point at.
          <>
            <SourcePath file={reported.path} line={reported.line} className="min-w-0 flex-1" />
            <span className="shrink-0 text-3xs text-text-secondary">Not checked</span>
            <CopyButton
              size="icon-xs"
              text={`${reported.path}${reported.line === null ? "" : `:${reported.line}`}`}
              aria-label="Copy path"
              announcement="Path copied"
              tooltipSide="bottom"
            />
          </>
        ) : !isTraced(picked) && observation.context ? (
          // Nothing to locate it by but the page's own account: the selector
          // a request quotes, shown the way it will be read.
          <SelectorText selector={observation.context.selector} />
        ) : (
          <p className="text-2xs text-text-secondary">
            {component ? missingComponentSource() : "Source unknown"}
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
              truncated={trail.truncated}
              onSelect={
                onSelectComponent
                  ? (crumb, fromMenu) => {
                      if (crumb.component) onSelectComponent.select(crumb.component, fromMenu);
                    }
                  : undefined
              }
              selectBy={onSelectComponent?.by}
              className="min-w-0 flex-1"
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

      <MappingNotice
        selection={picked}
        located={place !== null}
        pageVerdict={pageVerdict}
        onChooseApp={onChooseApp}
        noWorktree={noWorktree}
        widen={
          onSelectComponent && crumbs.length > 0 && picked.scope.kind !== "component"
            ? { crumb: crumbs[crumbs.length - 1]!, select: onSelectComponent }
            : undefined
        }
      />
    </section>
  );
}

/**
 * A path shortened to fit `max` characters, the one way the picker shortens
 * any path: the directories give way first, keeping their start, then the
 * middle of the filename's stem — never its extension or `:line`, the part a
 * reader came for. The cut is always marked once, so `src/lib/comp…/Upgrade
 * Button.svelte:14` never grows a second ellipsis beside the first.
 */
export function fitPath(file: string, line: number | null, max: number): string {
  const full = `${file}${line === null ? "" : `:${line}`}`;
  if (full.length <= max) return full;
  const slash = file.lastIndexOf("/");
  const dir = slash === -1 ? "" : file.slice(0, slash);
  const name = slash === -1 ? file : file.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const tail = `${dot > 0 ? name.slice(dot) : ""}${line === null ? "" : `:${line}`}`;
  // `head…/stem.ext:line`, keeping as much of the directories' start as fits —
  // but never a stub: `sr…/` says less than `…/` and costs more.
  const dirRoom = max - stem.length - tail.length - 2;
  if (dir && dirRoom >= MIN_DIR_HEAD) {
    // Cut at a folder boundary when one is in reach, so `src/lib/…/` never
    // reads as a folder called `component`.
    const head = dir.slice(0, dirRoom);
    const boundary = head.lastIndexOf("/");
    return `${boundary >= MIN_DIR_HEAD - 3 ? head.slice(0, boundary + 1) : head}…/${stem}${tail}`;
  }
  if (dir && stem.length + tail.length + 2 <= max) return `…/${stem}${tail}`;
  // The stem itself is too long: `…/` says directories were dropped, and the
  // stem keeps its start and its end around one cut. Room runs out in order:
  // the `…/`, then the stem, and last of all the end of the tail.
  let lead = dir ? "…/" : "";
  let room = max - lead.length - tail.length - 1;
  if (room < 2 && lead) {
    lead = "";
    room = max - tail.length - 1;
  }
  if (room < 1) return `…${full.slice(full.length - (max - 1))}`;
  const front = Math.ceil(room / 2);
  const back = room - front;
  return `${lead}${stem.slice(0, front)}…${back > 0 ? stem.slice(stem.length - back) : ""}${tail}`;
}

/** The shortest start of a directory worth keeping before its ellipsis. */
const MIN_DIR_HEAD = 6;

/**
 * How many characters of a monospace string fit the box it is laid out in.
 * The full string sits invisibly in flow, so the box takes the width the full
 * string would be given — never the width of the shortened one, which would
 * shrink the box and shorten the string again — and the shortened string is
 * drawn over it.
 */
function useMonoFit(text: string): {
  boxRef: (element: HTMLElement | null) => void;
  fit: number;
} {
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    if (!box) return;
    const measure = box.firstElementChild;
    const run = () => {
      const natural = measure instanceof HTMLElement ? measure.getBoundingClientRect().width : 0;
      if (natural === 0 || text.length === 0) return;
      const perChar = natural / text.length;
      setFit(Math.max(4, Math.floor((box.clientWidth + 0.5) / perChar)));
    };
    run();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(run);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, text]);
  return { boxRef: setBox, fit };
}

/**
 * A source location, shortened by {@link fitPath} to the width it is given —
 * the same rule in the drawer, the folded strip, the Site source list and the
 * App switcher, so no two surfaces shorten one path two ways. The whole
 * location is the disclosure, whichever part was cut.
 */
export function SourcePath({
  file,
  line,
  className,
  disclose = true,
}: {
  file: string;
  line: number | null;
  className?: string;
  /** False where the caller is the focus target and discloses the path itself. */
  disclose?: boolean;
}) {
  const full = `${file}${line === null ? "" : `:${line}`}`;
  const { boxRef, fit } = useMonoFit(full);
  const shown = fitPath(file, line, fit);
  // The measured box sits inside the element a tooltip clones, never as it:
  // the tooltip reads its child's ref, which React 19 no longer exposes.
  const path = (
    <span
      className={cn(
        "flex min-w-0 font-mono text-2xs whitespace-nowrap text-text-secondary",
        className
      )}
    >
      {/* Clips along the line only: `overflow-hidden` also cut the descenders
          under an inherited `leading-none`, as in an xs Button. */}
      <span ref={boxRef} className="relative block min-w-0 flex-1 overflow-x-clip">
        <span aria-hidden="true" className="invisible">
          {full}
        </span>
        {/* Same tone as the path: `text-muted` has no dark-theme floor and the
            line number vanished on namib. */}
        <span className="absolute inset-y-0 left-0">{shown}</span>
      </span>
    </span>
  );
  if (!disclose) return path;
  return (
    <TruncatedTooltip content={full} isTruncated={shown !== full}>
      {path}
    </TruncatedTooltip>
  );
}

/**
 * The selector a request quotes for an untraced element, shortened from the
 * middle so the element it ends at — the part that says which one — stays.
 */
function SelectorText({ selector }: { selector: string }) {
  const { boxRef, fit } = useMonoFit(selector);
  const parts = selector.split(" > ");
  let shown = selector;
  if (selector.length > fit && parts.length > 2) {
    // The first step and as many of the last as fit, around one cut.
    const first = parts[0]!;
    let tailParts: string[] = [parts[parts.length - 1]!];
    for (let i = parts.length - 2; i > 0; i--) {
      const next = [parts[i]!, ...tailParts];
      if (`${first} > … > ${next.join(" > ")}`.length > fit) break;
      tailParts = next;
    }
    shown = `${first} > … > ${tailParts.join(" > ")}`;
  }
  if (shown.length > fit) shown = `${shown.slice(0, Math.max(1, fit - 1))}…`;
  return (
    <TruncatedTooltip content={selector} isTruncated={shown !== selector || selector.length > fit}>
      <span className="flex min-w-0 flex-1 font-mono text-2xs whitespace-nowrap text-text-secondary">
        <span ref={boxRef} className="relative block min-w-0 flex-1 overflow-hidden">
          <span aria-hidden="true" className="invisible">
            {selector}
          </span>
          <span className="absolute inset-y-0 left-0">{shown}</span>
        </span>
      </span>
    </TruncatedTooltip>
  );
}

/**
 * Where the page itself said the element is written, for a selection no
 * source could check: its first location claim, when it names a file in the
 * project rather than a URL the dev server served.
 */
function reportedPlace(selection: PickedSelection): { path: string; line: number | null } | null {
  const observation = primaryObservation(selection);
  if (!observation) return null;
  const claim = elementClaim(selection, observation)?.candidate;
  if (!claim || claim.kind === "file-hint" || claim.file.includes("://")) return null;
  return { path: claim.file, line: claim.location === null ? null : displayLine(claim.location) };
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

/**
 * What a request about this selection can and can't claim, as one notice with
 * its own headline. Where the user can lift the limit — pick the component
 * around it, choose the app — the notice carries that one action; where
 * nothing can, it is information and stays quiet. A page-level verdict the
 * drawer is already showing is not said a second time here.
 */
function MappingNotice({
  selection,
  located,
  pageVerdict,
  onChooseApp,
  widen,
  noWorktree,
}: {
  selection: PickedSelection;
  /** The host holds a place for what the identity names. */
  located: boolean;
  pageVerdict?: string;
  onChooseApp?: () => void;
  /** The component around the element, and how to select it. */
  widen?: { crumb: TrailCrumb; select: CrumbSelect };
  /** The preview has no worktree, which Site source already says. */
  noWorktree?: boolean;
}) {
  const observation = primaryObservation(selection);
  const count = selection.observations.length;
  const target = widen?.crumb.component;
  const widenAction =
    widen && target && (widen.select.by === "id" ? target.rendered : target.usedAt !== null) ? (
      <Button variant="secondary" size="xs" onClick={() => widen.select.select(target)}>
        Select {widen.crumb.label}
      </Button>
    ) : undefined;
  // A component with several root elements is one thing, not a multi-selection.
  if (count > 1 && selection.scope.kind !== "component") {
    return (
      <InspectorNotice tone="info" title={`${count} elements in this pick`} density="compact">
        The page reported them as separate elements, so a request describes each one.
      </InspectorNotice>
    );
  }
  if (observation === undefined) return null;
  if (elementClaim(selection, observation)?.result?.state === "ambiguous") {
    return (
      <InspectorNotice
        tone="info"
        title="Two or more files could own this element"
        density="compact"
        action={widenAction}
      >
        A request can&apos;t name which one to change. The component around it has one file.
      </InspectorNotice>
    );
  }
  if (!isTraced(selection)) {
    if (issueSaysUntraced(pageVerdict)) return null;
    const chain = observation.capabilities.chain;
    return (
      <InspectorNotice tone="info" title="No source reported for this element" density="compact">
        {chain.state === "unavailable" && chain.reason === "production-build"
          ? "This page is a production build."
          : "The page didn't say where it's written."}
      </InspectorNotice>
    );
  }
  if (selection.workspaceId === null) {
    // With no worktree at all, Site source says it once for the whole drawer.
    if (noWorktree) return null;
    return (
      <InspectorNotice
        tone="info"
        title="Location not checked against source"
        density="compact"
        action={
          onChooseApp ? (
            <Button variant="secondary" size="xs" onClick={() => onChooseApp()}>
              Choose the app
            </Button>
          ) : undefined
        }
      >
        {onChooseApp
          ? "No app is chosen for this preview, so a request quotes the location the page reported."
          : "No source is open for this preview, so a request quotes the location the page reported."}
      </InspectorNotice>
    );
  }
  if (!located && selection.scope.kind !== "component") {
    return (
      <InspectorNotice
        tone="info"
        title="No file or line for this element"
        density="compact"
        action={widenAction}
      >
        The page traced the components around it but not this element, so a request can&apos;t name
        where it&apos;s written.
      </InspectorNotice>
    );
  }
  return null;
}
