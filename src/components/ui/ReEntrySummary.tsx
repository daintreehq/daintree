import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { FLOATING_CARD_RADIUS_CLASS } from "@/components/ui/floatingSurface";
import { useUIStore } from "@/store/uiStore";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useTruncationDetection } from "@/hooks/useTruncationDetection";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import { navigateToNotificationSource } from "@/components/Notifications/notificationNavigation";
import type { ReEntrySummaryState, SummaryRow } from "@/hooks/useReEntrySummary";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";

export const AUTO_DISMISS_MS = 8000;

const SEVERITY_CLASS: Record<NotificationHistoryEntry["type"], string> = {
  error: "text-status-error",
  warning: "text-status-warning",
  info: "text-status-info",
  success: "text-status-success",
};

export function ReEntrySummary({ state }: { state: ReEntrySummaryState }) {
  const { visible, dismiss, entries, rows, overflowCount, shownAt } = state;
  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: visible,
    animationDuration: getUiTransitionDuration("exit"),
  });
  const [isPaused, setIsPaused] = useState(false);
  const [isFocusInside, setIsFocusInside] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Where focus was before it entered the card, so an explicit dismissal hands
  // it back instead of letting `inert` drop it on document.body.
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Identity of the summary being shown. Entry ids are unique and a dismissed
  // batch is never re-summarized, so this changes exactly when a new summary
  // arrives — unlike the entry count or the worktree-id list, which collide
  // when the same worktrees report again and would leave a replacement summary
  // inheriting the previous one's pin and its already-half-elapsed timer.
  const entriesKey = entries.map((e) => e.id).join(",");

  useEffect(() => {
    if (visible) setIsPinned(false);
  }, [visible, entriesKey]);

  // Hover and focus pauses are transient: clear them once the card is gone.
  // onMouseLeave does not fire for a node removed out from under the pointer
  // (dismissing while hovering), the blur that `inert` causes is not something
  // to count on (jsdom has no inert focus fixup, Chromium runs it later), and
  // this component instance never unmounts — it just renders null — so a stuck
  // pause would silently disable auto-dismiss for every later summary. A card
  // brought back mid-exit, or a replacement summary whose rows took the
  // focused one away (removal fires no blur), takes its focus pause from where
  // focus really is.
  useEffect(() => {
    if (!shouldRender) {
      setIsPaused(false);
      setIsFocusInside(false);
      prevFocusRef.current = null;
      return;
    }
    setIsFocusInside(visible && !!cardRef.current?.contains(document.activeElement));
  }, [visible, shouldRender, entriesKey]);

  useEffect(() => {
    if (!visible || isPaused || isFocusInside || isPinned) return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, dismiss, isPaused, isFocusInside, isPinned, entriesKey]);

  // Escape and the dismiss button are dismissals made from inside the card, so
  // focus goes back where it came from. Ringless after a pointer press, as an
  // overlay closed by click restores (overlay-focus.md). Row selection and
  // "Open notifications" send focus somewhere new and are left alone.
  const dismissFromInside = (ringless: boolean) => {
    const card = cardRef.current;
    const prev = prevFocusRef.current;
    if (card?.contains(document.activeElement) && prev?.isConnected && !card.contains(prev)) {
      // The restored control's own tooltip would open on this focus.
      armTooltipFocusSuppression();
      prev.focus(ringless ? { preventScroll: true, focusVisible: false } : { preventScroll: true });
    }
    dismiss();
  };

  // Registered only while focus is inside: the card claims Escape from the
  // keyboard user working in it, and never takes the key from the rest of the
  // app (fallbacks such as voice dictation run only on an empty stack). Coming
  // in on focus also puts it above any toast already on the stack.
  useEscapeStack(visible && isFocusInside, () => dismissFromInside(false));

  // Latch the last visible content so the card keeps rendering the rows it had
  // while it slides out. `useReEntrySummary` returns EMPTY the instant `visible`
  // flips false, so without this the exit would animate a blank card — the same
  // bug ScrollIndicator solves for its count (#10316). State adjusted during
  // render, not a ref: React discards an abandoned concurrent render's state
  // update, so stale rows can't leak in.
  const [content, setContent] = useState({ rows, overflowCount, shownAt });
  if (
    visible &&
    (content.rows !== rows ||
      content.overflowCount !== overflowCount ||
      content.shownAt !== shownAt)
  ) {
    setContent({ rows, overflowCount, shownAt });
  }

  if (!shouldRender) return null;

  const {
    rows: displayRows,
    overflowCount: displayOverflowCount,
    shownAt: displayShownAt,
  } = content;
  const hasUrgent = displayRows.some(
    (r) => r.highlight.type === "error" || r.highlight.type === "warning"
  );
  // Only the excursion gets a hue. A green rule here would just be saying no
  // entry was urgent, which is the good case already implied by the rows (#12002).
  const accentClass = hasUrgent ? "border-l-status-warning" : "border-l-border-default";

  const handleOpenNotifications = () => {
    useUIStore.getState().openNotificationCenter();
    state.dismiss();
  };

  // The row goes where its highlighted entry came from, as the inbox's own
  // rows do. One with nowhere live to land (the app, the project itself, a
  // worktree removed while you were away) opens the inbox, which holds it.
  // Dismissed first: a summary that replaced this one mid-navigation must not
  // be dismissed by the old click.
  const handleRowClick = (row: SummaryRow) => {
    state.dismiss();
    void navigateToNotificationSource(row.highlight.context)
      .catch(() => false)
      .then((arrived) => {
        if (!arrived) useUIStore.getState().openNotificationCenter();
      });
  };

  return createPortal(
    <div
      className="fixed top-3 z-[var(--z-toast)] flex flex-col gap-3 w-full max-w-[380px] pointer-events-none p-4"
      style={{ right: "calc(var(--right-obstruction-offset, 0px))" }}
    >
      <div
        className={cn(
          // Anchored at top-3, so the card overlaps the toolbar's drag band
          // and its Pin/Dismiss controls are swallowed as window drags. The
          // opt-out goes here, not on the pointer-events-none wrapper (#12347).
          "app-no-drag",
          "relative flex flex-col w-full max-w-[360px]",
          // The severity edge must follow `border`: cn() resolves conflicts
          // last-wins, and a later `border` erases a left width set before it.
          FLOATING_CARD_RADIUS_CLASS,
          "border border-border-default border-l-[3px]",
          "bg-surface-panel/85 backdrop-blur-xl",
          "px-3 py-2.5 pr-2",
          "text-sm text-text-primary",
          "shadow-[var(--theme-shadow-floating)]",
          // Tailwind v4 translate-* emits the individual `translate` property,
          // which `transform` in a transition list does NOT cover — list it
          // explicitly or the slide snaps and only the fade animates.
          "transition-[translate,opacity]",
          "motion-reduce:transition-opacity motion-reduce:translate-none",
          isVisible
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-8 opacity-0",
          accentClass
        )}
        style={{
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
        // Real inertness while sliding out: pointer-events alone still lets a
        // Tab/Enter land on the fading card's buttons. `inert` also blurs the
        // focused dismiss button for us — aria-hidden would not, and Chromium
        // blocks aria-hidden over a focused element. Keyed on the incoming
        // `visible`, not `isVisible`: the latter is also false for the hidden
        // entry frame, and inert there would drop this role="status" live
        // region out of the a11y tree exactly as it's inserted.
        inert={!visible}
        role="status"
        ref={cardRef}
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onFocus={(e) => {
          // An unknown origin (the window regaining focus, a press on an
          // unfocusable spot) keeps the origin already known for this showing.
          const from = e.relatedTarget;
          if (from instanceof HTMLElement && !e.currentTarget.contains(from)) {
            prevFocusRef.current = from;
          }
          setIsFocusInside(true);
        }}
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (!(to instanceof Node) || !e.currentTarget.contains(to)) setIsFocusInside(false);
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="font-medium leading-tight tracking-tight text-xs text-text-primary">
            While you were away
          </h4>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setIsPinned((p) => !p)}
              // A toggle's name stays put; `pressed` announces the state.
              aria-label="Pin summary"
              pressed={isPinned}
              className="[&_svg]:size-3.5"
            >
              <Pin aria-hidden="true" className={cn(isPinned && "fill-current")} />
            </Button>
            <DismissButton
              onClick={(e) => dismissFromInside(e.detail > 0)}
              aria-label="Dismiss summary"
              tooltipClassName="z-[var(--z-toast-overlay)]"
            />
          </div>
        </div>

        <ul className="mt-1.5 space-y-0.5">
          {displayRows.map((row) => (
            <ReEntrySummaryRow
              key={row.key}
              row={row}
              now={displayShownAt}
              disclosureDisabled={!visible}
              onSelect={handleRowClick}
            />
          ))}
          {displayOverflowCount > 0 && (
            <li>
              <button
                type="button"
                onClick={handleOpenNotifications}
                className={cn(
                  "flex items-center w-full min-h-6 text-left text-xs tabular-nums",
                  "rounded-[var(--radius-xs)] px-0.5 py-0.5 -mx-0.5",
                  "text-text-secondary hover:text-text-primary hover:bg-overlay-subtle",
                  "transition-colors duration-150",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                +{displayOverflowCount} more
              </button>
            </li>
          )}
        </ul>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {/* Neutral, like the toast's primary action: the card's edge carries
              severity, and a status-tinted label is only contrast-gated at 3:1. */}
          <Button
            variant="outline"
            size="sm"
            data-notification-action="primary"
            onClick={handleOpenNotifications}
          >
            Open notifications
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function ReEntrySummaryRow({
  row,
  now,
  disclosureDisabled,
  onSelect,
}: {
  row: SummaryRow;
  now: number;
  disclosureDisabled: boolean;
  onSelect: (row: SummaryRow) => void;
}) {
  const label = useTruncationDetection();
  const title = useTruncationDetection();
  // The toaster's and the inbox's glyphs, so an entry keeps its shape as it
  // moves between the three surfaces that show it.
  const type = row.highlight.type;
  const Icon = SEVERITY_GLYPH[type];
  return (
    <li>
      {/* One disclosure for the row, on the button itself: it opens on hover
          and on keyboard focus without adding a tab stop per cut-off span. */}
      <TruncatedTooltip
        content={
          // A name with no break opportunity would be clipped again by the
          // tooltip's own width.
          <span className="flex flex-col [overflow-wrap:anywhere]">
            <span className="font-medium">{row.label}</span>
            <span>{row.highlightTitle}</span>
          </span>
        }
        isTruncated={label.isTruncated || title.isTruncated}
        disabled={disclosureDisabled}
        contentClassName="z-[var(--z-toast-overlay)]"
      >
        <button
          type="button"
          onClick={() => onSelect(row)}
          className={cn(
            "flex items-center gap-1.5 w-full min-h-6 text-left text-xs",
            "rounded-[var(--radius-xs)] px-0.5 py-0.5 -mx-0.5",
            "hover:bg-overlay-subtle transition-colors duration-150",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
            type === "error" || type === "warning" ? "text-text-primary" : "text-text-secondary"
          )}
        >
          <Icon className={cn("h-3.5 w-3.5 shrink-0", SEVERITY_CLASS[type])} />
          <span ref={label.ref} className="font-medium truncate min-w-0">
            {row.label}
          </span>
          <span ref={title.ref} className="text-text-secondary truncate min-w-0">
            {row.highlightTitle}
          </span>
          {/* The highlighted entry's own time, not the row's latest: the
              line it sits on is that entry's. Told against when the
              summary was built, so no re-render (a hover, a pin) can
              change the text inside this live region. */}
          <TimeAgo
            timestamp={row.highlight.timestamp}
            now={now}
            className="ml-auto shrink-0 pl-1 text-text-secondary"
          />
        </button>
      </TruncatedTooltip>
    </li>
  );
}
