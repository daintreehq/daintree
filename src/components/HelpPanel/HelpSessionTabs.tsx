import { useId } from "react";
import { Columns2, X } from "lucide-react";
import { SpinnerCircle, HollowCircle, InteractingCircle } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { AgentState } from "@/types";

/**
 * Per-lane state marker (#12108).
 *
 * Same triad, same tokens AND the same 14px as the header's indicator, which
 * sits directly above this strip — only working, directing and waiting earn a
 * marker; idle and exited stay quiet. This is the whole reason the strip carries
 * state at all: the header can only speak for the lane on screen, so a
 * background session that has gone to `waiting` is otherwise invisible until the
 * user happens to switch to it.
 *
 * The size is load-bearing rather than cosmetic. These marks are read
 * peripherally, and at 12px the three silhouettes stopped being separable from
 * each other — a filled ring, a hollow ring and a gapped arc all collapse to
 * "small coloured dot", which leaves hue as the only carrier and fails exactly
 * the reader who most needs a second cue. 14px is also what the same three
 * glyphs already use one row up, so the panel had been drawing one vocabulary at
 * two sizes.
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
 * information and the last token carries all of it — and a plain `truncate`
 * removes them in exactly the wrong order. Three lanes at the panel's 320px
 * minimum leave about 50px for a 55px label, so this is not hypothetical: the
 * strip rendered "Sessio…" three times, which identifies nothing.
 *
 * Splitting at the LAST space rather than formatting a known shape keeps the
 * component honest about what it is given — it receives an opaque string, and a
 * label with no space simply truncates as before. The tail keeps its leading
 * space via `whitespace-pre` so the two halves read as one word pair.
 *
 * This is also what lets the spacing around it stay generous. Sizing the chrome
 * so that `Session N` exactly fits at 320px is a budget one wider system font
 * breaks; degrading to "Sessi… 1" is correct at any width on any platform.
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

interface HelpSessionTabsProps {
  tabs: HelpSessionTab[];
  activeSlot: number;
  onSelect: (slot: number) => void;
  onClose: (slot: number) => void;
  /**
   * Whether a lane is still free. Both of these are optional so the strip stays
   * renderable on its own, but they travel together: the trailing control only
   * appears when there is both somewhere to put a new lane and a handler to ask.
   */
  canOpenSession?: boolean;
  onOpenSession?: () => void;
}

/**
 * The parallel-session strip.
 *
 * Rendered only when a project has more than one assistant lane open, so a
 * single-session panel looks exactly as it did before lanes existed — the
 * common case pays nothing for the capability.
 *
 * No accent anywhere: the strip sits inside the assistant focus region, whose
 * one load-bearing accent is already spent on the focus ring. The selected tab
 * is marked the way every other neutral selection in the app is marked — an
 * `overlay-raised` fill, a `selection-outline` rail, and the primary text
 * colour at medium weight. Three coordinated signals rather than one, because
 * the fill is 4% additive on dark and cannot carry it alone: this strip
 * originally spent a 2% `overlay-subtle` chip and a font weight on the job, and
 * the two open sessions were genuinely hard to tell apart.
 *
 * The fill's job is to say "this chip", not "this chip is selected" — the rail
 * is what carries WCAG 1.4.11. Hover therefore has to sit BELOW the selected
 * fill rather than beside it: `overlay-soft` is 3% against the selected 4%, a
 * two-value difference at the same size and radius, so a hovered lane and the
 * open one were the same rectangle. `overlay-subtle` is half the selected fill,
 * which is a difference the eye can actually use.
 *
 * Tabs shrink rather than scroll. Three lanes at the panel's 320px minimum come
 * to roughly 325px of content, so `shrink-0` chips overflowed a container whose
 * `overflow-x-auto` had no scroll affordance — the third lane's close control
 * was simply off the end, invisible because it is transparent until hovered.
 * `min-w-0` plus the label's split makes that a few pixels of compression
 * instead. Nothing here can ever need real overflow machinery: there are at most
 * three lanes and every label is `Session N`.
 *
 * Deliberately a toggle-button group rather than the ARIA tabs pattern. Tabs
 * promise a roving tabindex with arrow-key navigation and one `tabpanel` per
 * tab; this strip drives a single shared body and keeps each lane's close
 * button in the tab order on purpose, so claiming `role="tab"` would announce
 * keyboard behaviour that isn't there. `aria-pressed` says exactly what is
 * true: one of these selectors is currently on.
 */
