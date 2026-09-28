import { useCallback, useId, useMemo, useRef } from "react";
import { LayoutGroup } from "framer-motion";
import { Plus } from "lucide-react";
import { SpinnerCircle, HollowCircle, InteractingCircle } from "@/components/icons";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DocumentTabClose,
  DocumentTabIndicator,
  documentTabClassName,
} from "@/components/ui/document-tab";
import { isTabCloseKey, useKeyboardTabClose } from "@/hooks/useKeyboardTabClose";
import type { AgentState } from "@/types";

/**
 * Per-lane state marker (#12108).
 *
 * Same triad and the same tokens the rest of the app uses for agent state, at the
 * 14px the header used to draw them at — only working, directing and waiting earn a
 * marker; idle and exited stay quiet. This is the whole reason the strip carries
 * state at all: a background session that has gone to `waiting` is otherwise
 * invisible until the user happens to switch to it.
 *
 * The size is load-bearing rather than cosmetic. These marks are read peripherally,
 * and at 12px the three silhouettes stopped being separable from each other — a
 * filled ring, a hollow ring and a gapped arc all collapse to "small coloured dot",
 * which leaves hue as the only carrier and fails exactly the reader who most needs a
 * second cue.
 */
function TabStateIndicator({ agentState }: { agentState: AgentState | null | undefined }) {
  if (agentState === "working") {
    return (
      <SpinnerCircle
        className="w-3.5 h-3.5 shrink-0 text-state-working animate-spin-slow motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }
  if (agentState === "directing") {
    return (
      <InteractingCircle className="w-3.5 h-3.5 shrink-0 text-category-blue" aria-hidden="true" />
    );
  }
  if (agentState === "waiting") {
    return <HollowCircle className="w-3.5 h-3.5 shrink-0 text-state-waiting" aria-hidden="true" />;
  }
  return null;
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
function TabLabel({ label, isTaskTitle }: { label: string; isTaskTitle: boolean }) {
  if (isTaskTitle) return <span className="truncate">{label}</span>;
  const split = label.lastIndexOf(" ");
  if (split <= 0) return <span className="truncate">{label}</span>;
  return (
    <span className="flex items-center min-w-0">
      <span className="truncate">{label.slice(0, split)}</span>
      <span className="shrink-0 whitespace-pre">{label.slice(split)}</span>
    </span>
  );
}

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
}: SessionTabChipProps) {
  const stateId = `${tabId}-state`;
  const title = tab.fullTitle ?? tab.label;

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
      aria-describedby={agentState ? stateId : undefined}
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
      {isActive && <DocumentTabIndicator />}
      <TabStateIndicator agentState={agentState} />
      <TabLabel label={tab.label} isTaskTitle={tab.fullTitle !== undefined} />
      <DocumentTabClose
        title={title}
        isActive={isActive}
        onClose={() => onClose(tab.slot)}
        className="-my-1 -mr-1.5"
      />
      {agentState && (
        <span id={stateId} className="sr-only">
          {agentState}
        </span>
      )}
    </div>
  );

  // The whole task title, since the visible one may be capped or truncated. Only for a
  // task title: a `Session N` tooltip would repeat the tab word for word. The wrapper
  // stays mounted either way and is simply held shut — swapping it in when a title
  // arrives would remount the tab and drop keyboard focus on the floor.
  const hasTitleTip = tab.fullTitle !== undefined;
  return (
    <Tooltip autoDismiss={false} open={hasTitleTip ? undefined : false}>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      {hasTitleTip && <TooltipContent side="bottom">{tab.fullTitle}</TooltipContent>}
    </Tooltip>
  );
}

interface HelpSessionTabsProps {
  tabs: HelpSessionTab[];
  activeSlot: number;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  /** Whether a lane is still free. False parks the trailing control rather than removing it. */
  canOpenSession?: boolean;
  onOpenSession?: () => void;
  /** Shared base for this strip's ids — see {@link helpSessionTabId}. */
  idBase: string;
  /** The id of the body this strip drives, for `aria-controls`. */
  panelId: string;
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
 * on a lifted fill, at the same weight as every other tab.
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
  canOpenSession = false,
  onOpenSession,
  idBase,
  panelId,
}: HelpSessionTabsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const layoutGroupId = useId();

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
   * Closing a lane with a live agent raises a confirm dialog first, and `tabs` is rebuilt
   * on every `agentState` transition, so the handoff waits for THAT lane to be gone.
   * Closing the active lane makes the store pick a new active lane — the lowest remaining
   * slot, not the neighbour — and focus follows the selection there.
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // The focused lane, whichever element the key reached the list through.
      const focused = document.activeElement;
      const current =
        focused && listRef.current?.contains(focused)
          ? tabs.findIndex((t) => focused.getAttribute("data-slot") === String(t.slot))
          : -1;
      if (current === -1) return;
      // Wrap, which is what the pattern specifies for a horizontal tablist.
      const focusAt = (index: number) => {
        const slot = tabs[((index % tabs.length) + tabs.length) % tabs.length]?.slot;
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
          focusAt(tabs.length - 1);
          break;
        default: {
          if (!isTabCloseKey(e.key)) break;
          const tab = tabs[current];
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
            <button
              type="button"
              onClick={canOpenSession ? onOpenSession : undefined}
              // `aria-disabled`, not `disabled`. A truly disabled button is removed from
              // the tab order and stops firing pointer events, which takes its tooltip
              // with it — so the one state that has something to explain would have been
              // the one state that could not explain it.
              aria-disabled={!canOpenSession || undefined}
              className={cn(
                "w-6 h-6 inline-flex items-center justify-center shrink-0",
                "rounded-[var(--radius-sm)] text-text-secondary",
                "transition-colors duration-150 ease-out",
                canOpenSession
                  ? "hover:text-text-primary hover:bg-overlay-subtle"
                  : "opacity-40 cursor-default",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
              )}
              aria-label="New session"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
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
