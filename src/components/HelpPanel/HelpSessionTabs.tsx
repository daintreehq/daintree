import { useCallback, useId, useMemo, useRef } from "react";
import { LayoutGroup } from "framer-motion";
import { Plus, RotateCw, SquareTerminal, X } from "lucide-react";
import { SpinnerCircle, InteractingCircle } from "@/components/icons";
import { BrandMark } from "@/components/icons/BrandMark";
import { getAgentConfig } from "@/config/agents";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { cn } from "@/lib/utils";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import {
  DocumentTabClose,
  DocumentTabIndicator,
  documentTabClassName,
} from "@/components/ui/document-tab";
import { isTabCloseKey, useKeyboardTabClose } from "@/hooks/useKeyboardTabClose";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import type { AgentState } from "@/types";
import { NewSessionWithAgentLabel } from "./NewSessionWithAgentLabel";

/**
 * The states a lane's marker draws: work in flight, either the agent's or the
 * user's own. A stop draws nothing. Amber is only for an ask Canopy read, and
 * Canopy never reads an assistant (it reads fleet runs, and assistants aren't
 * any), so a lane sitting at its prompt is not asking for anything and wears no
 * waiting ring. Idle and exited lanes stay quiet too.
 */
type TabMarkerState = "working" | "directing";

function tabMarkerState(agentState: AgentState | null | undefined): TabMarkerState | null {
  return agentState === "working" || agentState === "directing" ? agentState : null;
}

/**
 * Per-lane state marker (#12108).
 *
 * Same glyphs and the same tokens the rest of the app uses for agent state, at the
 * 14px the header used to draw them at. This is the whole reason the strip carries
 * state at all: a background session at work is otherwise invisible until the user
 * happens to switch to it.
 *
 * The size is load-bearing rather than cosmetic. These marks are read peripherally,
 * and at 12px the silhouettes stopped being separable from each other — a filled
 * ring and a gapped arc collapse to "small coloured dot", which leaves hue as the
 * only carrier and fails exactly the reader who most needs a second cue.
 */
