import { useCallback, useRef } from "react";
import { Plus, X } from "lucide-react";
import { SpinnerCircle, HollowCircle, InteractingCircle } from "@/components/icons";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { cn } from "@/lib/utils";
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
 * Every label here is `Session N`, which means the word carries none of the
 * information and the last token carries all of it — and a plain `truncate` removes
 * them in exactly the wrong order. Splitting at the LAST space rather than formatting
 * a known shape keeps the component honest about what it is given: it receives an
 * opaque string, and a label with no space simply truncates as before. The tail keeps
 * its leading space via `whitespace-pre` so the two halves read as one word pair.
 */
function TabLabel({ label }: { label: string }) {
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
  label: string;
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
  /**
   * Whether there is more than one lane to choose between. The fill and the rail are a
   * SELECTION mark, and a selection mark on the only available option states nothing —
   * at one lane it also spans nearly the whole strip, where the rail stops reading as a
   * mark on a tab and starts reading as a second bottom border. The active lane still
   * takes the selected TEXT treatment either way, so a single tab reads as the session
   * you are in rather than as an unselected one.
   */
  showSelection: boolean;
  tabId: string;
  panelId: string;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
}

/** One tab: its marker, its label, its close control, and its selection mark. */
function SessionTabChip({
  tab,
  agentState,
  isActive,
  showSelection,
  tabId,
  panelId,
  onSelect,
  onClose,
}: SessionTabChipProps) {
  const stateId = `${tabId}-state`;

  return (
    <div
      // Presentational on purpose: a `tablist` owns `tab` children, and the real tab is
      // the button inside. The wrapper exists so the close control can be a SIBLING of
      // the tab rather than a focusable descendant of it, which ARIA forbids.
      role="presentation"
      // `session-tab` is not styling — it is the handle for the selected tab's rail and
      // its forced-colors fallback, both in `index.css`. `relative` because the rail is
      // an `::after` positioned against this element, and `data-active` because the mark
      // belongs to the whole chip while `aria-selected` belongs to the tab inside it.
      data-active={showSelection && isActive}
      className={cn(
        "session-tab group relative flex items-center min-w-0",
        // Equal shares of the strip rather than content-width chips left-aligned with
        // dead space after them. At the 320px minimum three lanes come to ~93px each,
        // which still clears the 80px floor a status marker plus a truncated label plus
        // a close target needs; at one lane it makes the strip a session title bar,
        // which is what a single-tab strip is for.
        "flex-1 basis-0",
        "rounded-[var(--radius-sm)] transition-colors duration-150 ease-out",
        // `overlay-raised` is the app's selection fill — the same one a palette row and
        // a highlighted menu item wear. It cannot carry the signal alone; the rail below
        // it is what meets WCAG 1.4.11.
        showSelection && isActive ? "bg-overlay-raised" : "hover:bg-overlay-subtle"
      )}
    >
      <button
        type="button"
        // The APG tabs pattern, not a toggle-button group. One selector set drives one
        // shared body, which is the mutually-exclusive container the pattern is for, and
        // it is what buys Left/Right movement between lanes — previously the only way
        // across the strip was Tab, which stopped on every close control on the way.
        role="tab"
        id={tabId}
        aria-selected={isActive}
        aria-controls={panelId}
        // Roving tabindex: the strip is ONE tab stop, and arrow keys move inside it.
        tabIndex={isActive ? 0 : -1}
        // Stated, not derived. The visible label is split across two spans so its
        // identifying tail cannot truncate, and the accessible-name algorithm trims each
        // element's own contribution before joining them — which silently turned
        // "Session 1" into "Session1" for every screen reader.
        aria-label={tab.label}
        // The state reaches assistive tech as a DESCRIPTION, not as part of the name. An
        // explicit label on a tab overrides everything inside it, which would take the
        // marker's meaning away from exactly the reader who cannot see the glyph.
        aria-describedby={agentState ? stateId : undefined}
        // The close control is pointer-only by design (see below), so the keyboard route
        // to it has to be advertised rather than discovered.
        aria-keyshortcuts="Delete"
        onClick={() => onSelect(tab.slot)}
        className={cn(
          // `pl-2` against the strip's own `px-1` puts this tab's first ink at 12px — the
          // same column the header's Daintree mark starts in, one row up.
          //
          // `pr-1` is not symmetry — it is the inset focus ring's clearance. The ring is
          // drawn 1px inside this button and is 2px thick, so with no right padding it
          // painted over the label's last character, which on a `Session N` label is the
          // only character that identifies the lane.
          "flex items-center gap-1.5 min-w-0 flex-1 pl-2 pr-1 py-1",
          "text-xs rounded-[var(--radius-sm)] transition-colors duration-150 ease-out",
          // Inset, unlike every other ring in this panel. The chip is 24px in a strip
          // whose padding is 4px, so an outset 2px ring at a 2px offset measured exactly
          // 32px — flush against the header's hairline above and the body's below, with
          // nothing between them. Drawn inside, it reads as a ring on the tab instead of
          // a second divider.
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-1",
          isActive
            ? "text-text-primary font-medium"
            : "text-text-secondary group-hover:text-text-primary"
        )}
      >
        <TabStateIndicator agentState={agentState} />
        <TabLabel label={tab.label} />
      </button>
      <button
        type="button"
        // Pointer-only, and deliberately so. A second tab stop per chip is exactly what
        // makes a roving tabindex impossible — at three lanes it put six stops between
        // the header and the body — so the tab is the sole focus target and closing
        // moves to `Delete`, which the tablist handles and `aria-keyshortcuts` announces.
        //
        // Both attributes are load-bearing and neither is decoration. `tabIndex={-1}`
        // keeps it out of the sequence AND out of axe's nested-interactive rule, which
        // keys on focusability. `aria-hidden` is what keeps `aria-required-children`
        // satisfied: a `tablist` may only own `tab` elements, this button is a sibling
        // of one rather than a descendant (nesting a button inside a button is invalid
        // HTML), and hiding it is what removes it from the tablist's owned set instead
        // of leaving a stray `button` child there.
        tabIndex={-1}
        aria-hidden="true"
        onClick={(e) => {
          // Without this the click reaches the chip and selects the lane on its way to
          // closing it, which briefly swaps the body to a session that is being torn
          // down.
          e.stopPropagation();
          onClose(tab.slot);
        }}
        title={`Close ${tab.label}`}
        className={cn(
          // 24x24, the WCAG 2.2 SC 2.5.8 floor, reached by growing the BOX and leaving
          // the 12px glyph alone. The chip is exactly 24px tall, so this costs height
          // nothing.
          "w-6 h-6 inline-flex items-center justify-center shrink-0",
          "rounded-[var(--radius-sm)] text-text-secondary",
          // Visible outright on the selected lane — that is the session you would close,
          // and a control the pointer has to go looking for is one most people never
          // find. Gated on the chip's own hover elsewhere, which keeps a strip of three
          // from reading as a row of dismiss buttons. `focus-within` rather than
          // `focus-visible`: the control itself no longer takes focus, so the trigger has
          // to be the tab beside it.
          isActive
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          "hover:text-text-primary hover:bg-tint/8 transition-[opacity,color,background-color] duration-150 ease-out"
        )}
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
      {agentState && (
        <span id={stateId} className="sr-only">
          {agentState}
        </span>
      )}
    </div>
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
 * No accent anywhere: the strip sits inside the assistant focus region, whose one
 * load-bearing accent is already spent on the focus ring. Selection is marked the way
 * every other neutral selection in the app is marked — an `overlay-raised` fill, a
 * `selection-outline` rail, and the primary text colour at medium weight. Three
 * coordinated signals rather than one, because the fill is 4% additive on dark and
 * cannot carry it alone.
 *
 * Tabs share the width equally instead of sitting content-width at the leading edge.
 * At two lanes in a 380px panel that recovered about 165px of dead space which had
 * made the row read as unfinished, and it removes the overflow question entirely:
 * three is the ceiling, three always fit.
 *
 * The keyboard contract is the APG tabs pattern with MANUAL activation. Arrow keys and
 * Home/End move focus along the strip, Enter or Space selects, Delete closes. Manual
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

  /**
   * Move focus along the strip by DOM query rather than by holding a ref per tab.
   * One ref on the container does the same job, and a ref handed down to a subcomponent
   * as a prop is a silent React Compiler bailout in this repo.
   */
  const focusTabAt = useCallback((index: number) => {
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll<HTMLElement>('[role="tab"]');
    if (items.length === 0) return;
    // Wrap, which is what the pattern specifies for a horizontal tablist.
    const wrapped = ((index % items.length) + items.length) % items.length;
    items[wrapped]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const list = listRef.current;
      if (!list) return;
      const items = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
      const current = items.findIndex((el) => el === document.activeElement);
      if (current === -1) return;

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          focusTabAt(current + 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          focusTabAt(current - 1);
          break;
        case "Home":
          e.preventDefault();
          focusTabAt(0);
          break;
        case "End":
          e.preventDefault();
          focusTabAt(items.length - 1);
          break;
        case "Delete":
        case "Backspace": {
          const tab = tabs[current];
          if (!tab) return;
          e.preventDefault();
          // Aim focus at the lane that will occupy this position afterwards, so closing
          // the middle of three leaves focus in the strip rather than on the document.
          // Closing may open a confirm dialog instead, in which case the dialog takes
          // focus and this is a no-op the user never sees.
          onClose(tab.slot);
          focusTabAt(current === items.length - 1 ? current - 1 : current);
          break;
        }
        default:
          break;
      }
    },
    [tabs, onClose, focusTabAt]
  );

  if (tabs.length === 0) return null;

  const showSelection = tabs.length > 1;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Assistant sessions"
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className="flex items-stretch gap-0.5 px-1 py-1 border-b border-border-default shrink-0"
    >
      {tabs.map((tab) => (
        <SessionTabChip
          key={tab.slot}
          tab={tab}
          agentState={tab.agentState}
          isActive={tab.slot === activeSlot}
          showSelection={showSelection}
          tabId={helpSessionTabId(idBase, tab.slot)}
          panelId={panelId}
          onSelect={onSelect}
          onClose={onClose}
        />
      ))}
      {/* The one way to another session, at the edge a tab set keeps it, drawn with the
          glyph that means "one more of these". It used to be a `Columns2` mark placed
          here to avoid colliding with a "+" in the header that restarted the current
          conversation instead — two controls a row apart, one of them findable, both of
          them looking like they added something. The header's is gone, so this can be
          the plus it always should have been.

          Parked rather than removed at the ceiling: a control that vanishes takes its
          own explanation with it, and the strip's width budget stays constant whether a
          lane is free or not. */}
      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          disabled={!canOpenSession}
          className={cn(
            "ml-0.5 w-6 h-6 inline-flex items-center justify-center shrink-0 self-center",
            "rounded-[var(--radius-sm)] text-text-secondary",
            "transition-colors duration-150 ease-out",
            "enabled:hover:text-text-primary enabled:hover:bg-overlay-subtle",
            "disabled:opacity-40 disabled:cursor-default",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-1"
          )}
          aria-label="New session"
          title={
            canOpenSession
              ? "Open another session beside this one"
              : `${MAX_ASSISTANT_SLOTS} sessions is the maximum for one project`
          }
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
