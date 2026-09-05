import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { assistantStoreForSlot, selectAssistantLaneState } from "@/store/assistantStore";
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
  native?: boolean;
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
   * Whether this lane owns the strip's single tab stop. Deliberately not the same thing
   * as `isActive`: under manual activation the arrow keys move the stop without moving
   * the selection, so the focused lane and the selected lane are routinely different.
   */
  hasTabStop: boolean;
  tabId: string;
  panelId: string;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  /** Hands the strip's single tab stop to whichever lane focus just reached. */
  onFocusTab: (slot: number) => void;
}

/** One tab: its marker, its label, its close control, and its selection mark. */
function SessionTabChip({
  tab,
  agentState,
  isActive,
  hasTabStop,
  tabId,
  panelId,
  onSelect,
  onClose,
  onFocusTab,
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
      data-active={isActive}
      className={cn(
        // Content-width, like every other tab strip in the app and every browser's. An
        // earlier version stretched tabs to equal shares of the strip, which at one lane
        // made a full-width session bar the owner did not want. Tabs may shrink when the
        // strip is tight — three lanes at the 320px minimum — and `TabLabel` above keeps
        // the identifying numeral out of the part that gives way.
        "session-tab group relative flex items-center min-w-0 shrink",
        "rounded-[var(--radius-sm)] transition-colors duration-150 ease-out",
        // `overlay-raised` is the app's selection fill — the same one a palette row and
        // a highlighted menu item wear. It cannot carry the signal alone; the rail below
        // it is what meets WCAG 1.4.11. Drawn for the only lane too: nothing else in the
        // app withholds its selected state at a single item, and with a content-width
        // chip the rail is a mark on a tab rather than a second bottom border.
        isActive ? "bg-overlay-raised" : "hover:bg-overlay-subtle"
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
        // How the strip finds one lane without holding a ref to every chip.
        data-slot={tab.slot}
        aria-selected={isActive}
        aria-controls={panelId}
        // Roving tabindex: the strip is ONE tab stop, and the stop follows the last tab
        // the arrow keys reached rather than staying pinned to the selected one. Those
        // are different lanes under manual activation, which is the whole point.
        tabIndex={hasTabStop ? 0 : -1}
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
        onFocus={() => onFocusTab(tab.slot)}
        className={cn(
          // `pl-2` against the strip's own `px-1` puts this tab's first ink at 12px — the
          // same column the header's Daintree mark starts in, one row up.
          //
          // `pr-1` is not symmetry — it is the inset focus ring's clearance. The ring is
          // drawn 1px inside this button and is 2px thick, so with no right padding it
          // painted over the label's last character, which on a `Session N` label is the
          // only character that identifies the lane.
          "flex items-center gap-1.5 min-w-0 pl-2 pr-1 py-1",
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
        // Pointer-only, and deliberately so — but not because the two cannot coexist.
        // `Panel/TabButton.tsx` runs a roving tabindex WITH a focusable close, so that
        // was never the constraint. Two things make this the better trade here: a
        // focusable control inside a `tab` is the nesting ARIA forbids, which is what
        // that family is doing; and each extra stop is one more thing between the header
        // and the terminal, six of them at three lanes, on a panel people tab through all
        // day. So the tab is the sole focus target and closing moves to `Delete`, which
        // the tablist handles and `aria-keyshortcuts` announces.
        //
        // Both attributes are load-bearing and neither is decoration. `tabIndex={-1}`
        // keeps it out of the sequence AND out of axe's nested-interactive rule, which
        // keys on focusability. `aria-hidden` is what keeps `aria-required-children`
        // satisfied: a `tablist` may only own `tab` elements, this button is a sibling
        // of one rather than a descendant (nesting a button inside a button is invalid
        // HTML), and hiding it is what removes it from the tablist's owned set instead
        // of leaving a stray `button` child there.
        //
        // The cost is real and worth naming: closing a session here now works differently
        // from closing a panel, dock or portal tab elsewhere in the app.
        tabIndex={-1}
        aria-hidden="true"
        // A click would otherwise focus this button on its way to removing it, and focus
        // on a node that then unmounts falls to the document body. Refusing the focus at
        // mousedown leaves it wherever it was, which for the selected lane is the tab
        // beside this control.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onClose(tab.slot)}
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

function NativeSessionTabChip(props: SessionTabChipProps) {
  const agentState = useStore(assistantStoreForSlot(props.tab.slot), selectAssistantLaneState);
  return <SessionTabChip {...props} agentState={agentState} />;
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
 * A close asked for from the keyboard, and where focus should land when it happens.
 *
 * Closing a lane with a live agent raises a confirm dialog first, so an arbitrary
 * amount of time passes between the ask and the commit — and `tabs` is rebuilt on every
 * `agentState` transition, not only on a close. So the record names the lane being
 * closed, not just where to go: the effect that spends it waits for THAT lane to be
 * absent, which is the only signal that distinguishes the close landing from any other
 * reason the array changed.
 *
 * `closingWasActive` decides where "where to go" is. Closing a background lane leaves
 * the selection alone, so its positional neighbour is the right place. Closing the
 * ACTIVE lane makes the store pick a new active lane — the lowest remaining slot, not
 * the neighbour — and focus has to follow the selection there, or the ring lands on one
 * session while the body shows another.
 */
interface PendingCloseFocus {
  closingSlot: number;
  successorSlot: number;
  closingWasActive: boolean;
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
 * Tabs are content-width and sit at the leading edge with the new-session control
 * directly after the last one, which is how the panel, dock and portal strips in this
 * app lay out and how a browser does. The tablist scrolls horizontally if it ever has
 * to; at the current ceiling of three lanes it cannot, and a raised ceiling would find
 * the machinery already there rather than tabs clipped off the end.
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
   * Which lane currently owns the strip's single tab stop.
   *
   * This is the half of "roving tabindex" that is easy to leave out, and leaving it out
   * looks correct: arrow keys move focus either way. What it costs is the return trip —
   * with the stop pinned to the SELECTED lane, tabbing away and back drops you on the
   * selected tab rather than the one you had arrowed to, so the arrow keys' effect
   * silently evaporates every time focus leaves the panel.
   *
   * Held as a slot rather than an index because a slot survives a lane closing. The
   * derivation below falls back to the selected lane whenever the remembered one is gone,
   * which is what makes closing a lane self-healing rather than something to clean up
   * after.
   */
  const [focusedSlot, setFocusedSlot] = useState<number | null>(null);
  const rovingSlot =
    focusedSlot !== null && tabs.some((t) => t.slot === focusedSlot) ? focusedSlot : activeSlot;

  const pendingCloseFocusRef = useRef<PendingCloseFocus | null>(null);

  /**
   * Move focus to one lane by DOM query rather than by holding a ref per tab. One ref on
   * the container does the same job, and a ref handed down to a subcomponent as a prop is
   * a silent React Compiler bailout in this repo.
   */
  const focusSlot = useCallback((slot: number) => {
    // The stop itself is moved by the tab's own `onFocus` rather than from here, so that
    // a pointer click, a Tab from outside and an arrow press all update it by the same
    // route instead of three.
    listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-slot="${slot}"]`)?.focus();
  }, []);

  const focusTabAt = useCallback(
    (index: number) => {
      if (tabs.length === 0) return;
      // Wrap, which is what the pattern specifies for a horizontal tablist.
      const wrapped = ((index % tabs.length) + tabs.length) % tabs.length;
      const slot = tabs[wrapped]?.slot;
      if (slot !== undefined) focusSlot(slot);
    },
    [tabs, focusSlot]
  );

  /**
   * Land focus on the lane that replaced the closed one, after React has committed.
   *
   * Focusing inline in the key handler focused the element that was about to be removed:
   * `onClose` only asks, and the tab is still in the DOM until the next commit, so the
   * ring landed on a node that then unmounted and focus fell to the document body. It has
   * to be a slot recorded before the close and resolved after it.
   */
  useEffect(() => {
    const pending = pendingCloseFocusRef.current;
    if (!pending) return;
    // The commit that matters is the one where the closing lane is GONE — not merely the
    // next time this array is rebuilt, which also happens whenever any lane changes state.
    if (tabs.some((t) => t.slot === pending.closingSlot)) return;
    pendingCloseFocusRef.current = null;
    const target = pending.closingWasActive ? activeSlot : pending.successorSlot;
    if (tabs.some((t) => t.slot === target)) focusSlot(target);
  }, [tabs, activeSlot, focusSlot]);

  /**
   * Take the tab stop, and stand down a pending close if this is the lane it was for.
   *
   * A cancelled confirm dialog hands focus back to the control it was opened from, so
   * focus arriving on the closing lane is the signal that the close is not happening.
   * Without this the handoff would sit armed indefinitely and fire on some later close of
   * that same lane — one the user might have made with the pointer, where focus should
   * have stayed where it was.
   */
  const handleTabFocus = useCallback((slot: number) => {
    if (pendingCloseFocusRef.current?.closingSlot === slot) pendingCloseFocusRef.current = null;
    setFocusedSlot(slot);
  }, []);

  /**
   * A pointer close supersedes any keyboard close still waiting on its dialog. The
   * pointer left focus where it was, so there is nothing to hand off, and an armed
   * record from an earlier, cancelled keyboard close must not fire on this one.
   */
  const handlePointerClose = useCallback(
    (slot: number) => {
      pendingCloseFocusRef.current = null;
      onClose(slot);
    },
    [onClose]
  );

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
          // Name the successor by slot BEFORE asking for the close: the lane that will
          // occupy this position afterwards is the one behind it, or the one in front
          // when this is the last. Nothing is armed when this is the only lane — there is
          // no successor, and the panel closes with it.
          const successorSlot = tabs[current + 1]?.slot ?? tabs[current - 1]?.slot;
          pendingCloseFocusRef.current =
            successorSlot === undefined
              ? null
              : { closingSlot: tab.slot, successorSlot, closingWasActive: tab.slot === activeSlot };
          onClose(tab.slot);
          break;
        }
        default:
          break;
      }
    },
    [tabs, activeSlot, onClose, focusTabAt]
  );

  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5 px-1 py-1 border-b border-border-default shrink-0">
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
        // three lanes the tabs shrink before they overflow. Should the ceiling rise,
        // tabs past the edge stay reachable — arrow keys move focus, and focus scrolls
        // its target into view. The scrollbar is hidden because a scrollbar inside a
        // 33px strip is louder than the tabs it scrolls; keyboard and trackpad still
        // scroll it.
        className="flex items-stretch gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const Chip = tab.native ? NativeSessionTabChip : SessionTabChip;
          return (
            <Chip
              key={tab.slot}
              tab={tab}
              agentState={tab.agentState}
              isActive={tab.slot === activeSlot}
              hasTabStop={tab.slot === rovingSlot}
              tabId={helpSessionTabId(idBase, tab.slot)}
              panelId={panelId}
              onSelect={onSelect}
              onClose={handlePointerClose}
              onFocusTab={handleTabFocus}
            />
          );
        })}
      </div>
      {/* The one way to another session, directly after the last tab where a tab set
          keeps it, drawn with the glyph that means "one more of these". It used to be a
          `Columns2` mark placed here to avoid colliding with a "+" in the header that
          restarted the current conversation instead — two controls a row apart, one of
          them findable, both of them looking like they added something. The header's is
          gone, so this can be the plus it always should have been.

          Parked rather than removed at the ceiling: a control that vanishes takes its
          own explanation with it. */}
      {onOpenSession && (
        <button
          type="button"
          onClick={canOpenSession ? onOpenSession : undefined}
          // `aria-disabled`, not `disabled`. A truly disabled button is removed from the
          // tab order and stops firing pointer events, which takes its `title` with it —
          // so the one state that has something to explain would have been the one state
          // that could not explain it. This keeps the control focusable and hoverable,
          // announces the state, and drops the handler instead.
          aria-disabled={!canOpenSession || undefined}
          className={cn(
            "w-6 h-6 inline-flex items-center justify-center shrink-0",
            "rounded-[var(--radius-sm)] text-text-secondary",
            "transition-colors duration-150 ease-out",
            canOpenSession
              ? "hover:text-text-primary hover:bg-overlay-subtle"
              : "opacity-40 cursor-default",
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