export function TabStateIndicator({ agentState }: { agentState: AgentState | null | undefined }) {
  const marker = tabMarkerState(agentState);
  if (marker === "working") {
    return (
      <SpinnerCircle
        className="w-3.5 h-3.5 shrink-0 text-state-working animate-spin-slow motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (marker === "directing") {
    return (
      <InteractingCircle className="w-3.5 h-3.5 shrink-0 text-category-blue" aria-hidden="true" />
    );
  }
  return null;
}

/**
 * Which agent a lane runs, drawn only while the strip holds lanes on more than
 * one (#13442) — a single-agent strip has nothing to tell apart. The agent's
 * own mark in the leading 14px box a grid tab gives its terminal icon.
 */
export function TabAgentMark({ agentId }: { agentId: string }) {
  const config = getAgentConfig(agentId);
  const Icon = config?.icon ?? SquareTerminal;
  return (
    <span
      data-testid="assistant-tab-agent-mark"
      data-agent-id={agentId}
      aria-hidden="true"
      className="shrink-0 flex items-center justify-center w-3.5 h-3.5"
    >
      <BrandMark brandColor={config?.color}>
        <Icon className="w-3.5 h-3.5" />
      </BrandMark>
    </span>
  );
}

/** What a lane's agent is called where it is spoken or written out. */
function agentDisplayName(agentId: string): string {
  return getAgentConfig(agentId)?.name ?? agentId;
}

/**
 * The label, split so the part that identifies the lane cannot be truncated away.
 *
 * A fallback `Session N` label puts none of the information in the word and all of it
 * in the last token — and a plain `truncate` removes them in exactly the wrong order.
 * Splitting at the LAST space keeps the numeral whole. The tail keeps its leading space
 * via `whitespace-pre` so the two halves read as one word pair.
 *
 * An observed task title is the opposite shape: its last word is no more identifying
 * than its first, and pinning it would truncate the start of the sentence instead of
 * the end. It has already been capped to a tab's worth of text, so it simply
 * truncates from the end like every other tab in the app.
 */
function TabLabel({
  label,
  isTaskTitle,
  labelRef,
}: {
  label: string;
  isTaskTitle: boolean;
  /** Measures a task title for clipping; a `Session N` label never needs revealing. */
  labelRef?: (el: HTMLElement | null) => void;
}) {
  if (isTaskTitle)
    return (
      <span ref={labelRef} className="truncate">
        {label}
      </span>
    );
  const split = label.lastIndexOf(" ");
  if (split <= 0) return <span className="truncate">{label}</span>;
  return (
    <span className="flex items-center min-w-0">
      <span className="truncate">{label.slice(0, split)}</span>
      <span className="shrink-0 whitespace-pre">{label.slice(split)}</span>
    </span>
  );
}

const EMPTY_AGENT_IDS: readonly string[] = [];

export interface HelpSessionTab {
  slot: number;
  /** What the tab shows: the agent's trimmed task title, or `Session N`. */
  label: string;
  /**
   * The untrimmed task title when `label` came from one — the tab's tooltip, its
   * accessible name and its close control's. Absent on a `Session N` fallback, which
   * is also how the label knows which shape it has.
   */
  fullTitle?: string | undefined;
  agentState: AgentState | null | undefined;
  /** The agent the lane runs or will resume with; absent while nothing says. */
  agentId?: string | null;
  /**
   * The lane has a live terminal and agent, or is the paused lane on screen — the
   * header's own gate for "Restart conversation".
   */
  canRestart?: boolean;
}

/**
 * The DOM id of one lane's tab, derived rather than generated.
 *
 * The body below the strip is this tablist's `tabpanel` and has to point back at the
 * selected tab through `aria-labelledby`, which means the id has to be knowable from
 * outside this component. Deriving both ends from one `useId` base owned by the panel
 * does that without either side holding a ref to the other — and a ref crossing a
 * component boundary is also a silent React Compiler bailout in this repo.
 */
export function helpSessionTabId(idBase: string, slot: number): string {
  return `${idBase}-tab-${slot}`;
}

interface SessionTabChipProps {
  tab: HelpSessionTab;
  /**
   * The lane's state, already resolved. Deliberately a separate prop rather than read
   * off `tab`: it is the seam that lets a lane whose state lives somewhere other than
   * the tab — its own store, say — wrap this chip in a component that subscribes and
   * passes the result down. That wrapper is the only legal way to subscribe to a
   * variable number of stores, and it keeps the read narrow enough that one background
   * lane's activity re-renders one chip, not the strip.
   */
  agentState: AgentState | null | undefined;
  isActive: boolean;
  tabId: string;
  panelId: string;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  onFocusTab: (slot: number) => void;
  /** Close from the lane's own menu, with focus handed on once the lane is gone. */
  onMenuClose: (slot: number) => void;
  onRestart?: (slot: number) => void;
  isSoleLane: boolean;
  canOpenSession: boolean;
  onOpenSession?: () => void;
  /** Whether the strip spans several agents, so each lane names its own. */
  showAgent: boolean;
  /** A full strip: background lanes give their hover close back to their label. */
  isCrowded: boolean;
  newSessionAgentIds: readonly string[];
  canOpenSessionWithAgent: boolean;
  onOpenSessionWithAgent?: (agentId: string) => void;
  isRegionFocused: boolean;
}

/**
 * One tab, drawn as a member of the app's document tab family (`ui/document-tab`):
 * the same underline, fill, weight, close control and keyboard contract as the grid,
 * dock and portal strips.
 */
function SessionTabChip({
  tab,
  agentState,
  isActive,
  tabId,
  panelId,
  onSelect,
  onClose,
  onFocusTab,
  onMenuClose,
  onRestart,
  isSoleLane,
  canOpenSession,
  onOpenSession,
  showAgent,
  isCrowded,
  newSessionAgentIds,
  canOpenSessionWithAgent,
  onOpenSessionWithAgent,
  isRegionFocused,
}: SessionTabChipProps) {
  const closingFromMenuRef = useRef(false);
  const stateId = `${tabId}-state`;
  // Described with what the marker draws and nothing else, so a lane at its
  // prompt is never announced as waiting when nothing is asked of the user.
  const marker = tabMarkerState(agentState);
  const agentName = showAgent && tab.agentId ? agentDisplayName(tab.agentId) : null;
  // The agent joins the name rather than the description: it is what tells two
  // `Session N` tabs apart, which is the job of a name.
  const title = agentName
    ? `${tab.fullTitle ?? tab.label} — ${agentName}`
    : (tab.fullTitle ?? tab.label);
  const hasAgentItems = !!onOpenSessionWithAgent && newSessionAgentIds.length > 1;
  const { ref: labelRef, isTruncated: isLabelTruncated } = useTruncationDetection();

  const chip = (
    <div
      // The APG tabs pattern, not a toggle-button group. One selector set drives one
      // shared body, which is the mutually-exclusive container the pattern is for.
      role="tab"
      id={tabId}
      // How the strip finds one lane without holding a ref to every chip.
      data-slot={tab.slot}
      data-document-tab=""
      aria-selected={isActive}
      aria-controls={panelId}
      // The strip is ONE tab stop, and it sits on the selected lane: tabbing back in
      // lands on the session the body is showing.
      tabIndex={isActive ? 0 : -1}
      // Stated, not derived. The visible label is split across two spans so its
      // identifying tail cannot truncate, and the accessible-name algorithm trims each
      // element's own contribution before joining them — which silently turned
      // "Session 1" into "Session1" for every screen reader.
      // The whole task title rather than the capped one: two tasks that share an
      // opening would otherwise announce identically.
      aria-label={title}
      // The state reaches assistive tech as a DESCRIPTION, not as part of the name. An
      // explicit label on a tab overrides everything inside it, which would take the
      // marker's meaning away from exactly the reader who cannot see the glyph.
      aria-describedby={marker ? stateId : undefined}
      aria-keyshortcuts="Delete"
      onClick={() => onSelect(tab.slot)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(tab.slot);
        }
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusTab(tab.slot);
      }}
      className={cn(
        documentTabClassName(isActive),
        // Content-width, like every other tab strip in the app and every browser's. Tabs
        // may shrink when the strip is tight — three lanes at the 320px minimum — and
        // `TabLabel` keeps the identifying numeral out of the part that gives way.
        "min-w-0 shrink px-2 py-1.5"
      )}
    >
      {isActive && <DocumentTabIndicator inFocusedRegion={isRegionFocused} />}
      {agentName && tab.agentId && <TabAgentMark agentId={tab.agentId} />}
      <TabStateIndicator agentState={agentState} />
      <TabLabel label={tab.label} isTaskTitle={tab.fullTitle !== undefined} labelRef={labelRef} />
      {/* A background lane's close is invisible until hover but still holds its 24px,
          and three lanes at the panel's narrow widths spent that room clipping every
          label to "Ses… 1". Crowded, only the selected lane draws one, as a browser's
          narrow tabs do; Delete and the lane's own menu still close any of them. */}
      {(isActive || !isCrowded) && (
        <DocumentTabClose
          title={title}
          isActive={isActive}
          onClose={() => onClose(tab.slot)}
          className="-my-1 -mr-1.5"
        />
      )}
      {marker && (
        <span id={stateId} className="sr-only">
          {marker}
        </span>
      )}
    </div>
  );

  // The whole task title, whenever the visible one was capped upstream or is clipped
  // here — `TruncatedTooltip`'s rule. Only for a task title: a `Session N` tooltip would
  // repeat the tab word for word. Spelled out rather than wrapped in `TruncatedTooltip`,
  // which hands a non-button trigger `tabIndex={0}` and would put every clipped lane back
  // in the tab order. The wrapper stays mounted either way and is simply held shut —
  // swapping it in when a title arrives would remount the tab and drop keyboard focus.
  // A lane marked with its agent explains the mark in the same tooltip.
  const hasTitleTip =
    agentName !== null ||
    (tab.fullTitle !== undefined && (tab.fullTitle !== tab.label || isLabelTruncated));
  // Each lane owns its menu, like every other tab in the app: a right-click on a
  // background lane restarts or closes that lane, never the one in front.
  return (
    <ContextMenu>
      <Tooltip autoDismiss={false} open={hasTitleTip ? undefined : false}>
        <ContextMenuTrigger asChild onContextMenu={stopContextMenuPropagation}>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
        </ContextMenuTrigger>
        {(tab.fullTitle !== undefined || agentName !== null) && (
          <TooltipContent side="bottom">{title}</TooltipContent>
        )}
      </Tooltip>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          // Back onto a lane that is closing would read as a cancelled close and
          // stand the handoff down; the strip moves focus once the lane is gone.
          // The sole lane survives its close (it resets in place), so it takes
          // focus back as usual.
          if (closingFromMenuRef.current && !isSoleLane) e.preventDefault();
          closingFromMenuRef.current = false;
        }}
      >
        {onOpenSession && (
          <ContextMenuItem disabled={!canOpenSession} onSelect={onOpenSession}>
            <Plus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            New session
          </ContextMenuItem>
        )}
        {hasAgentItems &&
          newSessionAgentIds.map((agentId) => (
            <ContextMenuItem
              key={agentId}
              disabled={!canOpenSessionWithAgent}
              onSelect={() => onOpenSessionWithAgent?.(agentId)}
            >
              <NewSessionWithAgentLabel agentId={agentId} />
            </ContextMenuItem>
          ))}
        {(onOpenSession || hasAgentItems) && <ContextMenuSeparator />}
        {/* Hidden rather than disabled where the lane has nothing to restart, as the
            header's overflow item is. The tab survives a restart, so the menu hands
            focus back to it as usual. */}
        {onRestart && tab.canRestart && (
          <ContextMenuItem destructive onSelect={() => onRestart(tab.slot)}>
            <RotateCw data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Restart conversation
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => {
            closingFromMenuRef.current = true;
            onMenuClose(tab.slot);
          }}
        >
          <X data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Close session
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface HelpSessionTabsProps {
  tabs: HelpSessionTab[];
  activeSlot: number;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  /** Restart one lane's conversation from its own menu, offered where its tab says it can. */
  onRestart?: (slot: number) => void;
  /** Whether a lane is still free. False parks the trailing control rather than removing it. */
  canOpenSession?: boolean;
  onOpenSession?: () => void;
  /** Agents a session can be started on by name, from a tab's menu; offered only when there are several. */
  newSessionAgentIds?: readonly string[];
  /** Whether one can start, which an empty tab allows even at the ceiling. Defaults to `canOpenSession`. */
  canOpenSessionWithAgent?: boolean;
  onOpenSessionWithAgent?: (agentId: string) => void;
  /** Shared base for this strip's ids — see {@link helpSessionTabId}. */
  idBase: string;
  /** The id of the body this strip drives, for `aria-controls`. */
  panelId: string;
  /**
   * Whether the assistant is the region the keyboard is in. The selected lane's
   * underline takes the accent only then, as a grid pane's strip does.
   */
  isRegionFocused?: boolean;
}

/**
 * The session strip.
 *
 * Always rendered, at one lane as well as three. That is what every comparable side
 * panel does — Cursor's chat, Windsurf's Cascade, Copilot Chat, Zed's agent panel all
 * keep the strip at a single session — and it is what gives the panel one honest home
 * for "which session am I in" and "give me another". Hiding it below two lanes meant
 * the way to a second session existed only inside an overflow menu, two clicks behind
 * an ellipsis, while a visible "+" one row up did something else entirely.
 *
 * The tabs are the app's document tab family (`ui/document-tab`), so selection is
 * marked exactly as it is on a grid pane, the dock and the portal: an accent underline
 * on a lifted fill, at the same weight as every other tab, neutral while the
 * keyboard is elsewhere.
 *
 * Tabs are content-width and sit at the leading edge with the new-session control
 * directly after the last one, which is how the panel, dock and portal strips in this
 * app lay out and how a browser does. The tablist scrolls horizontally if it ever has
 * to; at the current ceiling of three lanes it cannot, and a raised ceiling would find
 * the machinery already there rather than tabs clipped off the end.
 *
 * The keyboard contract is the family's: the APG tabs pattern with MANUAL activation.
 * Arrow keys and Home/End move focus along the strip, Enter or Space selects, Delete
 * closes, and the single tab stop sits on the selected lane. Manual
 * rather than automatic because selecting a lane swaps a live terminal into the body
 * and refits it — arrowing across three lanes with automatic activation would tear
 * down and remount two sessions on the way past.
 */
export function HelpSessionTabs({
  tabs,
  activeSlot,
  onSelect,
  onClose,
  onRestart,
  canOpenSession = false,
  onOpenSession,
  newSessionAgentIds = EMPTY_AGENT_IDS,
  canOpenSessionWithAgent = canOpenSession,
  onOpenSessionWithAgent,
  idBase,
  panelId,
  isRegionFocused = true,
}: HelpSessionTabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const layoutGroupId = useId();
  // Lanes on one agent look exactly as they always did; only a mix is marked.
  const showAgent = new Set(tabs.flatMap((t) => (t.agentId ? [t.agentId] : []))).size > 1;

  /**
   * Move focus to one lane by DOM query rather than by holding a ref per tab. One ref on
   * the container does the same job, and a ref handed down to a subcomponent as a prop is
   * a silent React Compiler bailout in this repo.
   */
  const focusSlot = useCallback((slot: number) => {
    listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-slot="${slot}"]`)?.focus();
  }, []);

  const slots = useMemo(() => tabs.map((t) => t.slot), [tabs]);

  /**
   * Closing a lane with a working agent raises a confirm dialog first, and `tabs` is
   * rebuilt on every `agentState` transition, so the handoff waits for THAT lane to be
   * gone. Closing the active lane makes the store select its neighbour, the following
   * one first, and focus follows the selection there.
   */
  const { armKeyboardClose, disarmKeyboardClose } = useKeyboardTabClose({
    ids: slots,
    activeId: activeSlot,
    focusTab: focusSlot,
  });

  /**
   * A cancelled confirm dialog hands focus back to the tab it was opened from, so focus
   * arriving on the closing lane is the signal that the close is not happening.
   */
  const handleTabFocus = useCallback(
    (slot: number) => disarmKeyboardClose(slot),
    [disarmKeyboardClose]
  );

  /** A pointer close leaves focus where it was; an armed keyboard close must not fire on it. */
  const handlePointerClose = useCallback(
    (slot: number) => {
      disarmKeyboardClose();
      onClose(slot);
    },
    [disarmKeyboardClose, onClose]
  );

  const handleMenuClose = useCallback(
    (slot: number) => {
      armKeyboardClose(slot);
      onClose(slot);
    },
    [armKeyboardClose, onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // The focused lane, whichever element the key reached the list through.
      const focused = document.activeElement;
      const order = tabs.map((t) => t.slot);
      const current =
        focused && listRef.current?.contains(focused)
          ? order.findIndex((id) => focused.getAttribute("data-slot") === String(id))
          : -1;
      if (current === -1) return;
      // Wrap, which is what the pattern specifies for a horizontal tablist.
      const focusAt = (index: number) => {
        const slot = order[((index % order.length) + order.length) % order.length];
        if (slot !== undefined) focusSlot(slot);
      };

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          focusAt(current + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          focusAt(current - 1);
          break;
        case "Home":
          e.preventDefault();
          focusAt(0);
          break;
        case "End":
          e.preventDefault();
          focusAt(order.length - 1);
          break;
        default: {
          if (!isTabCloseKey(e.key)) break;
          const tab = tabs.find((t) => t.slot === order[current]);
          if (!tab) return;
          e.preventDefault();
          armKeyboardClose(tab.slot);
          onClose(tab.slot);
        }
      }
    },
    [tabs, onClose, focusSlot, armKeyboardClose]
  );

  if (tabs.length === 0) return null;

  return (
    // No bottom padding: the selected tab's underline sits on the strip's bottom
    // rule, as it does on every document tab strip.
    <div className="flex items-center gap-0.5 px-1 pt-1 border-b border-border-default shrink-0">
      {/* The tablist is its own element so that it owns nothing but tabs. With the
          new-session button inside it, axe's `aria-required-children` rejects the
          stray `button` in a `tablist`; as a sibling it is simply the next control. */}
      <div
        ref={listRef}
        role="tablist"
        aria-label="Assistant sessions"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        // `overflow-x-auto` is the safety net, not the plan: at the current ceiling of
        // three lanes the tabs shrink before they overflow. The scrollbar is hidden
        // because a scrollbar inside a 33px strip is louder than the tabs it scrolls.
        className="flex items-stretch min-w-0 overflow-x-auto [scrollbar-width:none]"
      >
        <LayoutGroup id={layoutGroupId}>
          {tabs.map((tab) => (
            <SessionTabChip
              key={tab.slot}
              tab={tab}
              agentState={tab.agentState}
              isActive={tab.slot === activeSlot}
              tabId={helpSessionTabId(idBase, tab.slot)}
              panelId={panelId}
              onSelect={onSelect}
              onClose={handlePointerClose}
              onFocusTab={handleTabFocus}
              onMenuClose={handleMenuClose}
              onRestart={onRestart}
              isSoleLane={tabs.length === 1}
              canOpenSession={canOpenSession}
              onOpenSession={onOpenSession}
              showAgent={showAgent}
              isCrowded={tabs.length >= MAX_ASSISTANT_SLOTS}
              newSessionAgentIds={newSessionAgentIds}
              canOpenSessionWithAgent={canOpenSessionWithAgent}
              onOpenSessionWithAgent={onOpenSessionWithAgent}
              isRegionFocused={isRegionFocused}
            />
          ))}
        </LayoutGroup>
      </div>
      {/* The one way to another session, directly after the last tab where a tab set
          keeps it. Parked rather than removed at the ceiling: a control that vanishes
          takes its own explanation with it. */}
      {onOpenSession && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={canOpenSession ? onOpenSession : undefined}
              // `aria-disabled`, not `disabled`. A truly disabled button is removed from
              // the tab order and stops firing pointer events, which takes its tooltip
              // with it — so the one state that has something to explain would have been
              // the one state that could not explain it.
              aria-disabled={!canOpenSession || undefined}
              className={cn(
                "shrink-0 [&_svg]:size-3.5 focus-visible:-outline-offset-2",
                ARIA_DISABLED_CLASSES,
                // Hover stays live for the tooltip, but lifts nothing it can't do.
                "aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-secondary aria-disabled:active:scale-100"
              )}
              aria-label="New session"
            >
              <Plus aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {canOpenSession
              ? "Open another session beside this one"
              : `${MAX_ASSISTANT_SLOTS} sessions is the maximum for one project`}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
