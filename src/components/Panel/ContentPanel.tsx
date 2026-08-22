import React, {
  useCallback,
  useRef,
  forwardRef,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";
import { useIsDragging } from "@/components/DragDrop";
import { TitleEditingProvider, useTitleEditing } from "./TitleEditingContext";
import { TerminalHeaderContent } from "@/components/Terminal/TerminalHeaderContent";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import type { PanelKind, AgentState, PersistableFlowStatus } from "@/types";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";
import type { ActivityState } from "@/components/Terminal/TerminalPane";
import type { TabInfo } from "./TabButton";
import { useDockBlockedState } from "@/components/Layout/useDockBlockedState";
import { usePreferencesStore, usePanelStore } from "@/store";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useMacroFocusStore } from "@/store/macroFocusStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { usePanelRootFocus } from "./usePanelRootFocus";
import { useWorktreeColorMap } from "@/hooks/useWorktreeColorMap";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { isPtyPanel } from "@shared/types/panel";

/**
 * Base props for all panel types.
 * Panels include terminals, agent terminals, browser panels, and extension-provided panels.
 */
export interface BasePanelProps {
  id: string;
  title: string;
  worktreeId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  /**
   * Which presentation is rendering this panel. `"dialog"` means it is hosted
   * inside a modal by `PanelDialogHost`, which supplies the surrounding chrome
   * and its own header — so this panel draws neither.
   */
  location?: "grid" | "dock" | "dialog";
  isMultiPanelGrid?: boolean;
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  showRestoreControl?: boolean;
}

export interface ContentPanelProps extends BasePanelProps {
  kind: PanelKind;
  children: ReactNode;

  // Slots
  headerContent?: ReactNode;
  headerContentPlacement?: "leading" | "trailing";
  headerActions?: ReactNode;
  toolbar?: ReactNode;

  // Container customization
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  tabIndex?: number;
  role?: string;
  "aria-label"?: string;
  "aria-selected"?: boolean;

  // Terminal-specific header props (optional, only used for terminal/agent panels)
  agentId?: string;
  /** Runtime-detected agent identity (cleared on agent exit). Drives panel chrome. */
  detectedAgentId?: string;
  /** Canonical live runtime identity for terminal chrome. */
  runtimeIdentity?: TerminalRuntimeIdentity;
  /** Single descriptor consumed by all terminal chrome renderers. */
  chrome?: TerminalChromeDescriptor;
  /** Sticky: has an agent ever been live-detected. Not used for chrome. */
  everDetectedAgent?: boolean;
  detectedProcessId?: string;
  presetColor?: string;
  agentLaunchFlags?: string[];
  isExited?: boolean;
  exitCode?: number | null;
  isWorking?: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  activityStatus?: "working" | "waiting" | "success" | "failure";
  lastCommand?: string;
  queueCount?: number;
  flowStatus?: PersistableFlowStatus;
  /** Submit-lane state, forwarded to the auto-constructed TerminalHeaderContent (#11875). */
  submitStatus?: "slow" | "stalled" | "failed";
  /**
   * True when the agent transitioned to `completed` and the worktree's
   * changed-file count is zero. Drives the "Finished, no changes" pill
   * in the auto-constructed TerminalHeaderContent.
   */
  completedWithNoChanges?: boolean;
  onRestart?: () => void;
  isPinged?: boolean;
  wasJustSelected?: boolean;
  // Group-level ambient state: highest-urgency agent state across all tabs in a tab group.
  // When set, this overrides agentState for container border styling so hidden tabs
  // surface their state on the group container without changing the header chip.
  ambientAgentState?: AgentState;

  // Multi-select indicator. When the pane is part of an armed set of 2+
  // terminals, the title bar lifts. The outer container border stays as-is —
  // no extra outline. Focus styling differentiates "the pane I'm typing in"
  // from the other selected panes.
  isSelected?: boolean;

  // Receiver indicator for live broadcast. True when this pane is armed,
  // not the focused pane, and the fleet has 2+ members — i.e. keystrokes
  // typed elsewhere will fan out here. Renders an amber left stripe on the
  // title bar so the user can verify "yes, this pane will mirror" without
  // looking up at the fleet ribbon.
  isFleetFollower?: boolean;