export function HelpSessionTabs({
  tabs,
  activeSlot,
  onSelect,
  onClose,
  canOpenSession = false,
  onOpenSession,
}: HelpSessionTabsProps) {
  // Before the early return: hooks cannot sit behind a conditional, and the
  // strip's own `tabs.length < 2` bail is one.
  const stateIdBase = useId();
  if (tabs.length < 2) return null;

  return (
    <div
      role="group"
      aria-label="Assistant sessions"
      className="flex items-stretch gap-0.5 px-1 py-1 border-b border-border-default shrink-0"
    >
      {tabs.map((tab) => {
        const isActive = tab.slot === activeSlot;
        const stateId = `${stateIdBase}-state-${tab.slot}`;
        return (
          <div
            key={tab.slot}
            // `session-tab` is not styling — it is the handle for the selected
            // tab's rail and its forced-colors fallback, both in `index.css`.
            // `relative` because the rail is a `::after` positioned against this
            // element, and `data-active` because the mark belongs to the whole
            // chip while `aria-pressed` belongs to the selector inside it.
            data-active={isActive}
            className={cn(
              "session-tab group relative flex items-center min-w-0 shrink",
              "rounded-[var(--radius-sm)] transition-colors duration-150 ease-out",
              // `overlay-raised` is the app's selection fill — the same one a
              // palette row and a highlighted menu item wear. It replaced
              // `overlay-subtle`, which is 2% and was the whole of why the
              // selected session was unreadable. It still cannot carry the
              // signal alone; the rail below it is what does.
              isActive ? "bg-overlay-raised" : "hover:bg-overlay-subtle"
            )}
          >
            <button
              type="button"
              aria-pressed={isActive}
              // Stated, not derived. The visible label is split across two spans so
              // its identifying tail cannot truncate, and the accessible-name
              // algorithm trims each element's own contribution before joining
              // them — which silently turned "Session 1" into "Session1" for every
              // screen reader. The name is not a presentation detail and must not
              // depend on how the text is broken up to fit.
              aria-label={tab.label}
              // The state reaches assistive tech as a DESCRIPTION, not as part of
              // the name. Stating the name above was necessary — the split label
              // computed as "Session1" — but an explicit label on a button also
              // overrides everything inside it, which silently took the marker's
              // "working" / "waiting" / "directing" away from exactly the reader
              // who cannot see the glyph. The marker is decorative now and this
              // carries the meaning, so the name stays exactly `Session N` and the
              // state is announced after it.
              aria-describedby={tab.agentState ? stateId : undefined}
              onClick={() => onSelect(tab.slot)}
              className={cn(
                // `pl-2` against the strip's own `px-1` puts this tab's first ink
                // at 12px — the same column the header's Daintree mark starts in,
                // one row up. At `pl-2` inside `px-2` the strip began 4px inboard
                // of the header and the two bars shared no left edge.
                //
                // The rest of the spacing here is cut to the bone on purpose, and
                // the constraint is the 320px minimum panel width: three lanes,
                // three 24px close targets and three 14px markers leave about 55px
                // for each label, which is what `Session N` measures. Every pixel
                // spent on padding here comes straight out of the label.
                //
                // `pr-1` is not symmetry — it is the inset focus ring's clearance.
                // The ring is drawn 1px inside this button and is 2px thick, so
                // with no right padding it painted straight over the label's last
                // character, which on a `Session N` label is the only character
                // that identifies the lane.
                "flex items-center gap-1.5 min-w-0 pl-2 pr-1 py-1",
                "text-xs rounded-[var(--radius-sm)] transition-colors duration-150 ease-out",
                // Inset, unlike every other ring in this panel. The chip is 24px
                // in a strip whose padding is 4px, so an outset 2px ring at a 2px
                // offset measured exactly 32px — flush against the header's
                // hairline above and the body's below, with nothing between them,
                // and on the first tab it also sat 2px off the panel's own edge.
                // Drawn inside, it reads as a ring on the selector instead of a
                // second divider.
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-1",
                isActive
                  ? "text-text-primary font-medium"
                  : "text-text-secondary group-hover:text-text-primary"
              )}
            >
              <TabStateIndicator agentState={tab.agentState} />
              {/* No `max-w`. The old `max-w-[10rem]` was 160px against a label that
                  is always `Session N` and never exceeds 57px, so it could not
                  fire; what the label actually needs is to give way when three
                  lanes meet the 320px minimum, which is a min-width problem, not a
                  max-width one. */}
              <TabLabel label={tab.label} />
            </button>
            <button
              type="button"
              onClick={() => onClose(tab.slot)}
              // Always in the DOM so the control is reachable by keyboard and
              // by assistive tech; only its paint is gated. Shown outright on
              // the selected tab — that is the session you would close, and a
              // control the pointer has to go looking for is one most people
              // never find — and hover/focus-gated on the rest, which keeps a
              // strip of three from reading as a row of dismiss buttons.
              className={cn(
                // 24x24, the WCAG 2.2 SC 2.5.8 floor, reached by growing the BOX
                // and leaving the 12px glyph alone. It was a 16px target — `p-0.5`
                // around that same glyph — butted directly against the selector,
                // so the spacing exception did not apply either and a miss opened
                // the lane you were trying to close. The chip is exactly 24px
                // tall, so this costs height nothing.
                "w-6 h-6 inline-flex items-center justify-center shrink-0",
                "rounded-[var(--radius-sm)] text-text-secondary",
                isActive
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                "hover:text-text-primary hover:bg-tint/8 transition-[opacity,color,background-color] duration-150 ease-out",
                // Inset for the same reason as the selector's, and for one more:
                // an outset ring on a control this close to the label overlapped
                // the label's last character.
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-1"
              )}
              aria-label={`Close ${tab.label}`}
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
            {tab.agentState && (
              <span id={stateId} className="sr-only">
                {tab.agentState}
              </span>
            )}
          </div>
        );
      })}
      {/* The way to a third lane, at the edge a tab strip conventionally keeps it.
          It lived only in the header's overflow menu, two clicks behind an
          ellipsis, while the header's visible "+" — which restarts THIS
          conversation rather than opening another — sat in plain sight above it.
          The two are easy to confuse and only one of them was findable.

          `Columns2`, not a second plus: the overflow menu already draws this
          action with that glyph, and two pluses eight pixels apart meaning
          different things is the confusion this is meant to remove, not spread.

          Rendered only while a lane is free, which is also what keeps the width
          honest — the strip is tightest at three lanes, and at three lanes this
          control is gone. */}
      {canOpenSession && onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className={cn(
            "ml-0.5 w-6 h-6 inline-flex items-center justify-center shrink-0 self-center",
            "rounded-[var(--radius-sm)] text-text-secondary",
            "hover:text-text-primary hover:bg-overlay-subtle transition-colors duration-150 ease-out",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-1"
          )}
          aria-label="Open parallel session"
          title="Open another session beside this one"
        >
          <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
