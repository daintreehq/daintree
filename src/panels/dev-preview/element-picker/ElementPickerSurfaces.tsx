import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  ChevronRight,
  CirclePause,
  FolderCode,
  FolderTree,
  Info,
  MousePointer2,
  PanelRightClose,
  PanelRightOpen,
  SquareDashedMousePointer,
  Unplug,
  XCircle,
} from "lucide-react";
import type { DevPreviewToolSurfaceProps } from "@/services/devPreviewTools/types";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { KBD_COMPACT_CLASS, KbdChord } from "@/components/ui/Kbd";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  INITIAL_INSPECTOR_STATE,
  type InspectorController,
  type InspectorState,
} from "./inspectorController.js";
import { InspectorNotice } from "./InspectorNotice.js";
import { PropertyRow, SectionHeader } from "./InspectorSection.js";
import { SelectionIdentity, SourcePath } from "./SelectionCard.js";
import { Spinner } from "@/components/ui/Spinner";
import { AgentComposer } from "./AgentComposer.js";
import {
  composerMemoryKey,
  setDrawerCollapsed,
  useComposerMemory,
  useComposerOccupied,
  useDrawerCollapsed,
} from "./composerMemory.js";
import { WaitingRow } from "./WaitingRow.js";
import { IdentitySkeleton } from "./IdentitySkeleton.js";
import { useDeferredLoading, useDohertyGate, useSkeletonFloor } from "@/hooks/useDeferredLoading";
import { UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import {
  elementPlace,
  primaryObservation,
  scopesFor,
  type PickedSelection,
  type SourcePoint,
} from "./selection.js";
import {
  BROWSE_COPY,
  DETACH_COPY,
  INSPECT_IDLE_COPY,
  ORIGIN_SUSPENDED_COPY,
  SELECTION_OUTCOME_COPY,
  STALE_COPY,
  TOOL_NAME,
  UNTESTED_TOOLCHAIN_TITLE,
  WORKSPACE_FAILURE_COPY,
  issueDetailIsDiagnostic,
  relativeTo,
  untestedToolchainDetail,
} from "./copy.js";
import { SelectionTrail, trailFor } from "./SelectionTrail.js";
import { PickerIconButton } from "./PickerIconButton.js";

const MODE_OPTIONS = [
  { value: "browse" as const, label: "Browse" },
  { value: "select" as const, label: "Inspect" },
];

/**
 * The picker for the dev preview hosting it: the host's session for this
 * preview, shared by the strip and the drawer and outliving both. The host
 * creates it when the picker is switched on, keeps it telling the controller
 * which worktree and page the preview is on, and disposes it when the picker,
 * or the preview ends — so a surface only reads it.
 */
function useInspectorSession(props: DevPreviewToolSurfaceProps<InspectorController>): {
  controller: InspectorController | null;
  state: InspectorState;
} {
  const controller = props.session;
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getSnapshot ?? initialSnapshot
  );
  return { controller, state };
}

const subscribeNothing = (): (() => void) => () => {};
const initialSnapshot = (): InspectorState => INITIAL_INSPECTOR_STATE;

/**
 * Selecting a component from a surface's trail, with focus accounted for.
 *
 * The crumb is a button that the page's answer replaces with text — and the
 * whole trail leaves while the source is being found — so a keyboard user who
 * pressed Enter on it would be dropped on the document body. When focus was in
 * the surface at the click, it is put on what `landing` finds in the surface
 * once the new selection is ready. A mouse click in Safari does not focus a
 * button, and then nothing is moved.
 *
 * The intent is for one answer: it is dropped when the pick is refused, when
 * the selection ends anywhere but ready, and after a bound wait — so a page
 * click made after an abandoned pick never has its focus pulled into a
 * surface the user has left.
 *
 * Undefined while a pick can't be made, so the crumbs are plain text rather
 * than buttons that do nothing.
 */
