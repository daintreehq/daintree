import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ListChecks, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantQuestion } from "@/store/assistantStore";

/**
 * The multiple-choice sheet — the panel's answer to `question:requested`.
 *
 * ## Where it sits, and why that changed
 *
 * It used to REPLACE the composer, because the engine has parked a tool dispatch and
 * nothing typed could reach it. That reasoning is still right about the composer being
 * unusable; it was wrong about removing it. Pulling the tallest element out of the
 * bottom strip moved every control under it, so answering a question made the panel's
 * whole lower edge jump twice — once when the sheet arrived and once when it left — and
 * the surface a user was about to type into simply was not where they left it.
 *
 * So the sheet sits ABOVE the composer and the composer stays, DISABLED. The invariant
 * survives (there is still no way to type at an engine that cannot read), the layout
 * holds still, and the thing that is blocked is visibly the thing that is blocked rather
 * than absent with no explanation.
 *
 * ## The accelerators, and why they are conditional
 *
 * The engine assigns each option a LETTER (A, B, C…) and that letter travels on the
 * wire, into the transcript, and into what the model is told the user chose. It is the
 * option's identity, so it is what the badge shows — and it covers all 26 options a
 * question may carry, where digits would run out at nine.
 *
 * On a SHORT list both the letter and its 1-based position answer on a single keypress,
 * which is what a picker of five things wants. On a long one a filter box appears, and
 * then plain keys type into it: a question whose options are ports or branch names is
 * exactly where "8" meaning "answer option 8" would fire on the first character of a
 * search and commit an answer nobody chose. Accelerators and free text cannot share the
 * same keys, so the list length decides which of the two it gets, and the footer says
 * which is live.
 *
 * ## Dismissing
 *
 * Dismissing is a real outcome, not a cancel: the engine reports it to the model as the
 * user having declined to answer, which is a different thing from the turn being
 * abandoned. There is deliberately no way to answer on the user's behalf — a question
 * that times out cancels rather than taking its own default.
 */

export interface AssistantQuestionCardProps {
  question: AssistantQuestion;
  /**
   * Answers the question; `index` of -1 dismisses without choosing.
   *
   * Reports whether the answer was ACCEPTED for delivery, synchronously or as a promise.
   * The sheet latches on the first answer so a double-click cannot send two, and stays
   * on screen until the engine confirms it; if the answer never left — no session, a
   * refused IPC — that latch would strand a live sheet that ignores every retry until
   * the question times out.
   */
  onAnswer: (questionId: string, index: number) => boolean | Promise<boolean>;
}

/**
 * The option count at which the sheet stops being a list and starts being a search.
 *
 * Five is what fits in one glance. Below the threshold a filter box would be chrome over
 * a list you can already read, and it would cost the single-key accelerators for
 * nothing; at or above it, arrowing through two dozen options is the worse deal.
 */
const FILTER_THRESHOLD = 6;

/** One option, with its position in the ORIGINAL list — the index the engine answers to. */
interface Row {
  index: number;
  label: string;
  text: string;
}

/**
 * Every whitespace-separated term must appear somewhere in the option.
 *
 * Substring rather than fuzzy, on purpose. A fuzzy matcher scores, and a scored list
 * REORDERS itself as you type — under a keyboard cursor that is how the row you were
 * about to press Enter on becomes a different row. Order here is the engine's order,
 * always, and typing only ever removes rows from it.
 */