  // True when this pane's PTY is hibernated — the renderer is released but
  // the process is preserved. Drives the panel-state-hibernated border cue
  // and the Moon icon in the header.
  isHibernated?: boolean;

  // True when voice dictation is in its pre-audio arming window targeting
  // this pane. Drives the panel-state-arming border cue (single load-bearing
  // signal during the ~200ms before the mic opens and recording chrome takes
  // over). Outranks waiting/working/hibernated because it is user-initiated
  // and time-bounded.
  isVoiceArming?: boolean;

  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

interface GridChromeInputs {
  /** Multi-pane grid gate — every ambient state below needs a sibling to contrast against. */
  showGridAttention: boolean;
  /** Lone-pane focus cue (#11837): single pane, Assistant open, pane focused or armed. */
  showLonePaneFocusCue: boolean;
  showSelectedChrome: boolean;
  showGridAgentHighlights: boolean;
  isVoiceArming: boolean;
  isWaiting: boolean;
  isWorkingState: boolean;
  isHibernated: boolean;
}

/**
 * Resolves the grid pane's container chrome to exactly one class.
 *
 * Ordered highest-priority first; the multi-pane branches are the historical
 * ternary chain unchanged. `showLonePaneFocusCue` sits last because every
 * branch above it is gated on `showGridAttention`, which a single-pane grid
 * never satisfies — so the two groups are mutually exclusive in practice and
 * a lone pane only ever picks between the quiet cue and the bare fallback.
 */
function resolveGridPanelChromeClass({
  showGridAttention,
  showLonePaneFocusCue,
  showSelectedChrome,
  showGridAgentHighlights,
  isVoiceArming,
  isWaiting,
  isWorkingState,
  isHibernated,
}: GridChromeInputs): string {
  if (showGridAttention && isVoiceArming) return "panel-state-arming";
  if (showGridAttention && showSelectedChrome) return "terminal-selected";
  if (showGridAttention && showGridAgentHighlights && isWaiting) return "panel-state-waiting";
  if (showGridAttention && showGridAgentHighlights && isWorkingState) return "panel-state-working";
  if (showGridAttention && isHibernated) return "panel-state-hibernated";
  if (showLonePaneFocusCue) return "terminal-selected-quiet";
  return "border-overlay hover:border-tint/[0.08]";
}

const ContentPanelInner = forwardRef<HTMLDivElement, ContentPanelProps>(function ContentPanelInner(
  {
    id,
    title,
    kind,
    isFocused,
    isMaximized = false,
    location = "grid",
    isMultiPanelGrid = true,
    worktreeId,
    onFocus,
    onClose,
    onToggleMaximize,
    onTitleChange,
    onMinimize,
    onRestore,
    showRestoreControl,
    children,
    headerContent,
    headerContentPlacement,
    headerActions,
    toolbar,
    className,
    onClick,
    onKeyDown,
    tabIndex,
    role,
    "aria-label": ariaLabel,
    "aria-selected": ariaSelected,
    agentId,
    detectedAgentId,
    runtimeIdentity,
    chrome,
    everDetectedAgent,
    detectedProcessId,
    presetColor,
    agentLaunchFlags,
    isExited = false,
    exitCode = null,
    isWorking: _isWorking = false,
    agentState,
    activity,
    activityStatus,
    lastCommand,
    queueCount = 0,
    flowStatus,
    submitStatus,
    completedWithNoChanges = false,
    onRestart,
    isPinged,
    wasJustSelected,
    ambientAgentState,
    isSelected = false,
    isFleetFollower = false,
    isHibernated = false,
    isVoiceArming = false,
    tabs,
    groupId,
    onTabClick,
    onTabClose,
    onTabRename,
    onAddTab,
    onTabReorder,
  },
  ref
) {
  const isDragging = useIsDragging();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Compose, never replace: TerminalPane forwards its own ref here and observes
  // the same node for resize/visibility. A callback ref may return a React 19
  // cleanup, and React then skips the usual `null` call — so that cleanup has to
  // be propagated or the caller's teardown never runs.
  const externalRef: React.Ref<HTMLDivElement> = ref;
  const setRootRef = useCallback<React.RefCallback<HTMLDivElement>>(
    (node) => {
      rootRef.current = node;
      if (typeof externalRef === "function") {
        const cleanup = externalRef(node);
        if (typeof cleanup === "function") {
          return () => {
            rootRef.current = null;
            cleanup();
          };
        }
        return undefined;
      }
      if (externalRef) {
        externalRef.current = node;
      }
      return undefined;
    },
    [externalRef]
  );
  const getRootNode = useCallback(() => rootRef.current, []);
  const titleEditing = useTitleEditing();
  const editingStartedAt = titleEditing.editingStartedAt;

  // Hover/focus preview from the fleet selection menu — true when the user
  // is previewing a state-preset menu item that *would* arm this pane. The
  // pane's title bar lifts to a neutral surface tint (not accent) so the
  // preview is unmistakable but doesn't squat on the focus anchor color.
  const isFleetPreviewed = useFleetArmingStore((s) => s.previewArmedIds.has(id));

  // Inverse of isFleetPreviewed: when a preset hover is *active* and this
  // pane is NOT in the would-be-armed set, dim it so the matched panes
  // stand out without competing visual chrome on the rest of the grid.
  // Gated on PTY-backed kinds so browser, dev-preview, and other non-fleet
  // panels (which are never in previewArmedIds) stay at full opacity —
  // dimming them would imply they could have been armed.
  const isPtyKind = panelKindHasPty(kind);
  const isFleetDimmed = useFleetArmingStore(
    (s) => isPtyKind && s.previewArmedIds.size > 0 && !s.previewArmedIds.has(id)
  );

  // The panel root is the focus target for every non-PTY kind — it takes DOM
  // focus when the panel becomes focused, and yields to whatever child input
  // the panel owns (FilePane's search box, a plugin's fields). PTY kinds are
  // skipped: TerminalPane owns their registry entry and routes focus to xterm
  // or the hybrid input bar, and two owners would race for one panel id.
  usePanelRootFocus({ id, isFocused, getNode: getRootNode, enabled: !isPtyKind });

  // One-shot ring pulse when this pane becomes the new primary on fleet
  // exit. Listens for the CustomEvent dispatched from FleetArmingRibbon's
  // exitFleet — keeps the cosmetic event out of any persistent store.
  const [showExitPulse, setShowExitPulse] = useState(false);
  useEffect(() => {
    let pulseTimer: number | null = null;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ panelId?: string }>).detail;
      if (!detail || detail.panelId !== id) return;
      setShowExitPulse(true);
      if (pulseTimer !== null) window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => {
        setShowExitPulse(false);
        pulseTimer = null;
      }, 240);
    };
    window.addEventListener("daintree:fleet-exit-pulse", handler);
    return () => {
      window.removeEventListener("daintree:fleet-exit-pulse", handler);
      if (pulseTimer !== null) window.clearTimeout(pulseTimer);
    };
  }, [id]);

  // Focus and select input when editing starts (handles context menu rename).
  // The delay must outlast Radix's `onCloseAutoFocus` window — otherwise the
  // dropdown/context-menu's focus restoration steals focus from the input
  // immediately after we grab it, the input fires `onBlur`, and editing ends
  // before the user sees it. 200ms covers Tier 2-fast palette/menu exit.
  useEffect(() => {
    if (titleEditing.isEditingTitle && titleInputRef.current) {
      const timer = setTimeout(() => titleInputRef.current?.select(), 200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [titleEditing.isEditingTitle]);

  const showGridAttention = location === "grid" && !isMaximized && isMultiPanelGrid;
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);
  // When the Daintree Assistant region owns focus, suppress the grid panel's
  // `terminal-selected` accent so the visual "active surface" follows where
  // keystrokes are actually going. `focusedId` stays pinned (incumbent guard
  // — see #6959 in panelStore.assistantFocusGuard.test.ts), so spatial
  // navigation and action-target resolution are unaffected; only the chrome
  // releases. Ambient agent-state borders (`panel-state-*`) still render.
  const isAssistantActive = useMacroFocusStore((s) => s.focusedRegion === "assistant");
  const showSelectedChrome = (isFocused || isSelected) && !isAssistantActive;
  // #11837: a lone grid pane has no sibling to contrast against, so it skips
  // `showGridAttention` entirely and renders bare in every state — including
  // while the Assistant holds the keystrokes. That leaves the two states
  // indistinguishable exactly when telling them apart matters. Light the pane
  // with the fill-free `terminal-selected-quiet` perimeter when it owns focus
  // AND the Assistant is on screen to compete for it. Gating on visibility (a
  // separate selector so the boolean stays primitive) keeps the bare lone pane
  // the default whenever the Assistant is closed, which is the outcome #7544's
  // fix lost by dropping the guard outright.
  const isAssistantVisible = useMacroFocusStore((s) => s.visibility.assistant);
  const showLonePaneFocusCue =
    location === "grid" &&
    !isMaximized &&
    !isMultiPanelGrid &&
    isAssistantVisible &&
    showSelectedChrome;
  // Voice-dictation lock indicator: persistent amber border on the pinned
  // target. Selector returns a boolean for stable equality across unrelated
  // store updates (transcript deltas, audio levels). Renders independently of
  // panel-state-* so a locked working/waiting panel shows both signals.
  const isVoiceDictationLocked = useVoiceRecordingStore((s) => s.lockedTarget?.panelId === id);

  // Per-worktree color identity
  const worktreeColorMap = useWorktreeColorMap();
  const worktreeAccentColor = worktreeId ? worktreeColorMap?.[worktreeId] : undefined;
  const worktreeBranch = useWorktreeStore(
    useCallback(
      (state) => {
        if (!worktreeId || !worktreeAccentColor) return undefined;
        return state.worktrees.get(worktreeId)?.branch;
      },
      [worktreeId, worktreeAccentColor]
    )
  );

  const terminalChrome = useMemo(
    () =>
      chrome ??
      deriveTerminalChrome({
        kind,
        launchAgentId: agentId,
        runtimeIdentity,
        detectedAgentId,
        detectedProcessId,
        agentState,
        runtimeStatus: isExited ? "exited" : undefined,
        exitCode,
        presetColor,
      }),
    [
      chrome,
      kind,
      agentId,
      runtimeIdentity,
      detectedAgentId,
      detectedProcessId,
      agentState,
      isExited,
      exitCode,
      presetColor,
    ]
  );
  const ownAgentState = agentState;
  const headerAgentState = getTerminalAgentDisplayState(terminalChrome, ownAgentState);
  // Determine effective agent state for container border styling.
  // ambientAgentState takes priority so tab groups can surface highest-urgency
  // state from hidden live-agent tabs without affecting the active header chip.
  const effectiveAgentState = ambientAgentState ?? ownAgentState;
  const blockedState = useDockBlockedState(effectiveAgentState);
  const isWorkingState = effectiveAgentState === "working";

  // Auto-construct TerminalHeaderContent for PTY-backed terminals if headerContent not provided
  const resolvedHeaderContent = useMemo(() => {
    if (headerContent !== undefined) return headerContent;
    if (kind === "terminal") {
      return (
        <TerminalHeaderContent
          id={id}
          kind={kind}
          agentState={headerAgentState}
          activity={activity}
          activityStatus={activityStatus}
          lastCommand={lastCommand}
          isExited={isExited}
          exitCode={exitCode}
          queueCount={queueCount}
          flowStatus={flowStatus}
          submitStatus={submitStatus}
          completedWithNoChanges={completedWithNoChanges}
          isHibernated={isHibernated}
        />
      );
    }
    return null;
  }, [
    headerContent,
    kind,
    id,
    headerAgentState,
    activity,
    activityStatus,
    lastCommand,
    isExited,
    exitCode,
    queueCount,
    flowStatus,
    submitStatus,
    completedWithNoChanges,
    isHibernated,
  ]);

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onTitleChange) return;
      titleEditing.startEditing();
      requestAnimationFrame(() => titleInputRef.current?.select());
    },
    [onTitleChange, titleEditing]
  );

  const commitTitle = useCallback(
    (opts?: { allowReset?: boolean }) => {
      titleEditing.stopEditing();
      const trimmed = titleEditing.editingValue.trim();
      // Unchanged submit (incl. whitespace-only edits) is a no-op so an
      // accidental Enter can't lock a stale composed title.
      if (trimmed === title.trim()) return;
      // Empty commit is an explicit reset to the identity-derived default —
      // but only on Enter (allowReset); blur-empty cancels (ambiguous intent).
      if (!trimmed && !opts?.allowReset) return;
      onTitleChange?.(trimmed);
    },
    [titleEditing, title, onTitleChange]
  );

  const handleTitleSave = useCallback(() => {
    // Ignore spurious blurs that happen while overlay-restoration logic is
    // racing the input's mount. When the rename action starts editing from a
    // context menu, Radix's `onCloseAutoFocus` may steal focus from the input
    // moments after we focus it — this fires a stray blur. Re-anchor focus on
    // the input instead of saving with the unchanged value.
    //
    // Only the BLUR path needs this suppression — explicit Enter (handled
    // by handleTitleInputKeyDown) calls commitTitle directly so a fast
    // type-then-Enter flow still saves immediately.
    if (editingStartedAt && Date.now() - editingStartedAt < 300) {
      requestAnimationFrame(() => titleInputRef.current?.focus());
      return;
    }
    commitTitle();
  }, [editingStartedAt, commitTitle]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onTitleChange) return;
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        titleEditing.startEditing();
        requestAnimationFrame(() => titleInputRef.current?.select());
      }
    },
    [onTitleChange, titleEditing]
  );

  const handleTitleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        // Don't intercept Enter while an IME composition is being committed.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        commitTitle({ allowReset: true });
      } else if (e.key === "Escape") {
        titleEditing.stopEditing();
        titleEditing.setEditingValue(title);
      }
    },
    [commitTitle, title, titleEditing]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        onFocus();
      }
    },
    [onFocus, onClick]
  );

  const panelSurface = (
    <div
      ref={setRootRef}
      data-panel-id={id}
      data-panel-location={location}
      data-detected-process-id={detectedProcessId || undefined}
      data-detected-agent-id={detectedAgentId || undefined}
      data-launch-agent-id={agentId || undefined}
      data-ever-detected-agent={everDetectedAgent ? "true" : undefined}
      data-chrome-agent-id={terminalChrome.agentId || undefined}
      data-agent-state={headerAgentState || undefined}
      data-ambient-agent-state={ambientAgentState || undefined}
      data-runtime-kind={terminalChrome.runtimeKind}
      data-runtime-icon-id={terminalChrome.iconId || undefined}
      data-selected={isSelected || undefined}
      data-hibernated={isHibernated || undefined}
      data-fleet-dimmed={isFleetDimmed || undefined}
      style={{ contain: "content" }}
      className={cn(
        // Dual sizing contract, because the panel root is hosted under both
        // block-level and flex parents. `h-full` fills the block wrappers the
        // grid layouts use. `flex-1 min-h-0` covers the flex columns (dialog
        // body, dock slot, the registry's fade wrapper): there `h-full`
        // resolves against an indefinite parent and collapses to `auto`, so the
        // panel sizes to its content, the pane's own scroller never overflows,
        // and a long file just clips (#11254). Every wrapper between a host and
        // a pane root has to carry this same pair — see panels/registry.tsx.
        "flex flex-col h-full flex-1 min-h-0 overflow-hidden group/panel",
        location === "grid" && !isMaximized && "bg-surface",
        // Dialog joins the dock/maximized bucket: AppDialog already draws the
        // surface, border, radius, and shadow, so a second set here would
        // read as a panel nested inside a panel.
        (location === "dock" || location === "dialog" || isMaximized) && "bg-daintree-bg",
        location === "grid" &&
          !isMaximized &&
          "rounded border shadow-[var(--theme-shadow-ambient)] transition-colors duration-300",
        location === "grid" &&
          !isMaximized &&
          resolveGridPanelChromeClass({
            showGridAttention,
            showLonePaneFocusCue,
            showSelectedChrome,
            showGridAgentHighlights,
            isVoiceArming,
            isWaiting: blockedState === "waiting",
            isWorkingState,
            isHibernated,
          }),
        location === "grid" && isMaximized && "border-0 rounded-none z-[var(--z-maximized)]",
        // Voice-dictation lock border overrides ambient state colours so the
        // pinned target stays unambiguously visible. Applied after the state
        // ternary so its border-color/box-shadow wins by source order.
        location === "grid" &&
          !isMaximized &&
          isVoiceDictationLocked &&
          "panel-voice-dictation-locked",
        isFleetDimmed && "fleet-pane-dimmed",
        className
      )}
      onClick={handleClick}
      onKeyDown={onKeyDown}
      // -1 keeps the root out of the Tab sequence while making it a valid
      // script-focus target; a plain div with no tabindex silently ignores
      // .focus(). TerminalPane passes 0 explicitly and keeps it.
      tabIndex={tabIndex ?? -1}
      role={role}
      aria-label={ariaLabel}
      aria-selected={ariaSelected}
    >
      {/* The dialog presentation draws its own AppDialog.Header with the
            title, close, and "Open as panel" controls. Rendering PanelHeader
            too would duplicate title/close and expose grid-only affordances
            (rename, move to dock, maximize, trash) that a modal can't honour. */}
      {location !== "dialog" && (
        <PanelHeader
          isDragging={isDragging}
          id={id}
          title={title}
          kind={kind}
          agentId={agentId}
          chrome={terminalChrome}
          presetColor={presetColor}
          agentLaunchFlags={agentLaunchFlags}
          worktreeAccentColor={worktreeAccentColor}
          worktreeBranch={worktreeBranch}
          isFocused={isFocused}
          isMaximized={isMaximized}
          location={location}
          isEditingTitle={titleEditing.isEditingTitle}
          editingValue={titleEditing.editingValue}
          titleInputRef={titleInputRef}
          onEditingValueChange={titleEditing.setEditingValue}
          onTitleDoubleClick={handleTitleDoubleClick}
          onTitleKeyDown={handleTitleKeyDown}
          onTitleInputKeyDown={handleTitleInputKeyDown}
          onTitleSave={handleTitleSave}
          onClose={onClose}
          onFocus={onFocus}
          onToggleMaximize={onToggleMaximize}
          onTitleChange={onTitleChange}
          onMinimize={onMinimize}
          onRestore={onRestore}
          showRestoreControl={showRestoreControl}
          onRestart={onRestart}
          isPinged={isPinged}
          wasJustSelected={wasJustSelected}
          isSelected={isSelected}
          isFleetFollower={isFleetFollower}
          isFleetPreviewed={isFleetPreviewed}
          headerContent={resolvedHeaderContent}
          headerContentPlacement={headerContentPlacement}
          headerActions={headerActions}
          tabs={tabs}
          groupId={groupId}
          onTabClick={onTabClick}
          onTabClose={onTabClose}
          onTabRename={onTabRename}
          onAddTab={onAddTab}
          onTabReorder={onTabReorder}
        />
      )}

      {toolbar}

      <div className="flex-1 min-h-0 relative flex flex-col">{children}</div>

      {showExitPulse ? <span className="fleet-exit-pulse-overlay" aria-hidden="true" /> : null}
    </div>
  );

  // A dialog-presented panel gets no context menu: every command it offers is
  // grid/dock-scoped (move to grid, rename, background, trash, remove) and
  // would act on a panel the user can only see inside a modal.
  if (location === "dialog") return panelSurface;

  return (
    <TerminalContextMenu terminalId={id} forceLocation={location}>
      {panelSurface}
    </TerminalContextMenu>
  );
});

/**
 * Universal content panel component.
 * Base container for all panel types: terminals, agents, browsers, and extensions.
 */
export const ContentPanel = forwardRef<HTMLDivElement, ContentPanelProps>(
  function ContentPanel(props, ref) {
    // Resolve the display title once for both the header and the rename
    // editor (WYSIWYG prefill): identity-only in the dock, task-composed in
    // the grid. Non-pty panels keep the caller-provided title untouched, and
    // a parent-supplied override (props.title differing from the stored panel
    // title, e.g. the fleet scope's worktree prefix) always wins.
    const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
    const propsTitle = props.title;
    const composedTitle = usePanelStore((s) => {
      const panel = s.panelsById[props.id];
      if (!panel || !isPtyPanel(panel) || panel.title !== propsTitle) return undefined;
      return getTerminalDisplayTitle(panel, props.location === "dock" ? "base" : "full", {
        showTask: showAgentTaskTitles,
      });
    });
    const effectiveTitle = composedTitle ?? props.title;
    return (
      <TitleEditingProvider
        id={props.id}
        title={effectiveTitle}
        onTitleChange={props.onTitleChange}
      >
        <ContentPanelInner {...props} title={effectiveTitle} ref={ref} />
      </TitleEditingProvider>
    );
  }
);