function useSelectCrumb(
  controller: InspectorController | null,
  state: InspectorState,
  root: RefObject<HTMLElement | null>,
  landing: (root: HTMLElement) => HTMLElement | null,
  /**
   * Whether {@link landing}'s target is on screen yet. False while a surface is
   * still holding a skeleton over the answer: the intent has to survive that,
   * or focus is spent on a landing that has not been rendered.
   */
  landingReady = true
): ((usedAt: SourcePoint, keepFocus?: boolean) => void) | undefined {
  // The generation the pick was made from; the answer advances it.
  const pending = useRef<{ generation: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const status = state.selection.status;
  const generation = state.selectionGeneration;
  // Stable: both effects below take it as a dependency, and a fresh identity
  // each render would make their dependency arrays meaningless. Only the ref is
  // touched, so nothing here can go stale.
  const drop = useCallback(() => {
    if (pending.current === null) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);
  useEffect(() => {
    if (pending.current === null || status === "resolving") return;
    if (status !== "ready") {
      drop();
      return;
    }
    if (generation === pending.current.generation) return;
    // The answer is in but its landing is not; the intent's own timeout still
    // bounds the wait, and this runs again when the landing arrives.
    if (!landingReady) return;
    drop();
    const target = root.current ? landing(root.current) : null;
    target?.focus();
  }, [status, generation, landingReady, root, landing, drop]);
  useEffect(() => drop, [drop]);
  if (controller === null || !controller.canSelectComponent()) return undefined;
  return (usedAt, keepFocus = false) => {
    drop();
    // A pick from the trail's overflow menu is made from a portalled menu, so
    // focus is outside the surface at that moment; the surface still owns it.
    const focused = keepFocus || (root.current?.contains(document.activeElement) ?? false);
    if (focused) {
      pending.current = { generation, timer: setTimeout(drop, CRUMB_FOCUS_WAIT_MS) };
    }
    void controller.selectComponent(usedAt).then((sent) => {
      if (!sent) drop();
    });
  };
}

/** How long a crumb's answer may take before its focus intent lapses. */
const CRUMB_FOCUS_WAIT_MS = 3000;

/**
 * Where focus lands in the strip after a crumb: the innermost crumb still
 * selectable, else the strip's first control. A button, so the toolbar's
 * roving keys keep working from there.
 */
function stripLanding(root: HTMLElement): HTMLElement | null {
  const crumbs = root.querySelectorAll<HTMLElement>('nav[aria-label="Breadcrumb"] button');
  return crumbs[crumbs.length - 1] ?? root.querySelector<HTMLElement>("button");
}

/**
 * Whether the drawer has anything to disclose. The drawer's own open gate and
 * the toolbar's disclosure state are the same question asked from two places,
 * so they ask it once here — a toggle reporting "expanded" over a drawer that
 * rendered nothing is a claim about an empty strip.
 */
function drawerHasDetails(state: InspectorState, composerOccupied: boolean): boolean {
  return (
    composerOccupied ||
    state.selection.status !== "none" ||
    state.issue !== null ||
    workspaceNeedsAttention(state)
  );
}

/** The drawer's identity block, which is there the moment the selection is ready. */
function drawerLanding(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[aria-label="Selected element"]');
}

/** The strip under the browser toolbar: mode, what is selected, and close. */
export function ElementPickerToolbar(props: DevPreviewToolSurfaceProps<InspectorController>) {
  const { controller, state } = useInspectorSession(props);
  const bound = state.binding.status === "bound";
  // The APG toolbar contract: the whole row is one tab stop, Left/Right move
  // between its controls. The row claimed `role="toolbar"` while every control
  // kept its own tab stop, so reaching the page past it cost five presses.
  // `useToolbarRoving` is the house implementation — four other toolbars use it.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const onStripKeyDown = useToolbarRoving(stripRef);
  const drawerCollapsed = useDrawerCollapsed(props.panelId);
  // What the drawer would show, read here so the disclosure toggle can report
  // whether pressing it actually reveals anything — the drawer keeps itself
  // shut when there is nothing in it.
  const composerOccupied = useComposerOccupied(composerMemoryKey(props.panelId, props.worktreeId));
  const hasDetails = drawerHasDetails(state, composerOccupied);
  const selectCrumb = useSelectCrumb(controller, state, stripRef, stripLanding);
  const close = (
    <DismissButton
      aria-label={`Close ${TOOL_NAME}`}
      tooltip={`Close ${TOOL_NAME}`}
      onClick={() => props.onClose()}
    />
  );
  if (!controller) {
    return (
      <div
        ref={stripRef}
        role="toolbar"
        aria-label={TOOL_NAME}
        onKeyDown={onStripKeyDown}
        className="flex h-8 shrink-0 items-center gap-2 border-b border-overlay bg-surface px-2"
      >
        <div className="flex min-w-0 flex-1 items-center">
          <WaitingRow label={`Starting the ${TOOL_NAME}`} />
        </div>
        {close}
      </div>
    );
  }
  const notice = stripNotice(state);
  // What the live region says: the strip's sentence, or — folded, where the
  // drawer's own notice isn't there to say it — that the selection is stale.
  const selection = state.selection;
  const staleNote =
    selection.status === "ready" && selection.stale && !selection.reproving
      ? STALE_COPY[selection.stale].title
      : null;
  const drawerShowing = hasDetails && !drawerCollapsed;
  const announcement = notice?.text ?? (staleNote && !drawerShowing ? staleNote : "");

  return (
    <div
      ref={stripRef}
      role="toolbar"
      aria-label={TOOL_NAME}
      onKeyDown={onStripKeyDown}
      className="@container/strip flex h-8 shrink-0 items-center gap-2 border-b border-overlay bg-surface px-2"
    >
      <SegmentedRadioGroup
        density="compact"
        aria-label="Canvas mode"
        options={MODE_OPTIONS}
        value={state.mode}
        onChange={(mode) => void controller.setMode(mode)}
      />
      <div aria-hidden="true" className="toolbar-divider h-4 w-px shrink-0" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-text-secondary">
        {notice ? (
          <StripNoticeRow notice={notice} controller={controller} />
        ) : (
          <StripStatus
            state={state}
            controller={controller}
            bound={bound}
            drawerShowing={drawerShowing}
            selectCrumb={selectCrumb}
            worktreePath={props.worktreePath}
          />
        )}
      </div>
      {/* One persistent live region for the strip's sentence, so a disconnect
          or a lost pick is announced as it happens rather than only being
          there for whoever looks. Waits announce through their own row. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <DrawerToggle panelId={props.panelId} expanded={drawerShowing} available={hasDetails} />
      {close}
    </div>
  );
}

/**
 * The drawer's disclosure control. The name is the thing, not the next action,
 * so it holds still while the state travels on `aria-expanded` — and the state
 * is whether the drawer is actually showing, not merely whether it was folded
 * away: it hides itself when there is nothing in it, and claiming expansion
 * over an empty strip would be a claim about nothing.
 *
 * With nothing to show it is disabled rather than live: pressing it then would
 * flip a flag the user can't see, and their next pick would land with the
 * drawer shut and nothing on screen saying why.
 *
 * `aria-expanded`, not `aria-pressed`: the two must never appear together, and
 * this shows and hides a region rather than latching a setting.
 */
function DrawerToggle({
  panelId,
  expanded,
  available,
}: {
  panelId: string;
  expanded: boolean;
  available: boolean;
}) {
  const collapsed = useDrawerCollapsed(panelId);
  return (
    <PickerIconButton
      // The glyph says what the drawer is doing, like the state it mirrors:
      // a toggle with nothing to show must not wear "close".
      icon={
        expanded ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />
      }
      aria-label={`${TOOL_NAME} details`}
      aria-expanded={expanded}
      disabled={!available}
      onClick={() => setDrawerCollapsed(panelId, !collapsed)}
    />
  );
}

/** How to walk the page from the keyboard once something is selected. */
function KeyHints({ canWiden }: { canWiden: boolean }) {
  return (
    // The compact key cap, not a hand-rolled box: the product already has one
    // key-cap grammar and this row is exactly the dense case it was tightened
    // for. Unstyled, the two hints and the file path beside them read as one
    // running sentence.
    <span className="ml-auto hidden shrink-0 items-center gap-2 text-3xs text-text-secondary @[640px]/strip:flex">
      <span className="flex items-center gap-1">
        {/* Sans, as KbdChord sets its arrows: the mono face has no arrow glyphs. */}
        <kbd className={cn(KBD_COMPACT_CLASS, "font-sans")}>↑↓←→</kbd>
        move
      </span>
      {/* Only where the page can actually widen to a component. */}
      {canWiden ? (
        <span className="flex items-center gap-1">
          <KbdChord shortcut="Alt+Up" density="compact" />
          component
        </span>
      ) : null}
    </span>
  );
}

type GlyphComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;

/**
 * Every sentence the strip can say instead of a selection, in one place, so
 * the strip and its live region say the same thing and the drawer's notices
 * have one vocabulary to match. Null while the strip shows a selection or a
 * wait, which carry their own presentation.
 */
interface StripNotice {
  icon: GlyphComponent;
  tone?: "warning" | "error";
  text: string;
  /** The diagnostic behind the sentence, one step away. */
  detail?: string;
  action?: { label: string; run: (controller: InspectorController) => void };
}

function stripNotice(state: InspectorState): StripNotice | null {
  const binding = state.binding;
  if (binding.status === "detached") {
    return {
      // A runtime that never started is a failure, not a disconnect.
      ...(binding.reason === "install-failed"
        ? { icon: XCircle, tone: "error" as const }
        : { icon: Unplug }),
      text: DETACH_COPY[binding.reason],
      action: { label: "Reconnect", run: (c) => void c.connect() },
    };
  }
  if (binding.status === "failed" && !binding.retrying) {
    return {
      icon: XCircle,
      tone: "error",
      text: "Couldn't connect to the page",
      detail: binding.message,
      action: { label: "Retry", run: (c) => void c.retryConnect() },
    };
  }
  if (binding.status !== "bound") return null;
  if (binding.suspended) return { icon: CirclePause, text: ORIGIN_SUSPENDED_COPY };
  const selection = state.selection;
  if (selection.status === "ready" || selection.status === "resolving") return null;
  if (state.mode === "browse") return { icon: MousePointer2, text: BROWSE_COPY };
  // The strip must not contradict the drawer: an invitation to click while the
  // drawer says the click didn't take is two surfaces telling two stories, and
  // with the drawer folded the strip is the only one telling any.
  switch (selection.status) {
    case "lost":
      return { icon: AlertTriangle, tone: "warning", text: SELECTION_OUTCOME_COPY.lost.title };
    case "settling":
      return selection.retrying
        ? null
        : { icon: AlertTriangle, tone: "warning", text: SELECTION_OUTCOME_COPY.settled.title };
    case "failed":
      if (selection.reason === "host") {
        return {
          icon: XCircle,
          tone: "error",
          // The drawer says "click it again" under its headline; folded, the
          // strip has one line to say both.
          text: `${SELECTION_OUTCOME_COPY.host.title} — select it again`,
          detail: selection.message,
        };
      }
      if (selection.reason === "mismatch") {
        return {
          icon: AlertTriangle,
          tone: "warning",
          text: SELECTION_OUTCOME_COPY.mismatch.title,
          action: { label: "Switch to Browse", run: (c) => void c.setMode("browse") },
        };
      }
      return {
        icon: AlertTriangle,
        tone: "warning",
        text: SELECTION_OUTCOME_COPY[selection.reason].title,
      };
  }
  const workspace = state.workspace;
  if (workspace.status === "ambiguous") {
    return { icon: FolderTree, text: "Choose which app this preview shows" };
  }
  if (workspace.status === "failed") {
    return {
      icon: AlertTriangle,
      tone: "warning",
      text: WORKSPACE_FAILURE_COPY[workspace.reason].strip,
    };
  }
  // A choice being opened is a wait, said by the wait row; the first open of
  // a preview is quick and silent, and a click made during it is held.
  if (workspace.status === "opening" && workspace.appPath) return null;
  // One sentence, whatever the framework: what the picker offers is the same
  // for every page it can trace.
  return { icon: SquareDashedMousePointer, text: INSPECT_IDLE_COPY };
}

/**
 * Every strip sentence leads with a glyph in the same slot, so the text starts
 * at one x whatever the state; states without one made the sentence jump as
 * the page connected, armed and detached.
 */
function StripNoticeRow({
  notice,
  controller,
}: {
  notice: StripNotice;
  controller: InspectorController;
}) {
  const Icon = notice.icon;
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            notice.tone === "warning" && "text-status-warning",
            notice.tone === "error" && "text-status-error"
          )}
          aria-hidden="true"
        />
        {/* A control that does nothing, as the stale sentence is: a cut
            sentence is a focus away in the roving order, not only a hover. */}
        <TruncatedTooltip content={notice.text}>
          <button
            type="button"
            aria-disabled="true"
            className="min-w-0 cursor-default truncate rounded-[var(--radius-sm)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
          >
            {notice.text}
          </button>
        </TruncatedTooltip>
      </span>
      {notice.action ? (
        // The strip's only action: `secondary` has a fill and a ring, where
        // `subtle` sat in the same grey as the sentence before it.
        <Button
          variant="secondary"
          size="xs"
          className="shrink-0"
          onClick={() => notice.action?.run(controller)}
        >
          {notice.action.label}
        </Button>
      ) : null}
      {notice.detail ? <DetailsButton detail={notice.detail} /> : null}
    </>
  );
}

/**
 * The diagnostic behind a strip sentence: a control in the toolbar's roving
 * order, so the evidence a pointer user can hover is one arrow key away for
 * everyone else, and never in the sentence slot itself.
 */
function DetailsButton({ detail }: { detail: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Details" className="shrink-0">
          <Info aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[28rem]">
        <span className="font-mono text-3xs wrap-anywhere">{detail}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function StripStatus({
  state,
  controller,
  bound,
  drawerShowing,
  selectCrumb,
  worktreePath,
}: {
  state: InspectorState;
  controller: InspectorController;
  bound: boolean;
  /** The drawer is open beside the page and already names the source. */
  drawerShowing: boolean;
  /** Select a component from the trail; absent while that can't be done. */
  selectCrumb: ((usedAt: SourcePoint, keepFocus?: boolean) => void) | undefined;
  worktreePath: string | null;
}) {
  const binding = state.binding;
  if (binding.status === "failed") return <WaitingRow label="Connecting to the page" />;
  if (!bound) return <WaitingRow label="Connecting to the page" />;

  const selection = state.selection;
  if (selection.status === "ready") {
    const picked = selection.selection;
    if (picked.observations.length > 0) {
      const { scopes, pickedIndex } = scopesFor(picked);
      const scope = pickedIndex > 0 ? scopes[pickedIndex] : undefined;
      // A component is located by the file it is written in, once that is
      // proven; never by the element it was reached through.
      const place = scope ? null : elementPlace(picked);
      const location =
        scope && scope.kind !== "element"
          ? scope.file === null
            ? null
            : { path: scope.file, line: null }
          : place
            ? { path: place.path, line: place.line }
            : null;
      return (
        <>
          {/* The same trail the drawer draws, from the same function. The strip
              has no header, so its trail ends at what is selected — the
              component when a component was picked, the element otherwise. */}
          <StripTrail
            selection={picked}
            onSelect={selectCrumb}
            currentBadge={pickedIndex > 0 ? "Component" : undefined}
          />
          {/* A selection that has to be made again says so here too, so a
              folded drawer never hides that the trail is out of date. */}
          {selection.stale && !selection.reproving ? (
            <span className="flex min-w-0 shrink items-center gap-1.5">
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              {/* A control that does nothing, so a cut sentence is a focus
                  away in the roving order as well as a hover away. */}
              <TruncatedTooltip content={STALE_COPY[selection.stale].title}>
                <button
                  type="button"
                  aria-disabled="true"
                  className="min-w-0 cursor-default truncate rounded-[var(--radius-sm)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                >
                  {STALE_COPY[selection.stale].title}
                </button>
              </TruncatedTooltip>
            </span>
          ) : null}
          {/* Escape clears it too, but only while the page has the keyboard —
              which it stops having the moment the request is being typed. */}
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={(event) => {
              // The button goes with the selection. Focus it held is handed to
              // the strip's first control, so the toolbar's keys keep working.
              const strip = event.currentTarget.closest<HTMLElement>('[role="toolbar"]');
              const focused = document.activeElement === event.currentTarget;
              void controller.clearSelection();
              if (focused) {
                requestAnimationFrame(() => strip?.querySelector<HTMLElement>("button")?.focus());
              }
            }}
          >
            Deselect
          </Button>
          <KeyHints
            canWiden={
              primaryObservation(picked)?.capabilities.componentSelection.state === "available"
            }
          />
          {location && !drawerShowing ? (
            <>
              <div aria-hidden="true" className="toolbar-divider mx-1 h-4 w-px shrink-0" />
              <StripLocation
                path={location.path}
                line={location.line}
                worktreePath={worktreePath}
              />
            </>
          ) : null}
        </>
      );
    }
  }
  if (selection.status === "resolving") return <WaitingRow label="Finding the source" />;
  if (selection.status === "settling") {
    return <WaitingRow label="Waiting for the preview to update" />;
  }
  const workspace = state.workspace;
  if (workspace.status === "opening" && workspace.appPath) {
    return <WaitingRow label={`Opening ${workspace.appPath}`} />;
  }
  return null;
}

/**
 * Where the selection is written, in the strip once the drawer that would say
 * it is folded away. A control rather than text: the strip is a roving toolbar,
 * so the full path reaches the keyboard on focus, and opening the file is the
 * thing a location is for. The path shortens by the same rule as the drawer's.
 */
function StripLocation({
  path,
  line,
  worktreePath,
}: {
  path: string;
  line: number | null;
  worktreePath: string | null;
}) {
  const absolute = path.startsWith("/")
    ? path
    : worktreePath
      ? `${worktreePath.replace(/\/+$/, "")}/${path}`
      : null;
  const full = `${path}${line === null ? "" : `:${line}`}`;
  if (absolute === null) {
    return <SourcePath file={path} line={line} className="min-w-0 max-w-[40%] shrink text-3xs" />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          // Capped, so a long path shortens itself rather than the trail: the
          // selection's name outranks where it is written.
          className="min-w-0 max-w-[40%] shrink px-1 font-normal"
          onClick={() =>
            void actionService.dispatch(
              "file.openInEditor",
              line === null ? { path: absolute } : { path: absolute, line },
              { source: "user" }
            )
          }
        >
          <SourcePath file={path} line={line} disclose={false} className="text-3xs" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        <span className="flex flex-col gap-0.5">
          <span>Open in editor</span>
          <span className="font-mono text-3xs wrap-anywhere">{full}</span>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The strip's trail ends at what is selected: the component when a component
 * was picked, the element otherwise. The strip has no header, so the selection
 * is its terminal crumb; every crumb above it selects that component.
 */
function StripTrail({
  selection,
  onSelect,
  currentBadge,
}: {
  selection: PickedSelection;
  onSelect: ((usedAt: SourcePoint, keepFocus?: boolean) => void) | undefined;
  currentBadge?: string;
}) {
  const { above, current, truncated } = trailFor(selection);
  return (
    <SelectionTrail
      crumbs={[...above, current]}
      currentIndex={above.length}
      currentLabel={current.label}
      truncated={truncated}
      density="strip"
      currentBadge={currentBadge}
      onSelect={
        onSelect
          ? (crumb, fromMenu) => {
              if (crumb.usedAt) onSelect(crumb.usedAt, fromMenu);
            }
          : undefined
      }
      className="min-w-0 flex-1"
    />
  );
}

/**
 * The drawer beside the page. Closed until there is something to show, so the
 * site keeps its full width while you browse and pick.
 */
export function ElementPickerDrawer(props: DevPreviewToolSurfaceProps<InspectorController>) {
  const { controller, state } = useInspectorSession(props);
  const memoryKey = composerMemoryKey(props.panelId, props.worktreeId);
  // A draft or an agent request outlives the selection it was about; keep
  // both reachable.
  const composer = useComposerMemory(memoryKey);
  const collapsed = useDrawerCollapsed(props.panelId);
  const drawerRef = useRef<HTMLElement | null>(null);
  const open = drawerHasDetails(
    state,
    composer.deliveries.length > 0 || composer.draft.trim() !== ""
  );
  if (!controller) return null;
  const selection = state.selection;
  if (!open || collapsed) return null;

  return (
    <aside
      ref={drawerRef}
      aria-label="Element Picker details"
      // Width, resizing, the narrow-pane policy and the `@container/drawer` the
      // rows below answer to all belong to the host's drawer chrome
      // (`src/components/DevPreview/DevPreviewToolDrawerChrome.tsx`); this fills
      // whatever it is given. Rendering nothing is still how the drawer stays
      // shut — the chrome hides itself when there is nothing inside it.
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* Pinned. A desktop inspector always says what is selected; a form
          scrolls it away. */}
      <SelectionHeader
        state={state}
        controller={controller}
        worktreePath={props.worktreePath}
        drawerRef={drawerRef}
      />

      {/* One inset in every state. The two used to differ because a disclosure
          header carried its own padding under the rule; with the composer
          starting directly there, a 4px gap read as the panel touching its own
          divider. */}
      <ScrollShadow className="min-h-0 flex-1" scrollClassName="flex flex-col gap-3 p-3">
        {state.issue ? (
          <InspectorNotice
            tone={state.issue.severity}
            title={state.issue.message}
            role={state.issue.severity === "error" ? "alert" : "status"}
            // Closing is the corner control, the way every other notice here
            // closes. The action slot is for the one way forward, and an error
            // always has one: replay the mode change, or rebuild the session
            // carrying the inspector. A warning names a limitation nothing here
            // can lift, so acknowledging it is the whole interaction.
            onDismiss={() => controller.dismissIssue()}
            action={
              state.issue.recovery ? (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void controller.recoverFromIssue()}
                >
                  {state.issue.recovery.kind === "set-mode" ? "Retry" : "Reconnect"}
                </Button>
              ) : undefined
            }
          >
            {/* The verdict's meaning in our words; the page's own words only
                where they are a diagnostic, set as one. */}
            {state.issue.body || issueDiagnostic(state.issue) ? (
              <>
                {state.issue.body ? <span className="block">{state.issue.body}</span> : null}
                {issueDiagnostic(state.issue) ? (
                  <Diagnostic text={issueDiagnostic(state.issue)!} />
                ) : null}
              </>
            ) : null}
          </InspectorNotice>
        ) : null}
        <WorkspaceStatus state={state} controller={controller} worktreePath={props.worktreePath} />
        {selection.status === "ready" ? null : (
          <SelectionBody state={state} controller={controller} />
        )}

        {/* The panel's one route, and therefore not a section of it. There is no
          header, no glyph and no disclosure: the picker exists to hand a
          selection to an agent, so the composer is what the drawer *is* below
          its identity. A header would have named the obvious and spent 32px of
          a 360px panel doing it; a disclosure would have let the user fold away
          the only thing here. `aria-label` on the composer keeps the grouping
          for assistive technology without drawing one. */}
        {/* Choosing an app is for tracing source, never a toll on sending what
          the page shows: a selection with nothing resolved is still sendable. */}
        {selection.status === "ready" ||
        composer.draft.trim() !== "" ||
        composer.deliveries.length > 0 ? (
          <AgentComposer
            memoryKey={memoryKey}
            controller={controller}
            selection={selection}
            worktreeId={props.worktreeId}
            worktreePath={props.worktreePath}
          />
        ) : null}
      </ScrollShadow>
    </aside>
  );
}

function workspaceNeedsAttention(state: InspectorState): boolean {
  const workspace = state.workspace;
  // Several apps keep the drawer open for the switcher: choosing the wrong one
  // must stay fixable before anything is selected, and after a switch clears it.
  //
  // A ready workspace's only other subject is the toolchain verdict, and a
  // diagnostic nobody has to act on does not earn opening the drawer: it waits
  // in Site source for something else to open it.
  if (workspace.status === "ready") return workspace.appPaths.length > 1;
  // A choice being opened keeps the list it was made from on screen; the
  // drawer blinking shut under the user's focus is what it must not do.
  if (workspace.status === "opening") return workspace.appPath !== undefined;
  return (
    workspace.status === "ambiguous" ||
    workspace.status === "failed" ||
    workspace.status === "no-worktree"
  );
}

/** The page's own words behind a verdict, when they are a diagnostic rather than a restatement. */
function issueDiagnostic(issue: NonNullable<InspectorState["issue"]>): string | null {
  return issue.detail && issueDetailIsDiagnostic(issue.code) ? issue.detail : null;
}

/** A diagnostic under a sentence: its own face, wrapped only where it has to be. */
function Diagnostic({ text }: { text: string }) {
  return <span className="mt-1 block font-mono text-3xs wrap-anywhere">{text}</span>;
}

/** What the toolchain verdict says, when the app's layout has been read and it found something untested. */
function untestedReasons(state: InspectorState): readonly string[] | null {
  const project = state.project;
  if (project?.status !== "described") return null;
  const toolchain = project.context.toolchain;
  return toolchain.verdict === "untested" && toolchain.reasons.length > 0
    ? toolchain.reasons
    : null;
}

function WorkspaceStatus({
  state,
  controller,
  worktreePath,
}: {
  state: InspectorState;
  controller: InspectorController;
  worktreePath: string | null;
}) {
  const workspace = state.workspace;
  const sectionRef = useRef<HTMLElement | null>(null);
  // A choice made from inside the section hands focus on to what replaces the
  // list once the app is open, rather than dropping it on the document.
  const focusAfterOpen = useRef(false);
  const status = workspace.status;
  useEffect(() => {
    if (status === "opening" || !focusAfterOpen.current) return;
    focusAfterOpen.current = false;
    const active = document.activeElement;
    const section = sectionRef.current;
    if (!section || (active !== document.body && !section.contains(active))) return;
    section.querySelector<HTMLElement>('button:not([disabled]), [role="combobox"]')?.focus();
  }, [status]);
  if (workspace.status === "idle") return null;
  if (workspace.status === "opening" && workspace.appPath === undefined) return null;
  if (workspace.status === "ready" && !readyHasSomethingToSay(state)) return null;
  // One surface for everything about the project rather than the element, so
  // a setup problem and an element-level limitation never look like the same
  // kind of notice sat in the same column.
  return (
    <section ref={sectionRef} aria-label="Site source" className="flex flex-col gap-1">
      <SectionHeader title="Site source" icon={FolderCode} />
      <SiteSourceBody
        state={state}
        controller={controller}
        worktreePath={worktreePath}
        onChoose={(appPath) => {
          focusAfterOpen.current = true;
          void controller.openWorkspace(appPath);
        }}
        onSwitch={(appPath) => {
          focusAfterOpen.current = true;
          controller.switchApp(appPath);
        }}
      />
    </section>
  );
}

function SiteSourceBody({
  state,
  controller,
  worktreePath,
  onChoose,
  onSwitch,
}: {
  state: InspectorState;
  controller: InspectorController;
  worktreePath: string | null;
  onChoose: (appPath: string) => void;
  onSwitch: (appPath: string) => void;
}) {
  const workspace = state.workspace;
  switch (workspace.status) {
    case "idle":
      return null;
    case "no-worktree":
      return (
        <InspectorNotice tone="info" title="Preview only — no worktree" density="compact">
          A request still carries what the page reports, but no file is checked against source.
        </InspectorNotice>
      );
    case "opening":
    case "ambiguous": {
      const appPaths = workspace.appPaths ?? [];
      const opening = workspace.status === "opening" ? workspace.appPath : undefined;
      const serverCwd = workspace.serverCwd ?? null;
      const scanComplete = workspace.status === "ambiguous" ? workspace.scanComplete : true;
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-text-secondary">
            More than one app lives in this worktree. Choose the one this preview is showing.
          </p>
          {/* What the preview is, beside what it could be: the address it
              shows and the folder its server runs from, so the choice is a
              match rather than a memory test. */}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-2xs">
            <dt className="text-text-secondary">Preview</dt>
            <dd className="min-w-0 truncate font-mono text-text-primary">
              {previewAddress(state)}
            </dd>
            <dt className="text-text-secondary">Server runs in</dt>
            <dd className="min-w-0 truncate font-mono text-text-primary">
              {serverCwd === null ? (
                <span className="font-sans text-text-secondary">Not reported</span>
              ) : (
                serverFolder(worktreePath, serverCwd)
              )}
            </dd>
          </dl>
          {/* 28px path rows with a chevron: a choice list, not three bordered
              boxes that read as empty inputs. Every path in the same face. */}
          <ul
            // Bled to the rows' own padding so their text lines up with the
            // sentence above; the dividers run the row's full width.
            className="-mx-2 flex flex-col divide-y divide-border-subtle"
            aria-label="Choose site source"
            aria-busy={opening !== undefined || undefined}
          >
            {appPaths.map((appPath) => {
              const busy = appPath === opening;
              return (
                <li key={appPath}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "h-7 w-full justify-between gap-2 px-2 font-normal",
                          busy && "bg-overlay-subtle text-text-primary"
                        )}
                        // Kept mounted and focusable while the choice opens:
                        // a disabled button drops the focus it holds.
                        aria-disabled={opening !== undefined || undefined}
                        aria-busy={busy || undefined}
                        onClick={() => {
                          if (opening === undefined) onChoose(appPath);
                        }}
                      >
                        <AppPath appPath={appPath} />
                        {busy ? (
                          <Spinner size="xs" />
                        ) : (
                          <ChevronRight
                            className="h-3.5 w-3.5 shrink-0 text-text-secondary"
                            aria-hidden="true"
                          />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start">
                      {absoluteIn(worktreePath, appPath)}
                    </TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          {scanComplete ? null : (
            <p className="flex items-start gap-1.5 text-2xs text-text-secondary">
              <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
              The search stopped early, so this list may be incomplete.
            </p>
          )}
        </div>
      );
    }
    case "failed":
      return <SiteSourceFailure workspace={workspace} controller={controller} />;
    case "ready": {
      if (!readyHasSomethingToSay(state)) return null;
      const untested = untestedReasons(state);
      return (
        <div className="flex flex-col gap-1">
          {untested ? (
            // What the bundled compiler was tested against, said once and left
            // alone: an observation, so `info` and no action. It does not open
            // the drawer by itself — nothing about the app is worse for it, and
            // the picker offers exactly what it offers either way.
            <InspectorNotice tone="info" title={UNTESTED_TOOLCHAIN_TITLE} density="compact">
              {untestedToolchainDetail(untested)}
            </InspectorNotice>
          ) : null}
          {/* Choosing the wrong app has to be recoverable from where the
              choice shows, not by closing the picker to be asked again. */}
          {workspace.appPaths.length > 1 ? (
            <PropertyRow label="App">
              <Select value={workspace.appPath} onValueChange={onSwitch}>
                <SelectTrigger
                  aria-label="Site source app"
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                >
                  <SelectValue>
                    <AppPath appPath={workspace.appPath} />
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="w-[var(--radix-select-trigger-width)]">
                  {workspace.appPaths.map((appPath) => {
                    return (
                      <SelectItem
                        key={appPath}
                        value={appPath}
                        title={absoluteIn(worktreePath, appPath)}
                        className="font-mono"
                      >
                        <AppPath appPath={appPath} />
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {/* Said before it happens: the selection was proven against
                  this app's source and goes with it. */}
              {state.selection.status === "ready" && state.selection.selection.workspaceId ? (
                <p className="text-2xs text-text-secondary">
                  Switching apps clears the current selection.
                </p>
              ) : null}
            </PropertyRow>
          ) : null}
        </div>
      );
    }
  }
}

/**
 * Why the source couldn't be opened, with the way forward that can work: a read
 * error is retried, a remembered app that has gone is chosen again, and a
 * server running from another checkout is named — retrying can't move it.
 */
function SiteSourceFailure({
  workspace,
  controller,
}: {
  workspace: Extract<InspectorState["workspace"], { status: "failed" }>;
  controller: InspectorController;
}) {
  const copy = WORKSPACE_FAILURE_COPY[workspace.reason];
  switch (workspace.reason) {
    case "read-error":
      return (
        <InspectorNotice
          tone="error"
          role="alert"
          title={copy.title}
          density="compact"
          action={
            <Button variant="secondary" size="xs" onClick={() => void controller.openWorkspace()}>
              Retry
            </Button>
          }
        >
          {/* The diagnostic — EACCES, ENOENT — is the one thing the user can
              act on, in its own face so it reads as one. */}
          <Diagnostic text={workspace.message} />
        </InspectorNotice>
      );
    case "invalid-app":
      return (
        <InspectorNotice
          tone="warning"
          role="status"
          title={copy.title}
          density="compact"
          action={
            <Button variant="secondary" size="xs" onClick={() => controller.chooseAnotherApp()}>
              Choose another app
            </Button>
          }
        >
          {workspace.message ? (
            <>
              Previous choice: <span className="font-mono">{workspace.message}</span>
            </>
          ) : null}
        </InspectorNotice>
      );
    case "unknown-worktree":
      return (
        <InspectorNotice
          tone="error"
          role="alert"
          title={copy.title}
          density="compact"
          action={
            <Button variant="secondary" size="xs" onClick={() => void controller.openWorkspace()}>
              Retry
            </Button>
          }
        >
          The preview belongs to a worktree the project doesn&apos;t have open.
        </InspectorNotice>
      );
    case "other-worktree":
      return (
        <InspectorNotice tone="warning" role="status" title={copy.title} density="compact">
          Restart it from this worktree to trace elements to source. It&apos;s running in
          <Diagnostic text={workspace.message} />
        </InspectorNotice>
      );
  }
}

/**
 * An app's folder, shortened the way the picker shortens any path: the parent
 * folders yield first and the app's own name last, so `marketing-site-v2` and
 * `marketing-site-v3` stay told apart in a 280px drawer.
 */
function AppPath({ appPath }: { appPath: string }) {
  if (appPath === ".") return <span className="font-mono text-xs">./</span>;
  return <SourcePath file={appPath} line={null} disclose={false} className="text-xs" />;
}

/** The address the preview shows, as a reader matches it against an app. */
function previewAddress(state: InspectorState): string {
  const url = state.page?.url ?? (state.binding.status === "bound" ? state.binding.url : null);
  if (!url) return "Not loaded yet";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The dev server's folder, relative to the worktree it should be in. */
function serverFolder(worktreePath: string | null, serverCwd: string): string {
  const relative = relativeTo(worktreePath, serverCwd);
  return relative === "." ? "./ (worktree root)" : relative;
}

/** A ready workspace shows the section for the app switcher, or for the verdict. */
function readyHasSomethingToSay(state: InspectorState): boolean {
  const workspace = state.workspace;
  if (workspace.status !== "ready") return false;
  return workspace.appPaths.length > 1 || untestedReasons(state) !== null;
}

/** An app's directory as the user's machine spells it, for the tooltip that discloses it. */
function absoluteIn(worktreePath: string | null, appPath: string): string {
  if (!worktreePath) return appPath;
  const root = worktreePath.replace(/\/+$/, "");
  return appPath === "." ? root : `${root}/${appPath}`;
}

/**
 * How long the resolving skeleton is on screen for, as one answer.
 *
 * The onset gate suppresses a skeleton for a resolve that beats 400ms and the
 * floor holds one that appeared for its minimum dwell — but the two run on
 * their own clocks, and a second pick landing inside the first one's dwell
 * restarts the gate while the floor is still expiring. That leaves the slot
 * blank between two skeletons. `held` spans a run of resolves so the wait the
 * user sees is one wait, however many picks it took.
 */
function useResolvingSkeleton(resolving: boolean): boolean {
  const gate = useDohertyGate(resolving);
  const floored = useSkeletonFloor(gate);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (gate) {
      setHeld(true);
      return;
    }
    // Not `!resolving` alone: the gap between one answer and the next pick is
    // exactly where the run would be cut in two.
    if (!resolving && !floored) setHeld(false);
  }, [gate, resolving, floored]);
  // `gate ||`, not the floor alone: the floor only learns its input in an
  // effect, so on the commit the gate opens it still reads false. An answer
  // landing in that same commit would put the identity up, spend a crumb's
  // focus intent on it, and have it replaced by a skeleton one commit later —
  // the flash the floor exists to prevent, arriving backwards.
  return gate || floored || (held && resolving);
}

/**
 * The drawer's pinned header: what is selected, or the shape of it while the
 * source is being found.
 *
 * Its own component because the contract it answers to is measured in time on
 * screen. Mounted with the open drawer, so folding the drawer away ends the
 * wait rather than leaving a gate and a floor running against a skeleton
 * nobody can see — and reopening starts a fresh one.
 */
function SelectionHeader({
  state,
  controller,
  worktreePath,
  drawerRef,
}: {
  state: InspectorState;
  controller: InspectorController;
  worktreePath: string | null;
  drawerRef: RefObject<HTMLElement | null>;
}) {
  const selection = state.selection;
  const resolving = selection.status === "resolving";
  const skeleton = useResolvingSkeleton(resolving);
  const selectCrumb = useSelectCrumb(
    controller,
    state,
    drawerRef,
    drawerLanding,
    // The identity block is behind the skeleton until the floor releases, and
    // it is where a crumb's focus lands.
    !skeleton
  );
  // The held skeleton outranks a ready identity: releasing it the frame the
  // answer lands is the tear-down the floor exists to stop.
  if (skeleton || resolving) return <ResolvingHeader skeleton={skeleton} resolving={resolving} />;
  if (selection.status !== "ready") return null;
  return (
    <div className="shrink-0 border-b border-border-subtle px-3 pb-2 pt-3">
      <SelectionIdentity
        selection={selection}
        worktreePath={worktreePath}
        onSelectComponent={selectCrumb}
        pageVerdict={state.issue?.code}
        noWorktree={state.workspace.status === "no-worktree"}
        onChooseApp={
          state.workspace.status === "ambiguous"
            ? () =>
                drawerRef.current
                  ?.querySelector<HTMLElement>('[aria-label="Choose site source"] button')
                  ?.focus()
            : undefined
        }
      />
    </div>
  );
}

/**
 * The identity's own geometry, in the identity's own slot, while main finds
 * the source. Before the gate nothing; past it the skeleton of the block that
 * is coming, so a slow resolve settles into the panel it was always going to
 * become rather than swapping a status line for it. The row heights match
 * `SelectionIdentity` exactly (28/24/20), which is what keeps the sections
 * below from moving when the answer lands.
 *
 * Presentational: `ElementPickerDrawer` owns the gate and the display floor,
 * because this unmounts the moment the source lands and a floor kept here
 * would never get to hold anything.
 */
function ResolvingHeader({ skeleton, resolving }: { skeleton: boolean; resolving: boolean }) {
  // The live status, not `true`: the floor can keep this mounted across a run
  // of quick picks, and a timer started at mount would eventually call a
  // selection that has only just begun "still working".
  const slow = useDeferredLoading(resolving, UI_STILL_WORKING_MS);
  return (
    <div className="shrink-0 border-b border-border-subtle px-3 pb-2 pt-3" aria-busy="true">
      {skeleton ? (
        <IdentitySkeleton label={slow ? "Finding the source — still working…" : undefined} />
      ) : (
        <div className="h-20" aria-hidden="true" />
      )}
    </div>
  );
}

function SelectionBody({
  state,
  controller,
}: {
  state: InspectorState;
  controller: InspectorController;
}) {
  const selection = state.selection;
  switch (selection.status) {
    case "none":
      return null;
    case "resolving":
      // The pinned header holds the skeleton; the body has nothing to add.
      return null;
    case "settling":
      // The click is kept and asked for again once the page has caught up;
      // only when that fails is it the user's to repeat.
      if (selection.retrying) return <WaitingRow label="Waiting for the preview to update" />;
      return (
        <InspectorNotice
          tone="warning"
          title={SELECTION_OUTCOME_COPY.settled.title}
          role="status"
          density="compact"
        >
          {SELECTION_OUTCOME_COPY.settled.detail}
        </InspectorNotice>
      );
    case "lost":
      return (
        <InspectorNotice
          tone="warning"
          title={SELECTION_OUTCOME_COPY.lost.title}
          role="status"
          density="compact"
        >
          {SELECTION_OUTCOME_COPY.lost.detail}
        </InspectorNotice>
      );
    case "failed":
      switch (selection.reason) {
        case "loading":
          // Routine timing, not a failure: a warning that says what to do.
          return (
            <InspectorNotice
              tone="warning"
              title={SELECTION_OUTCOME_COPY.loading.title}
              role="status"
              density="compact"
            />
          );
        case "mismatch":
          return (
            <InspectorNotice
              tone="warning"
              title={SELECTION_OUTCOME_COPY.mismatch.title}
              role="status"
              density="compact"
              action={
                state.mode === "select" ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => void controller.setMode("browse")}
                  >
                    Switch to Browse
                  </Button>
                ) : undefined
              }
            >
              <span className="block">{selection.message}</span>
              <span className="mt-1 block">{SELECTION_OUTCOME_COPY.mismatch.detail}</span>
            </InspectorNotice>
          );
        case "host":
          return (
            <InspectorNotice
              tone="error"
              title={SELECTION_OUTCOME_COPY.host.title}
              role="alert"
              density="compact"
            >
              <span className="block">{SELECTION_OUTCOME_COPY.host.detail}</span>
              <Diagnostic text={selection.message} />
            </InspectorNotice>
          );
      }
      return null;
    case "ready":
      return <SelectionIdentity selection={selection} worktreePath={null} />;
  }
}