function matches(row: Row, query: string): boolean {
  const haystack = `${row.label} ${row.text}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => !term || haystack.includes(term));
}

export function AssistantQuestionCard({ question, onAnswer }: AssistantQuestionCardProps) {
  const [query, setQuery] = useState("");
  /**
   * The engine's own starting highlight, clamped.
   *
   * Out of range is a bug on the far side of the wire and the sheet still has to be
   * answerable: a cursor past the end highlights nothing, so Enter — the fastest key
   * here — either does nothing or answers with an index the engine will reject.
   *
   * Seeded ONCE, from the initializer. The sheet's whole state is per-question, and the
   * call site keys this component on the question id, so a new question is a new
   * component rather than an old one being reset field by field. That is what keeps the
   * answered-once latch honest: a reset written as an effect runs after the new
   * question has already rendered with the old latch still closed.
   */
  const [cursor, setCursor] = useState(() =>
    Math.min(Math.max(question.defaultIndex, 0), Math.max(question.options.length - 1, 0))
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const domId = useId();

  const filtering = question.options.length >= FILTER_THRESHOLD;

  const rows = useMemo<Row[]>(
    () => question.options.map((o, index) => ({ index, label: o.label, text: o.text })),
    [question.options]
  );
  const visible = useMemo(
    () => (query.trim() ? rows.filter((r) => matches(r, query.trim())) : rows),
    [rows, query]
  );

  /**
   * One answer per sheet, enforced with a ref.
   *
   * The sheet does not disappear when you answer it — the answer goes to the engine and
   * the sheet is removed when `question:answered` comes back. That is the correct order
   * (the panel must not claim a decision the engine has not acknowledged) but it leaves
   * a live sheet on screen for a round trip, with every control still working: a
   * double-click sends the same answer twice, and Escape immediately after clicking an
   * option DISMISSES a question that was already answered.
   *
   * A ref because it must take effect inside the same event, before any re-render, and
   * because nothing renders from it — the sheet keeps its appearance while it waits, so
   * the answer does not look like it went missing.
   */
  const answeredRef = useRef(false);

  /**
   * The option whose answer is in flight, or null.
   *
   * RENDERED, unlike the latch beside it. The latch alone froze delivery and nothing
   * else: arrows and hover still moved the highlight, the filter still took text, every
   * control still looked live, and the extra answers were swallowed in silence — so the
   * sheet could sit there showing option B highlighted while option A was the answer
   * being applied. A decision surface must not misreport the decision it has taken.
   */
  const [submitted, setSubmitted] = useState<number | "dismiss" | null>(null);

  const answer = useCallback(
    (index: number) => {
      if (answeredRef.current) return;
      // Closed BEFORE the call and reopened only if delivery failed. Closing after would
      // leave a window a second click fits through, which is the whole failure this
      // guards; and it stays closed for the WHOLE round trip, so the clicks that land
      // while delivery is still in flight are swallowed rather than queued behind it.
      answeredRef.current = true;
      // A DISMISSAL freezes it too. It is a decision with a round trip of its own —
      // acceptance and the engine's `question:answered` are separate events — so between
      // them the sheet would otherwise sit there looking answerable, swallowing every
      // further action in silence. It claims no row while it does (see `shown`), because
      // the answer is "none of them".
      setSubmitted(index >= 0 ? index : "dismiss");
      void (async () => {
        let delivered = false;
        try {
          delivered = await onAnswer(question.questionId, index);
        } catch {
          // A throwing handler is a failed answer like any other. Caught rather than
          // left to `finally` alone: without this the rejection escapes as an unhandled
          // one, which in Electron is a console error at best and a crash report at
          // worst — for a case whose entire remedy is the line below.
          delivered = false;
        } finally {
          if (!delivered) {
            answeredRef.current = false;
            setSubmitted(null);
          }
        }
      })();
    },
    [onAnswer, question.questionId]
  );

  /**
   * The sheet takes focus when it appears — but only from inside the assistant.
   *
   * It takes it at all because it is the only thing that can be acted on, and single-key
   * controls that work solely after you happen to click the card are controls most
   * people never find. The filter box takes it when there is one, so typing goes where
   * the footer says it does.
   *
   * It takes it CONDITIONALLY because a question is asynchronous: the model can ask
   * thirty seconds into a turn, by which time the user may be typing in a terminal or
   * another pane. Grabbing the keyboard from there is bad on its own and worse here —
   * on a short list the very next character they type is an accelerator, so a stolen
   * focus turns an ordinary keystroke into an answer to a question they have not read.
   *
   * Mount-only, because the call site keys this component on the question id: a new
   * question mounts a new sheet rather than re-running a reset over a live one.
   */
  useEffect(() => {
    const surface = cardRef.current?.closest("[data-assistant-surface]");
    if (!surface?.contains(document.activeElement)) return;
    (filtering ? filterRef.current : listRef.current)?.focus();
  }, [filtering]);

  /**
   * The cursor always names a VISIBLE row.
   *
   * Filtering can remove the row under it, and an index into a list that no longer has
   * that row is how Enter answers something the user cannot see. Clamped on every change
   * to the visible set rather than while filtering, so the same rule covers a question
   * whose options arrive in more than one frame.
   */
  useEffect(() => {
    setCursor((c) => (visible.some((r) => r.index === c) ? c : (visible[0]?.index ?? -1)));
  }, [visible]);

  // Keyboard navigation must scroll, or the cursor walks off the bottom of a list that
  // is taller than its box and the sheet looks frozen. `nearest` so a click, which
  // already scrolled the row into view, does not jerk the list a second time.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  /**
   * Whether the pointer is the thing currently moving.
   *
   * Hover moves the cursor, which is right for a mouse and wrong for a keyboard: arrowing
   * down a list under a stationary pointer fires `mouseenter` the moment a row slides
   * beneath it, and the cursor snaps back to wherever the mouse happens to be sitting.
   * A ref rather than state — nothing renders from it, and it has to be true within the
   * same event that reads it.
   */
  const pointerLive = useRef(false);

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => {
        if (visible.length === 0) return c;
        const at = visible.findIndex((r) => r.index === c);
        const next = Math.min(Math.max((at < 0 ? 0 : at) + delta, 0), visible.length - 1);
        return visible[next]!.index;
      });
    },
    [visible]
  );

  /**
   * Takes the highlighted option, checked against what is ON SCREEN.
   *
   * The clamp effect keeps the cursor and the visible set in step, but it is an effect:
   * it runs after the render that removed a row, and a keystroke is not a scheduler.
   * Reading `visible` here means the sheet answers with a row the user can see or with
   * nothing — never with an option the filter had already ruled out, which is the one
   * wrong answer this surface can give silently.
   */
  const answerVisible = useCallback(() => {
    if (visible.some((r) => r.index === cursor)) answer(cursor);
  }, [answer, cursor, visible]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A modified key is someone else's: copy, the app's own bindings, a text-editing
      // shortcut inside the filter box.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // A key pressed on the sheet's OWN buttons belongs to those buttons.
      //
      // Dismiss is a tab stop, and this handler sits above it: Enter there bubbled here,
      // was preventDefault-ed before the browser could activate the button, and answered
      // the highlighted option instead. On `/backend` that turned a focused control
      // reading "Dismiss" into a persisted backend choice. Option rows are excluded from
      // the exclusion — they are buttons too, but they are not tab stops and their own
      // activation is the click path, not this one.
      const control = e.target instanceof HTMLElement ? e.target.closest("button, a, input") : null;
      const onOwnButton =
        control !== null &&
        control.getAttribute("role") !== "option" &&
        control.tagName !== "INPUT";
      // ONLY the keys a button natively owns. Escape has no native button behaviour, so
      // handing every key over deleted the sheet's own two-stage Escape for anyone who
      // had tabbed to Dismiss — the one place a keyboard user is most likely to be.
      if (onOwnButton && (e.key === "Enter" || e.key === " ")) return;

      // Everything below is a decision, and the decision has already been made: the
      // answer is in flight and this sheet is read-only until it settles.
      if (submitted !== null) {
        if (e.key !== "Escape") e.preventDefault();
        return;
      }
      pointerLive.current = false;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          return;
        case "Home":
        case "End":
          // The LIST's ends, but only when the list owns the keyboard. In a filter box
          // these are the caret's own keys — jump to the start or end of what you typed
          // — and taking them makes an ordinary text field behave unlike every other
          // one, for a list the arrows already reach both ends of.
          if (filtering) return;
          e.preventDefault();
          move(e.key === "Home" ? -visible.length : visible.length);
          return;
        case " ":
          // Space takes the highlighted option, as a listbox is expected to. Only when
          // the LIST owns the keyboard: in the filter box it is a space character, and
          // a search field that cannot type one is broken in a way nobody would guess.
          if (filtering) return;
          // Before answering: Space is the page's scroll key, and a listbox that both
          // selects and scrolls on it jumps under the answer being given.
          e.preventDefault();
          answerVisible();
          return;
        case "Enter":
          e.preventDefault();
          answerVisible();
          return;
        case "Escape":
          e.preventDefault();
          // Two-stage, the same order the composer below resolves its own Escapes in:
          // the narrowest live meaning first. A filter with something in it is a state
          // the user put the sheet into, and clearing it is what "get back" means there;
          // only an already-clear sheet is dismissed.
          if (query) setQuery("");
          else answer(-1);
          return;
      }

      // Below here are the single-key accelerators, which exist only when there is no
      // filter box to compete with. See the header comment.
      if (filtering || e.key.length !== 1) return;
      const digit = Number.parseInt(e.key, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= visible.length) {
        e.preventDefault();
        answer(visible[digit - 1]!.index);
        return;
      }
      const byLabel = visible.find((r) => r.label.toLowerCase() === e.key.toLowerCase());
      if (byLabel) {
        e.preventDefault();
        answer(byLabel.index);
      }
    },
    [answer, answerVisible, filtering, move, query, submitted, visible]
  );

  const listId = `${domId}-options`;
  const questionId = `${domId}-question`;
  // Derived from what is RENDERED, not from the cursor. The clamp effect keeps the two
  // in step but runs a commit later, so between a filter keystroke and that effect the
  // cursor still names a row that has just been removed — and an aria-activedescendant
  // pointing at an element that is not in the document is read by a screen reader as
  // nothing at all, silently, exactly while someone is typing.
  // While an answer is in flight the highlight is the SUBMITTED row, not wherever the
  // cursor happened to be — the sheet must show the decision it actually took.
  // -1 while DISMISSING, so no row is active and none is announced as selected. The
  // answer is "none of them"; leaving the cursor's row marked `aria-selected` said the
  // opposite to exactly the reader who cannot see the "Dismissing…" line next to it.
  const shown = submitted === "dismiss" ? -1 : (submitted ?? cursor);
  const activeId = visible.some((r) => r.index === shown) ? `${domId}-option-${shown}` : undefined;

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-label="Question"
      // This sheet OWNS Escape — it clears the filter, then dismisses. Without the
      // marker the panel's own Esc-to-close fires as well, hiding the panel while the
      // engine stays parked waiting for an answer that can no longer be given.
      data-escape-owner="question"
      onKeyDown={onKeyDown}
      /**
       * A click inside the sheet does not move focus out of it.
       *
       * The default would: pressing on the question text, the eyebrow or the card's own
       * background blurs whatever held focus and hands it to the nearest focusable
       * ancestor — this root. The keys keep working, because the handler is here, but
       * `aria-activedescendant` lives on the LISTBOX, and on an unfocused element a
       * screen reader reads it as nothing. So the sheet would go silent for the exact
       * user who most needs it, after an interaction as ordinary as clicking a word.
       *
       * The filter box is the one exception: it is a text field, and a click in it is a
       * request to put the caret somewhere specific. Rows are excluded on purpose even
       * though they are buttons — they answer on the click, and a listbox row taking
       * focus from its own listbox is not a state worth passing through.
       *
       * The cost is drag-selecting text inside the sheet, which this gives up. The
       * transcript above still selects freely, and this is a control surface with a
       * blocked turn behind it: its keyboard is worth more than its copyability.
       */
      onMouseDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest("input")) return;
        e.preventDefault();
      }}
      // A flex COLUMN that can shrink. The panel is a resizable rail and a question may
      // carry 26 options of 240 characters each; a sheet that only ever grew pushed the
      // composer off the bottom of a short pane and clipped its own footer. Everything
      // but the list is fixed, so the list is what gives way.
      className={cn(
        "flex min-h-0 flex-col",
        "rounded-lg border border-[var(--assistant-border-strong)] bg-[var(--assistant-raised)]",
        "px-3 pb-2 pt-2.5 outline-hidden"
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <ListChecks
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--assistant-fg-dim)]"
        />
        <p className="min-w-0 flex-1 truncate text-[0.92em] text-[var(--assistant-fg-secondary)]">
          Daintree needs an answer
        </p>
      </div>

      <p
        id={questionId}
        // `anywhere`, like the option rows: a question may be 500 characters and is
        // allowed to be one unbroken identifier, which at rail width would otherwise
        // push the whole panel sideways.
        className="mt-1.5 shrink-0 text-[1em] font-medium text-[var(--assistant-fg)] [overflow-wrap:anywhere]"
      >
        {question.question}
      </p>

      {filtering && (
        <div
          className={cn(
            "mt-2.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1",
            // The same recessed ground as the well below it. The filter belongs to the
            // ANSWERS, not to the question, and a field that sat on `inset` — a lighter
            // surface than the card — read as a third layer stacked on top of the sheet
            // rather than as the top of the region it filters.
            "border border-[var(--assistant-border)] bg-[var(--assistant-surface)]",
            // The ring hangs off :focus-within rather than the input's own :focus-visible
            // so the whole field lights up, which is what a user reads as "typing goes
            // here" — the input itself is borderless inside it.
            "focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--assistant-focus)]"
          )}
        >
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-[var(--assistant-fg-dim)]" />
          <input
            ref={filterRef}
            type="text"
            role="combobox"
            // Told the truth rather than fixed at true. The list HIDES when a filter
            // matches nothing (see `empty:hidden` below), and a combobox claiming an
            // expanded popup while pointing `aria-controls` at a display:none element
            // is a state a screen reader cannot make sense of — it announces a list
            // that is not there. Expanded means "there is a popup showing", which is
            // exactly `visible.length > 0`.
            aria-expanded={visible.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label="Filter options"
            // Described by the QUESTION. "Filter options" alone names the control and
            // not the decision, so a screen-reader user who tabs back to it — or lands
            // on it after the sheet has been read once — is typing into a box with no
            // idea what is being asked.
            aria-describedby={questionId}
            // The list narrows as you type and never completes the text inline.
            aria-autocomplete="list"
            // The browser's own suggestion lists would draw over a sheet whose whole
            // purpose is a list of the only valid answers.
            autoComplete="off"
            spellCheck={false}
            value={query}
            readOnly={submitted !== null}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter options"
            className={cn(
              "min-w-0 flex-1 bg-transparent text-[1em] text-[var(--assistant-fg)] outline-hidden",
              "placeholder:text-[var(--assistant-fg-secondary)]"
            )}
          />
        </div>
      )}

      <div
        id={listId}
        ref={listRef}
        role="listbox"
        // Focusable, and focused when there is no filter box, so `aria-activedescendant`
        // is announced: on a non-focused element a screen reader never reads it, and the
        // cursor moves silently.
        //
        // A real TAB STOP when it owns the keyboard, so Shift+Tab from Dismiss comes
        // BACK to the choices. At -1 it was reachable only by the mount-time focus grab:
        // one tab forward and the options could not be returned to at all, which on a
        // sheet whose only other control dismisses the question is a trap.
        tabIndex={filtering ? -1 : 0}
        // The LIST is what stops accepting a decision, so the list is what reports
        // itself busy. On the whole sheet it also covered the footer, and a live region
        // inside a busy subtree is one assistive technology may hold back until busy
        // clears — which for a successful answer never happens, because the sheet
        // unmounts instead. The acknowledgement has to live outside it.
        aria-busy={submitted !== null}
        aria-labelledby={questionId}
        aria-activedescendant={filtering ? undefined : activeId}
        onPointerMove={() => {
          pointerLive.current = true;
        }}
        // The one part that flexes: `max-h` is on the SHEET's wrapper instead (see
        // AssistantPanelView), because a ceiling here could only ever be a guess about
        // how much room the panel has.
        //
        // A RECESSED WELL, and the reason is legibility before it is decoration. The
        // card is the raised surface, so a highlighted row painted in `hover` sat 2% of
        // a lift above the ground it was on — near-invisible, which is what forced an
        // accent ring around the whole list to say where the keyboard was. Dropping the
        // options back onto the panel's own ground gives the highlight the full lift to
        // work with, and the ring stops being load-bearing. It is also the separation
        // the sheet was missing: the question is on the card, the answers are in the
        // well, and the border between them is where one stops and the other starts.
        //
        // What replaces the ring is a border that STRENGTHENS on focus — neutral, not
        // accent. Focus arrives here programmatically when the sheet mounts, so this
        // hangs off plain `:focus` rather than `:focus-visible`, which such a focus
        // never satisfies. The row highlight is the actual focus indicator (this is an
        // `aria-activedescendant` listbox; the cursor is the thing that moves), and the
        // border only answers "does this region still hold the keys".
        //
        // `empty:hidden` because a filter that matches nothing would otherwise leave a
        // bordered 8px sliver above the status line — the well should be absent when it
        // has nothing in it, not present and empty.
        className={cn(
          // `scroll-p-1` matches the padding: without it `scrollIntoView` parks the
          // highlighted row flush against the well's border and clips the rounded
          // corner it just drew, which reads as the row being cut off by the frame.
          filtering ? "mt-1.5" : "mt-2.5",
          // The class is a STYLE HOOK, not decoration: `assistant-panel.css` hangs the
          // forced-colors and raised-contrast cursor off it, where a background-only
          // highlight cannot survive.
          "assistant-answers min-h-0 flex-1 overflow-y-auto rounded-md p-1 scroll-p-1",
          "empty:hidden",
          "border border-[var(--assistant-border)] bg-[var(--assistant-surface)]",
          "outline-hidden transition-colors duration-150 ease-out",
          "focus:border-[var(--assistant-border-strong)]"
        )}
      >
        {visible.length === 0
          ? null
          : visible.map((row, position) => {
              const active = row.index === shown;
              // The number that answers this row, where numbers answer at all. Positional
              // over the VISIBLE list, so it always matches what the eye counts.
              const digit = !filtering && position < 9 ? String(position + 1) : null;
              return (
                <button
                  key={row.index}
                  ref={active ? activeRef : undefined}
                  id={`${domId}-option-${row.index}`}
                  role="option"
                  aria-selected={active}
                  type="button"
                  // Not a tab stop: the listbox owns the keyboard, and 26 buttons between
                  // the sheet and the composer is not navigation, it is a maze.
                  tabIndex={-1}
                  // Hover follows the mouse, not the keyboard. See `pointerLive`.
                  onMouseEnter={() => {
                    if (pointerLive.current && submitted === null) setCursor(row.index);
                  }}
                  onClick={() => answer(row.index)}
                  disabled={submitted !== null}
                  className={cn(
                    "relative flex w-full items-start gap-2 rounded-md py-1.5 pl-3 pr-2 text-left text-[1em]",
                    "transition-colors duration-150 ease-out",
                    active ? "bg-[var(--assistant-hover)]" : "hover:bg-[var(--assistant-hover)]/60"
                  )}
                >
                  {/* A leading RAIL, not a ring around the row. A four-sided outline on a
                    row this wide reads as a second card inside the sheet, and it is the
                    one shape that collides with the focus ring the sheet itself carries.
                    The rail is always in the layout and only ever changes colour, so the
                    text never shifts as the cursor passes. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute inset-y-1 left-0 w-[2px] rounded-full",
                      "transition-colors duration-150 ease-out",
                      active ? "bg-[var(--assistant-fg)]" : "bg-transparent"
                    )}
                  />
                  {/* The keycap: the NUMBER you press, then the letter this option is
                    called.

                    Both, because they are different facts. The number is the key — it is
                    what someone reaches for on a list of three things, and a badge that
                    showed only a letter left it as folklore in the footer hint. The
                    letter is the option's IDENTITY: it travels on the wire, it is what
                    the transcript records ("You chose: B — main"), and it is what the
                    model is told. Showing one and using the other is how a sheet and its
                    own transcript end up disagreeing about which option was taken.

                    On a filtering list the number disappears with the accelerator it
                    names, because a keycap for a key that types into the search box is
                    an instruction that does something else. */}
                  <span
                    className={cn(
                      "mt-px inline-flex h-[1.5em] shrink-0 items-center justify-center gap-[0.3em]",
                      "rounded border px-[0.4em] text-[0.85em] tabular-nums",
                      "transition-colors duration-150 ease-out",
                      active
                        ? "border-[var(--assistant-border-strong)]"
                        : "border-[var(--assistant-border)]"
                    )}
                  >
                    {digit && (
                      <span
                        className={
                          active
                            ? "text-[var(--assistant-fg)]"
                            : "text-[var(--assistant-fg-secondary)]"
                        }
                      >
                        {digit}
                      </span>
                    )}
                    <span
                      className={cn(
                        digit && "border-l border-[var(--assistant-border)] pl-[0.35em]",
                        active
                          ? "text-[var(--assistant-fg)]"
                          : "text-[var(--assistant-fg-secondary)]"
                      )}
                    >
                      {row.label}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 text-[var(--assistant-fg)] [overflow-wrap:anywhere]">
                    {row.text}
                  </span>
                </button>
              );
            })}
      </div>

      {/* OUTSIDE the listbox, and announced.

        Inside it, "No option matches" was neither an option nor a status: a listbox may
        only contain options, so a screen reader had nothing to read and the moment a
        filter emptied the list it simply went quiet — precisely when the user most needs
        to know that what they typed matched nothing. `role="status"` is polite, so it
        never cuts across the keystroke that produced it. */}
      {visible.length === 0 && (
        <p
          role="status"
          // Wearing the WELL, because it is standing in for it. The options region is
          // where the eye already is when a filter empties it, so the message has to
          // arrive in that space rather than as loose text on the card below where the
          // list used to be.
          className={cn(
            "mt-2.5 shrink-0 rounded-md border border-[var(--assistant-border)]",
            "bg-[var(--assistant-surface)] px-3 py-2.5",
            "text-[1em] text-[var(--assistant-fg-secondary)]"
          )}
        >
          No option matches
        </p>
      )}

      {/* No rule above it any more. The well below the question now closes with a border
        of its own, and a second hairline six pixels under the first read as a ruling
        mistake rather than as structure. Space separates the footer instead. */}
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2 text-[0.92em] text-[var(--assistant-fg-secondary)]">
        {/* The hint states what is ACTUALLY bound right now. A fixed line promising
            number keys on a sheet where they type into the filter is worse than no hint:
            it is an instruction that silently does something else. */}
        <span
          className="min-w-0 truncate"
          // A live region while a decision is in flight, so the acknowledgement is
          // OFFERED to be spoken rather than left to `aria-busy`, which no reader is
          // obliged to announce on its own. Whether it is actually announced is the
          // reader's call, which is why the list's busy state carries the same fact
          // structurally. Polite: it must not cut across the keystroke that caused it.
          // Off otherwise — the key hints are reference text, and a reader re-reading
          // them on every filter keystroke would be unusable.
          role={submitted !== null ? "status" : undefined}
        >
          {submitted !== null
            ? // The keys are gone with the decision. Leaving the hint up would keep
              // advertising accelerators that now do nothing, which is the same
              // misreport the frozen highlight exists to prevent.
              submitted === "dismiss"
              ? "Dismissing…"
              : "Applying your answer…"
            : filtering
              ? "Type to filter · ↑↓ move · ⏎ answer"
              : "↑↓ move · number or letter to answer"}
        </span>
        <button
          type="button"
          onClick={() => answer(-1)}
          disabled={submitted !== null}
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5",
            "transition-colors duration-150 ease-out",
            // `disabled:` is the one place the palette contract allows opacity on text:
            // a control that cannot be acted on is meant to recede, and it is no longer
            // information. See palette.contract.test.ts.
            "disabled:pointer-events-none disabled:opacity-40",
            "hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
          )}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
