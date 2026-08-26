import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, Info, Square, TriangleAlert, ZapOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon } from "@/components/icons/DaintreeIcon";
import { AssistantMessage, type AssistantReference } from "./AssistantMessage";
import { AssistantToolRow, AssistantToolGroupHeader } from "./AssistantToolRow";
import { AssistantApprovalCard } from "./AssistantApprovalCard";
import type {
  AssistantApproval,
  AssistantToolCall,
  AssistantNotice,
  AssistantSessionState,
  AssistantTurn,
} from "@/store/assistantStore";
import { HybridInputBar, type HybridInputBarHandle } from "@/components/Terminal/HybridInputBar";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { AssistantBootSplash } from "./AssistantBootSplash";
import { AssistantQuestionCard } from "./AssistantQuestionCard";
import { AssistantOperationsDeck } from "./AssistantOperationsDeck";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { resolveInputBarColors } from "@/utils/terminalTheme";
import "./assistant-panel.css";
import { buildAssistantPalette } from "./palette";

/**
 * The native assistant surface.
 *
 * Presentational by construction: it takes a session snapshot and callbacks, and
 * holds no store subscription of its own. That keeps it drivable from fixtures for
 * visual review in every theme — which is the only practical way to check a surface
 * that otherwise only appears when a real engine is mid-turn.
 */

export interface AssistantPanelViewProps {
  state: AssistantSessionState;
  /**
   * Returns whether the prompt was ACCEPTED. The composer keeps the draft when it was
   * not — a session that is still starting, or has stopped, would otherwise swallow
   * what someone typed and leave an empty box, which reads as the app losing their
   * words rather than as "not ready yet".
   */
  onSubmit: (text: string) => boolean;
  onInterrupt: () => void;
  onDecideApproval: (approvalId: string, decision: "approved" | "rejected") => void;
  onAnswerQuestion?: (questionId: string, index: number) => void;
  onGrantTool?: (approval: AssistantApproval, uses: number) => void;
  onRequestOperations?: () => void;
  /**
   * Whether the operations deck is showing, when an owner above the panel drives it.
   *
   * The way IN is the panel header's overflow menu, which lives outside this component
   * — the composer strip is the narrowest row in the app and an overflow button sat
   * there among readings that are not controls. Leaving it undefined keeps the deck on
   * this component's own state, which is what the preview harness renders it with.
   */
  operationsOpen?: boolean;
  onOperationsOpenChange?: (open: boolean) => void;
  /**
   * Take back the newest buffered follow-up (LIFO), the cockpit's Esc-retract.
   *
   * Fired from the input bar's `onSendKey("escape")`, which is what the bar forwards
   * once its own Escape meanings (close the completion menu, collapse the editor) are
   * exhausted.
   */
  onRetractInterjection?: () => void;
  /** Clear `state.retractedDraft` once the composer has taken it. */
  onRetractedDraftConsumed?: () => void;
  /**
   * Identity for the input bar's per-surface state — its draft, its prompt history.
   * Not a terminal id: the bar keys that state by a string, and the assistant needs its
   * own bucket so its draft is not confused with any terminal's.
   */
  composerId?: string;
  /** Project root, for the bar's `@` file completion. */
  cwd?: string | null;
  /**
   * Routes a click on an internal reference in rendered prose (an issue or pull-request
   * number the model named explicitly). Undefined renders those references as plain
   * text — see `AssistantMessage`.
   *
   * MUST be referentially stable: it reaches a memoized component that re-renders every
   * frame of a streaming turn.
   */
  onActivateReference?: (reference: AssistantReference) => void;
  /**
   * Whether a forge provider resolved for this project. Gates whether issue and PR
   * references are recognised at all, because without one they have no destination.
   */
  forgeAvailable?: boolean;
  className?: string;
}

/**
 * Phase strings the engine emits, in the cockpit's own words.
 *
 * These are not paraphrases. The terminal UI distinguished "Analyzing request",
 * "Model working", "Writing" and "Integrating results" because they are different
 * things to be waiting on, and it BANNED the word "Thinking" outright — that word had
 * historically meant a phase inferred from silence, and its own test suite asserted it
 * never appeared (`TestRunStageLabel_NeverThinking`). Collapsing three phases into
 * "Thinking" both lost the distinction and reintroduced the forbidden word.
 */
/**
 * The INLINE live-status label, at the tail of the running turn (the cockpit's
 * `liveStatusLabel`, internal/ui/runstatus.go).
 *
 * Only the SILENT phases get one. `tool_running` is deliberately absent: the activity
 * rows below already say what is happening, and a status line repeating it is noise.
 * `received` is stamped on the turn marker instead.
 *
 * The word "Thinking" is banned from this vocabulary. In the cockpit it had meant a
 * phase INFERRED from "the assistant text is still empty"; every phase here is
 * explicit, and reusing the word would resurrect the guess it replaced.
 */
export const LIVE_STATUS_LABEL: Record<string, string> = {
  analyzing: "Analyzing request",
  thinking: "Model working",
  generating: "Writing",
  integrating: "Integrating results",
  awaiting_approval: "Waiting for approval",
  awaiting_question: "Waiting for your answer",
  cancelling: "Cancelling",
};

function liveStatusLabel(phase: string | null): string | null {
  if (!phase) return null;
  return LIVE_STATUS_LABEL[phase] ?? null;
}

/**
 * Formats spend. `complete: false` means the figure is a FLOOR — a call ran whose
 * cost could not be measured — so it is rendered as "≥ $x" rather than as a settled
 * number. Presenting a floor as a receipt would under-report what a session spent.
 */
/** Matches the cockpit's own stall threshold. */
const STALL_THRESHOLD_MS = 5000;

/**
 * How often the live elapsed readout re-renders.
 *
 * Twice a second: fast enough that a tenth-of-a-second figure never looks stuck, slow
 * enough that a running turn is not re-rendering the transcript on every frame.
 */
const ELAPSED_TICK_MS = 500;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  // Rounded to whole seconds FIRST, then split.
  //
  // Rounding only the remainder produces "1m 60s": at 119,600ms the minutes floor to 1
  // and the leftover 59,600ms rounds up to 60, so the two halves disagree about what
  // they add up to. Harmless in a clock that ticks past it twice a second, and not
  // harmless in the turn endcap, which stamps whatever it is handed into the transcript
  // and keeps it there.
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function formatCost(total: number, complete: boolean): string {
  const value = total < 0.01 && total > 0 ? total.toFixed(4) : total.toFixed(2);
  return `${complete ? "" : "≥ "}$${value}`;
}

/**
 * A notice — most often the output of a slash command the engine ran.
 *
 * `whitespace-pre-wrap` is load-bearing, not cosmetic. The engine composes command
 * output as TERMINAL text — padded columns, indented continuation lines, and a leading
 * `→ ` on the live entry — and every command result shares this row, so `/backend`,
 * `/status`, `/doctor` and `/audit` were all collapsed into single paragraphs of prose
 * by ordinary HTML whitespace folding, markers and all.
 *
 * Column alignment holds for any row that FITS: the panel root is already the terminal
 * font (`assistant-panel.css`) and everything here inherits it. A row too wide for a
 * docked panel still wraps, and its continuation line does not stay aligned — acceptable,
 * and the same thing a narrow terminal does.
 *
 * `break-words` alongside it: pre-wrap cannot break inside an unbroken token, and these
 * lines carry URLs and absolute log paths longer than the panel is wide.
 */
function NoticeRow({ notice }: { notice: AssistantNotice }) {
  const Icon = notice.level === "info" ? Info : notice.level === "warning" ? TriangleAlert : ZapOff;
  const tone =
    notice.level === "info"
      ? "text-[var(--assistant-fg-secondary)]"
      : notice.level === "warning"
        ? "text-[var(--assistant-warning)]"
        : "text-[var(--assistant-danger)]";
  return (
    <div className="flex items-start gap-2 px-1 py-1 text-[1em]">
      <Icon aria-hidden="true" className={cn("mt-px size-3.5 shrink-0", tone)} />
      <p
        data-testid="assistant-notice"
        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--assistant-fg-secondary)]"
      >
        {notice.message}
      </p>
    </div>
  );
}

/**
 * How tall a user's own message is allowed to be before it folds.
 *
 * In `em`, so it tracks the terminal font size the whole panel is sized from — the cap
 * is "about nine lines", not "about 160 pixels", and it stays about nine lines when
 * someone changes their terminal type size.
 */
const USER_MSG_MAX_HEIGHT = "13em";

/**
 * One turn the user typed.
 *
 * Folded by MEASURED HEIGHT rather than by counting newlines. The count is what this
 * used to do, and it was wrong for the shape people actually paste: two long prose
 * paragraphs are two lines by that arithmetic and a dozen on screen, so the thing most
 * worth folding was the one thing that never folded, while a short block of code with
 * many hard breaks folded when it did not need to. A cap on the rendered box asks the
 * question the reader is actually asking — is this taller than I want to scroll past —
 * and wrapping is part of the answer.
 */
function UserTurn({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Latched, never cleared. Expanding removes the cap, so the same measurement then
  // says the content fits — and reading it again would delete the control that got the
  // reader here, leaving no way back. It only ever needs answering while folded.
  const [foldable, setFoldable] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return undefined;
    const el = bodyRef.current;
    if (!el) return undefined;
    // 2px of slack: sub-pixel line heights make `scrollHeight` exceed `clientHeight` by
    // a fraction on content that visibly fits, which would offer "Show more" on a
    // message with nothing more to show.
    const measure = () => setFoldable(el.scrollHeight - el.clientHeight > 2);
    measure();
    // The panel is resizable, so the same text folds at one width and not at another.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          // Narrower than the answer it asks for, and that asymmetry is the point: the
          // agent gets the full rail, the prompt gets what it needs. A prompt is
          // already known to whoever typed it.
          "max-w-[85%] overflow-hidden rounded-lg rounded-br-sm",
          "bg-[var(--assistant-raised)] text-[1em] text-[var(--assistant-fg)]"
        )}
      >
        <div className="relative">
          <div
            ref={bodyRef}
            className={cn(
              "px-3 py-2 whitespace-pre-wrap break-words",
              // Capped even when EXPANDED, just far more generously. "Show more" on a
              // thousand-line paste otherwise pushes the conversation off screen and
              // hands back no way to bring it into view — the fold stops a long paste
              // burying the transcript, and this stops expanding it doing the same.
              expanded ? "overflow-y-auto overscroll-contain" : "overflow-hidden"
            )}
            // `max()` because the two caps are in different units and can cross. The
            // collapsed cap is ~9 lines of the TERMINAL font and the expanded one is
            // half the viewport: at a 24px terminal size in a 600px-tall window that is
            // 312px against 300px, so "Show more" made the message SHORTER. Whatever
            // else expanding does, it may not shrink the thing being expanded.
            style={{
              maxHeight: expanded ? `max(50vh, ${USER_MSG_MAX_HEIGHT})` : USER_MSG_MAX_HEIGHT,
            }}
          >
            {text}
          </div>
          {/* The fade is the signal that there IS more, and it does the job the old
              "N lines hidden" label did — without claiming a number that was only ever
              true for unwrapped text. Sits INSIDE the padding so the last visible line
              dissolves rather than ending on a hard edge. */}
          {!expanded && foldable && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-[var(--assistant-raised)]"
            />
          )}
        </div>
        {foldable && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            className={cn(
              "flex w-full items-center gap-1 px-3 pt-0.5 pb-2 text-left",
              "text-[0.92em] text-[var(--assistant-fg-secondary)]",
              "transition-colors duration-150 ease-out hover:text-[var(--assistant-fg)]",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--assistant-focus)]"
            )}
          >
            {expanded ? "Show less" : "Show more"}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-150 ease-out",
                expanded && "rotate-180"
              )}
            />
          </button>
        )}
      </div>
    </div>
  );
}

function TurnBlock({
  turn,
  state,
  onActivateReference,
  forgeAvailable,
}: {
  turn: AssistantTurn;
  state: AssistantSessionState;
  onActivateReference?: (reference: AssistantReference) => void;
  forgeAvailable?: boolean;
}) {
  if (turn.role === "user") {
    return <UserTurn text={turn.text} />;
  }

  return (
    // FULL WIDTH, deliberately. The cockpit gave the agent the whole terminal, and this
    // panel is a sidebar — an avatar column costs ~26px of every line of an answer, and
    // in a rail that is the difference between a path wrapping and not.
    //
    // Nothing is lost by dropping it: the user's own turns are right-aligned bubbles at
    // 85% width, so which side of the conversation a block belongs to is legible from
    // its shape alone, without spending horizontal space per line to say so.
    <div className="w-full">
      <div className="min-w-0 space-y-5">
        {/* Rendered IN ORDER. A turn is a sequence — prose, then the tools it reached
            for, then prose reacting to the results, with steers where the engine folded
            them in. Drawing tools first and prose last regardless made a turn that
            explained itself before acting read as if it had acted in silence.

            space-y-5 (not the tighter space-y-1 ToolSegment uses between its own rows)
            is deliberate: a batch of tool calls reads as one unit, so its rows stay
            tight, but the boundary where prose meets that unit — or meets the next one
            — needs a full line of breathing room or the transcript reads as a wall. */}
        {turn.segments.map((segment, i) => {
          if (segment.kind === "interjection") {
            return (
              <div
                key={`${turn.turnId}-seg-${i}`}
                className="rounded-md border-l-2 border-[var(--assistant-border-strong)] bg-[var(--assistant-inset)]/60 px-2 py-1 text-[1em] text-[var(--assistant-fg-secondary)]"
              >
                <span className="text-[var(--assistant-fg-secondary)]">You added: </span>
                {segment.text}
              </div>
            );
          }
          if (segment.kind === "answer") {
            return (
              <div
                key={`${turn.turnId}-seg-${i}`}
                className="rounded-md border-l-2 border-[var(--assistant-border-strong)] bg-[var(--assistant-inset)]/60 px-2 py-1 text-[1em] text-[var(--assistant-fg-secondary)]"
              >
                <span className="text-[var(--assistant-fg-secondary)]">
                  {segment.text ? "You chose: " : "You dismissed: "}
                </span>
                {segment.text
                  ? `${segment.label ? `${segment.label} — ` : ""}${segment.text}`
                  : segment.question}
              </div>
            );
          }
          if (segment.kind === "tools") {
            const segCalls = segment.toolCallIds
              .map((id) => state.toolCalls[id])
              .filter((c): c is NonNullable<typeof c> => Boolean(c));
            if (segCalls.length === 0) return null;
            return (
              <ToolSegment
                key={`${turn.turnId}-seg-${i}`}
                calls={segCalls}
                turnComplete={turn.complete}
              />
            );
          }
          return segment.text ? (
            <AssistantMessage
              key={`${turn.turnId}-seg-${i}`}
              content={segment.text}
              onActivateReference={onActivateReference}
              forgeAvailable={forgeAvailable}
              // Only the LAST segment can still be streaming — AND only while the engine
              // is actually producing prose. An unfinished turn is not the same thing:
              // the engine leaves `generating` the moment the model stops emitting text
              // and starts composing a tool call (`tool_queued`), reasoning
              // (`thinking`), or folding results back in (`integrating`). Blinking
              // through all of that left a caret parked at the end of a paragraph the
              // engine had finished with, claiming text was still arriving for as long
              // as a tool took to run.
              streaming={
                !turn.complete && i === turn.segments.length - 1 && state.phase === "generating"
              }
            />
          ) : null;
        })}

        {/* A turn that has produced nothing yet still needs to show it is alive — but
            only when no tool group is already carrying that signal, never once an
            approval card has taken over saying the turn is blocked on the user, and
            — same rule as the segment caret above — only while text is actually
            arriving. Analyzing/thinking/integrating already have their own words in
            the live-status label; blinking a caret through them too just resurrects
            "Thinking" inferred from silence under a different name. */}
        {turn.segments.length === 0 && !turn.complete && state.phase === "generating" && (
          <AssistantMessage content="" streaming />
        )}
      </div>
    </div>
  );
}

/**
 * The quiet rule that closes a settled assistant turn.
 *
 * Assistant turns are full width with no avatar column, so consecutive answers run
 * together as one continuous column and there is nothing to say where one ended. The
 * user's own turns break it up when there are any — but a turn that spawns a wake, or a
 * run of follow-ups the assistant answers in sequence, has no such break.
 *
 * It carries the TURN'S DURATION rather than being a bare divider, and that is the
 * whole reason it earns a line. The elapsed clock ticks in the live status line while a
 * turn runs and then vanishes when it completes, so "that took forty seconds" is a fact
 * the panel knows, shows, and then throws away. Parking it here keeps it, and gives the
 * boundary something to be other than decoration.
 *
 * Deliberately NOT an outcome badge. The store carries a heuristic `outcome`
 * classification, and painting every settled answer with its guess — green for success,
 * amber for hedged — would put a confident colour on an inference, on every turn, in a
 * panel whose whole design is that it reports what it SAW rather than what it concluded.
 * A wake and a stop are different: both are facts the engine states outright.
 */
function TurnEndcap({ turn }: { turn: AssistantTurn }) {
  // Assistant turns only. A user's turn is a right-aligned bubble whose shape already
  // bounds it, and it is rendered by the same loop — so the guard lives here rather
  // than being implied by the call site.
  if (turn.role !== "assistant") return null;
  if (!turn.complete) return null;
  // A turn that never recorded an end has no duration to state, and a rule alone is a
  // divider with nothing to say. Rather than draw a bare line, draw nothing — the
  // spacing between turns is already a boundary, just a weaker one.
  if (turn.endedAt === undefined) return null;
  const elapsedMs = turn.endedAt - turn.startedAt;
  // Sub-second turns are the wake acknowledgements and one-line answers, where a rule
  // per turn would out-weigh the turns themselves. The gap between blocks carries those.
  if (elapsedMs < 1000) return null;

  return (
    <div className="mt-3 flex items-center gap-2 text-[0.92em]">
      {/* Only the RULE is decorative. The duration beside it is a fact about the turn
          that exists nowhere else once the live clock stops, so hiding the whole row
          from assistive technology — which is what an `aria-hidden` on this container
          did — deleted it for anyone reading the transcript with a screen reader. */}
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-[var(--assistant-border)]" />
      <span className="shrink-0 tabular-nums text-[var(--assistant-fg-secondary)]">
        {/* "Background" because the turn was not one the user asked for — the assistant
            woke itself. Without it a wake's rule is indistinguishable from an answer's,
            and the transcript claims the user started something they did not. */}
        {turn.wake ? `Background · ${formatDuration(elapsedMs)}` : formatDuration(elapsedMs)}
      </span>
    </div>
  );
}

/** One announced batch, collapsing on the same rules the whole turn used to. */
function ToolSegment({
  calls,
  turnComplete,
}: {
  calls: AssistantToolCall[];
  turnComplete: boolean;
}) {
  const failed = calls.filter((c) => c.state === "failed").length;
  // Work still LIVE after the turn ends: an accepted async call keeps running in the
  // background, so the turn completing does not mean the work did.
  // Async calls are excluded: they were handed off, and this panel is never told
  // whether they finished, so counting them as "still running" asserts something it
  // cannot know and that goes stale the moment the work completes.
  const unsettled = calls.filter(
    (c) => !c.asyncId && (c.state === "active" || c.state === "queued" || c.state === "waiting")
  ).length;

  /**
   * What the batch did, for the collapsed header.
   *
   * One call reads as the row would ("Read src/main.go"); several list their distinct
   * verbs, because the targets differ and stacking them is longer than the panel is
   * wide. Falls back to nothing — never to the tool ids — when the engine recognised
   * none of the tools: a row of raw identifiers is worse than the plain count.
   */
  const groupWhat = useMemo(() => {
    if (calls.length === 1) {
      const only = calls[0];
      if (!only?.verb) return undefined;
      return only.target ? `${only.verb} ${only.target}` : only.verb;
    }
    const verbs = [...new Set(calls.map((c) => c.verb).filter((v): v is string => !!v))];
    if (verbs.length === 0) return undefined;
    return verbs.slice(0, 3).join(", ") + (verbs.length > 3 ? "…" : "");
  }, [calls]);

  // Interrupted work. A stop is a question the user just asked — "what did I catch?" —
  // and the answer is which calls were cancelled and which never started.
  const interrupted = calls.filter((c) => c.state === "cancelled" || c.state === "not-run").length;

  // Work HANDED OFF. The call settled, so it does not count as unsettled — but the work
  // it started is still going somewhere else, and the row saying so is the only place
  // that is written down. Collapsing folded that away behind a header reading "1
  // action", which is exactly as true of a batch that finished and says nothing about
  // the agent still running in another worktree.
  const handedOff = calls.filter((c) => c.asyncId).length;

  // Open while the turn runs (so progress is visible), collapsing once it settles (so
  // the answer is what remains) — EXCEPT when something failed, was interrupted, or is
  // still going. Collapsing any of those made it indistinguishable from a clean run:
  // the header said "1 action" whatever happened, so the outcomes most worth noticing
  // were the ones that hid.
  //
  // Interrupted and handed-off are the two cases that had to be added. Pressing Stop
  // collapsed the group in the same beat, folding away the rows that said what the stop
  // actually interrupted — in answer to a gesture that was ASKING. And a batch that
  // spawned a background agent collapsed to a header indistinguishable from one where
  // everything had finished.
  const [open, setOpen] = useState(!turnComplete);
  useEffect(() => {
    if (turnComplete && failed === 0 && unsettled === 0 && interrupted === 0 && handedOff === 0) {
      setOpen(false);
    }
  }, [turnComplete, failed, unsettled, interrupted, handedOff]);

  return (
    <div>
      <AssistantToolGroupHeader
        count={calls.length}
        what={groupWhat}
        failedCount={failed}
        runningCount={turnComplete ? unsettled : 0}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <ul className="mt-1 space-y-1">
          {calls.map((call) => (
            <AssistantToolRow key={call.toolCallId} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The session masthead, ported from the CLI cockpit's own (internal/ui/render_chrome.go).
 *
 * Same facts in the same order, for the same reasons that file gives: identity and
 * build; the project; the tier and what it permits; a non-default backend, which since
 * sign-in went away is the ONLY readout of which endpoint answers a turn; a non-default
 * routing policy; then the auto-approve warning on its own row — never appended to the
 * tier line, because appending puts the safety text where truncation eats it first.
 * Below the rule sits the debug-log badge.
 *
 * Every value is resolved by the ENGINE and arrives on `host:ready`, so this component
 * decides layout only and cannot disagree with the engine about what is default.
 */
function Masthead({ state, live }: { state: AssistantSessionState; live: boolean }) {
  // An approval is outstanding exactly when a mutating call has been parked for an
  // answer — the engine only raises one for the always-confirm risk classes.
  const destructive = state.approvals.length > 0;
  const hasAny = state.engineVersion || state.tier || state.backend || state.routing;
  if (!hasAny) return null;

  // The cockpit drew every line but the identity in Dim(). `text-[var(--assistant-fg-secondary)]` is
  // that: the theme's own second tier, with a contrast floor behind it. The panel used
  // `opacity-50` over the primary colour instead, which is not a token, drifts with
  // whatever it sits on, and lands under the floor in the darker themes.
  const dim = "truncate text-[var(--assistant-fg-secondary)]";

  return (
    <div className="mb-3 select-text text-[1em]">
      {/* No "Daintree Assistant" line, and no project name: the panel's own header bar
          already carries both, directly above this. The cockpit needed the identity
          line because it was drawing into a bare terminal with no chrome of its own —
          here it is the same words twice in the space of two rows, and what a masthead
          is FOR is the facts you cannot get anywhere else. Those are the three below:
          what this session may do, which backend answers it, and under what routing. */}
      {state.tier ? (
        // Quiet at rest for every tier, and DANGEROUS only while a destructive action
        // waits on an answer — the cockpit's own rule (render_chrome.go:66). The tier
        // names what this session is allowed to do; the one moment that matters is when
        // it is about to be exercised. The gloss stays dim throughout: it describes the
        // tier, it is not a live state.
        <div className="truncate">
          <span
            className={
              destructive
                ? "font-medium text-[var(--assistant-danger)]"
                : "text-[var(--assistant-fg-secondary)]"
            }
          >
            tier {state.tier}
          </span>
          {state.tierGloss ? (
            <span className="text-[var(--assistant-fg-secondary)]"> · {state.tierGloss}</span>
          ) : null}
        </div>
      ) : null}
      {state.backend ? <div className={dim}>backend {state.backend}</div> : null}
      {state.routing ? <div className={dim}>routing {state.routing}</div> : null}
      {/* The build, last and quietest: it matters when reading a pasted transcript, not
          while working. */}
      {state.engineVersion ? (
        <div className={dim}>
          {/^\d/.test(state.engineVersion) ? `v${state.engineVersion}` : state.engineVersion}
        </div>
      ) : null}
      {state.autoApprove ? (
        <div className="text-[var(--assistant-danger)]">
          {/* Its own row, carrying the full sentence, left-anchored so it is the last
              thing a narrow panel cuts.

              Deliberately NOT cleared when the session stops, unlike the footer's live
              indicator. The masthead is the permanent record of how this session ran,
              and a transcript that stops saying it was unattended the moment the
              engine exits is a transcript that hides the fact.

              Past tense once stopped: "will not ask first" over a dead engine states a
              capability that no longer exists. */}
          {live
            ? "⚠ AUTO-APPROVE — mutating actions will not ask first"
            : "⚠ AUTO-APPROVE — this session ran without confirmations"}
        </div>
      ) : null}
      <div aria-hidden="true" className="my-1.5 border-t border-[var(--assistant-border)]" />
      {state.logFile ? <LogBadge path={state.logFile} /> : null}
    </div>
  );
}

/**
 * The debug-log badge: a hollow "◌ logging" label then a dim path.
 *
 * The path WRAPS rather than truncating. It used to end in an ellipsis, which hid the
 * useful tail — the session id and `.log` — and the whole point of showing it is that
 * someone can find and open that file. `break-all` is the CSS equivalent of the CLI's
 * hard cell-wrap: paths have no spaces, so a word wrapper would refuse to break at all.
 *
 * And it is a BUTTON, because showing someone a path they then have to retype into a
 * terminal is not telling them where the trace is. Clicking reveals the file in the OS
 * file manager — the reveal, not the open, so the rest of the session's logs are right
 * there beside it, which is what you want when you are comparing a good run to a bad
 * one. The unconfined reveal op is the correct one: this path is `~/.daintree/logs`,
 * deliberately outside any project root.
 */
function LogBadge({ path }: { path: string }) {
  // `process.env.HOME` is not available here — the renderer runs sandboxed with node
  // integration off, so reading it silently yielded undefined and every path stayed
  // absolute. The home directory comes over IPC instead.
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    safeFireAndForget(
      window.electron.system.getHomeDir().then((dir) => {
        if (!cancelled && typeof dir === "string") setHome(dir);
      })
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // Collapsed on a PATH-SEGMENT boundary, not a bare prefix: with a home of
  // `/home/bob`, a bare `startsWith` turns `/home/bobby/x` into `~by/x`.
  const shown =
    home && (path === home || path.startsWith(home.endsWith("/") ? home : `${home}/`))
      ? `~${path.slice(home.length)}`
      : path;
  return (
    <button
      type="button"
      onClick={() => {
        // Best-effort: a log the engine has not written a line to yet does not exist on
        // disk, and the reveal op reports that as a rejected path. Nothing useful can be
        // said about it in a masthead badge, and a toast for "the file is not there yet"
        // would fire on exactly the clicks that need no explanation.
        safeFireAndForget(
          window.electron.system.showItemInFolderUnconfined(path).catch((error: unknown) => {
            console.warn("[assistant] could not reveal the debug log", error);
          })
        );
      }}
      title={`Reveal ${path}`}
      className={cn(
        "-mx-1 block break-all rounded-sm px-1 text-left",
        "transition-colors duration-150 ease-out hover:bg-[var(--assistant-hover)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
      )}
    >
      <span className="text-[var(--assistant-warning)]">◌ logging</span>
      <span className="text-[var(--assistant-fg-secondary)]"> · {shown}</span>
    </button>
  );
}

export function AssistantPanelView({
  state,
  onSubmit,
  onInterrupt,
  onDecideApproval,
  onAnswerQuestion,
  onGrantTool,
  onRequestOperations,
  operationsOpen,
  onOperationsOpenChange,
  onRetractInterjection,
  onRetractedDraftConsumed,
  composerId = "daintree-assistant",
  cwd,
  onActivateReference,
  forgeAvailable,
  className,
}: AssistantPanelViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HybridInputBarHandle>(null);
  const pinnedRef = useRef(true);

  const openTurn = state.turns.find((t) => t.role === "assistant" && !t.complete);
  const streaming = openTurn !== undefined;
  // False while a turn the assistant started ITSELF is running — including the window
  // before that turn opens, when only the phase has said so.
  const interruptible = openTurn ? openTurn.wake !== true : !state.phaseIsWake;
  const busy = streaming || state.phase !== null;

  // Stick to the bottom only while the reader is already there. Yanking someone back
  // down while they are reading earlier output is the classic chat-scroll annoyance.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // `toolCalls` included: a progress line or a settling row changes the transcript's
    // height without touching turns, so leaving it out lets content grow below a
    // reader who is pinned to the bottom and expects to stay there.
  }, [state.turns, state.approvals, state.notices, state.toolCalls]);

  // A follow-up the engine handed back lands in the composer for editing. Taken once
  // and cleared at the source, so a later render cannot re-fill the box over whatever
  // the user has started typing since.
  useEffect(() => {
    if (state.retractedDraft === null) return;
    // Written into the input bar's own draft store rather than to local state: the bar
    // owns the editor now, and its draft for this surface is keyed by `composerId`.
    useTerminalInputStore.getState().setDraftInput(composerId, state.retractedDraft);
    composerRef.current?.focus();
    onRetractedDraftConsumed?.();
  }, [state.retractedDraft, onRetractedDraftConsumed, composerId]);

  // The deck replaces the transcript rather than sitting beside it: the panel is a
  // sidebar, and two scrolling regions in that width makes both unreadable. The cockpit
  // did the same — its deck took the screen.
  //
  // Controlled when an owner above the panel supplies the state — the header's overflow
  // menu is the way in, and it cannot reach a `useState` down here. Uncontrolled
  // otherwise, so the preview harness and any bare render still get a working deck.
  const [ownDeckOpen, setOwnDeckOpen] = useState(false);
  const deckOpen = operationsOpen ?? ownDeckOpen;
  const setDeckOpen = useCallback(
    (open: boolean) => {
      if (onOperationsOpenChange) onOperationsOpenChange(open);
      else setOwnDeckOpen(open);
    },
    [onOperationsOpenChange]
  );

  /**
   * ^O opens the operations deck, as it did in the cockpit.
   *
   * Bound on the PANEL rather than inside the composer. The deck is a panel surface,
   * not an editing command, and the composer is the terminal's own input bar — reaching
   * into it to add a binding only this one host wants is how the copy started last time.
   * Panel-level also means it works from the transcript, the deck itself and the input
   * alike, which is what a chord that toggles a whole surface has to do.
   *
   * `metaKey` is deliberately NOT accepted: ⌘O is Open on macOS and belongs to the app.
   */
  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "o")) return;
      if (!onRequestOperations) return;
      e.preventDefault();
      e.stopPropagation();
      setDeckOpen(!deckOpen);
    },
    [onRequestOperations, deckOpen, setDeckOpen]
  );

  // Ask for a fresh reading on the way IN, once, wherever the deck was opened from —
  // ^O, or the panel header's menu. The deck is answered on request, so this cannot
  // live in the toggle any more: there are two of them now, and only one is in this
  // file. Requesting on the way OUT would spend a round trip on a view being dismissed.
  useEffect(() => {
    if (deckOpen) onRequestOperations?.();
  }, [deckOpen, onRequestOperations]);

  // A live session is one that can still act. Several readouts describe the session
  // rather than the transcript, and none of them is true once it has stopped.
  const live = state.connection === "ready";

  // ONE status line, at the tail of the running turn. The cockpit had a second one
  // under the composer; that copy is gone — see the status row below. `liveLabel` is
  // null for the phases whose activity rows already explain themselves.
  const liveLabel = liveStatusLabel(state.phase);

  // A clock, ticking only while a turn is running.
  //
  // `now` is real state that the rendered output reads, not a bare counter: under the
  // React Compiler a `setTick` whose value nothing consumes is optimised away and the
  // readout silently freezes in production while passing in tests.
  const [now, setNow] = useState(() => Date.now());
  const running = state.turnStartedAt !== null && !state.turns.every((t) => t.complete);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  // Cumulative over the TURN, not the current phase, so it does not reset to zero on
  // every transition. Held back below 300ms to avoid a 0ms flicker.
  const elapsedMs = running && state.turnStartedAt ? now - state.turnStartedAt : 0;
  const elapsed = elapsedMs >= 300 ? formatDuration(elapsedMs) : null;
  // Quiet for a while is normal — a slow model, a long tool — but indistinguishable
  // from a hang unless the panel says which it thinks it is.
  const stalled =
    running && state.lastActivityAt !== null && now - state.lastActivityAt > STALL_THRESHOLD_MS;
  const empty = state.turns.length === 0;

  // The splash belongs to a SESSION, not to this component.
  //
  // The panel stays mounted while it is closed — it slides off-canvas rather than
  // unmounting — so a splash keyed on mount plays to nobody at app start and has long
  // finished by the time the panel is first opened. Keying it on the session id means
  // it plays when an engine actually starts, and replays for a new one ("+ New
  // session"), which is exactly when the CLI played it.
  // Identified by a BOOT GENERATION, not by the session id.
  //
  // The session id does not exist until `start()` resolves, so keying on it means the
  // splash mounts as "pending", then re-keys the moment readiness arrives — restarting
  // the reveal on every cold start, and playing it twice outright when the start is
  // slow. The generation is stamped once, when the connection first enters "starting",
  // and does not move again until another session starts.
  const [bootGen, setBootGen] = useState(0);
  const [splashedGen, setSplashedGen] = useState(-1);
  const prevConnection = useRef(state.connection);
  useEffect(() => {
    if (prevConnection.current !== "starting" && state.connection === "starting") {
      setBootGen((n) => n + 1);
    }
    prevConnection.current = state.connection;
  }, [state.connection]);
  const starting = state.connection === "starting" || state.connection === "ready";
  const booting = empty && starting && splashedGen !== bootGen;

  // Notices the engine attributed to a turn are drawn INSIDE that turn; a turn-less one
  // is drawn AFTER the turn it arrived behind. Only the ones with nothing to sit behind
  // — they arrived before the first turn, or their turn has since been cleared — fall
  // through to the end of the transcript.
  //
  // Command results are what makes the distinction matter. A slash line is not part of a
  // turn, so every result carried no attribution and every one of them landed at the
  // end. With one command that is invisible; with three it puts the questions up the
  // transcript and the answers in a block at the bottom, and the only way to pair them
  // is to read the command echoed in each. `/login` then `/account` is a two-command
  // sequence in ordinary use, so this is the normal case, not an edge one.
  const anchoredNotices = useMemo(() => {
    const live = new Set(state.turns.map((t) => t.turnId));
    const byAnchor = new Map<string, AssistantNotice[]>();
    for (const n of state.notices) {
      if (n.turnId || !n.afterTurnId || !live.has(n.afterTurnId)) continue;
      const list = byAnchor.get(n.afterTurnId);
      if (list) list.push(n);
      else byAnchor.set(n.afterTurnId, [n]);
    }
    return byAnchor;
  }, [state.notices, state.turns]);
  const sessionNotices = useMemo(() => {
    const live = new Set(state.turns.map((t) => t.turnId));
    return state.notices.filter((n) => !n.turnId && (!n.afterTurnId || !live.has(n.afterTurnId)));
  }, [state.notices, state.turns]);
  const noticesByTurn = useMemo(() => {
    const byTurn = new Map<string, AssistantNotice[]>();
    for (const n of state.notices) {
      if (!n.turnId) continue;
      const list = byTurn.get(n.turnId);
      if (list) list.push(n);
      else byTurn.set(n.turnId, [n]);
    }
    return byTurn;
  }, [state.notices]);

  // The panel is HTML, not a terminal, but it sits in the same rail as one and reads as
  // the same kind of surface — so it takes its colours from the terminal theme rather
  // than the panel palette. `resolveInputBarColors` is the same function the terminal's
  // own composer uses, so the two agree by construction instead of by two sets of
  // hand-picked tokens drifting apart on the next theme.
  const termTheme = useTerminalColorSchemeStore(selectEffectiveTheme);
  const term = useMemo(() => resolveInputBarColors(termTheme), [termTheme]);

  /**
   * The terminal's LIVE typography, not a copy of its defaults.
   *
   * Both are user settings that hydrate after boot (useTerminalConfig reads them from
   * disk and pushes them into this store). Hardcoding 12px and the default stack made
   * the panel correct only for someone who had never opened terminal settings — anyone
   * who had changed the size saw a pane a third larger or smaller than the ones beside
   * it, with no way to bring them into line.
   */
  const termFontSize = useTerminalFontStore((s) => s.fontSize);
  const termFontFamily = useTerminalFontStore((s) => s.fontFamily);

  /**
   * Clicking anywhere that is not itself interactive puts the caret in the composer —
   * the same affordance a terminal has, where the whole pane is the typing surface.
   *
   * Bound to MOUSEUP, never mousedown, and that is the whole reason the transcript can
   * be selected at all. Focusing another element during `mousedown` moves the document
   * selection into that element, which cancels the drag the browser was about to start:
   * every attempt to sweep across an answer collapsed the instant the button went down,
   * so the panel read as though selection had been switched off. The guard below could
   * not save it either — at mousedown the NEW selection does not exist yet, so it
   * always measured empty and always focused.
   *
   * At mouseup the drag has finished and `getSelection()` holds the real answer, so a
   * click that selected nothing focuses the composer and a drag that selected something
   * is left alone.
   */
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const notePress = useCallback((e: React.MouseEvent) => {
    pressOriginRef.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  }, []);

  const focusComposer = useCallback((e: React.MouseEvent) => {
    // Secondary buttons never focus: a right-click opens the context menu on the text
    // under the pointer, and moving the caret out from under it first is how a
    // right-click on a selection loses the selection it was aimed at.
    if (e.button !== 0) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el?.closest("button, a, input, textarea, [role='button'], [contenteditable]")) return;

    // A press that MOVED was a drag, and a drag is never a request to start typing —
    // decided from the pointer rather than from the selection, because the two disagree
    // in both directions. A drag over blank transcript selects nothing and would
    // otherwise steal the caret at the end of it; a click that lands on an existing
    // selection still reads as selected at this instant, because Chromium defers
    // collapsing it to resolve click-versus-drag.
    const origin = pressOriginRef.current;
    pressOriginRef.current = null;
    if (!origin) return;
    // 3px, the usual drag slop: a hand holding a mouse still moves a pixel or two, and
    // treating that as a drag would make click-to-type fail intermittently.
    if (Math.abs(e.clientX - origin.x) > 3 || Math.abs(e.clientY - origin.y) > 3) return;
    // A multi-click selects a word or a line and means to keep it.
    if (e.detail > 1) return;
    // Shift-click extends an existing selection rather than starting a new one.
    if (e.shiftKey) return;

    // Asked one task later, once the click's own default action has collapsed whatever
    // was selected. Reading it here would still see the OLD selection and decline to
    // focus, which is why clicking a selection used to leave the caret nowhere at all.
    setTimeout(() => {
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      // The composer is the input bar's editor now; the old textarea ref was left
      // dangling by the swap, so clicking the pane focused nothing.
      composerRef.current?.focus();
    }, 0);
  }, []);

  // Closed once nothing can be sent. Leaving it live let a click erase the draft and
  // report a command run against an engine that had stopped.
  /**
   * The engine's advertised commands, in the input bar's own shape.
   *
   * `scope: "built-in"` because that is what they are from the bar's point of view —
   * they ship with the engine, there is no file behind them and nothing to discover.
   */
  const slashCommands = useMemo(
    () =>
      state.commands.map((c) => ({
        id: c.name,
        label: c.name.startsWith("/") ? c.name : `/${c.name}`,
        description: c.palette,
        scope: "built-in" as const,
        agentId: "daintree-assistant" as const,
        trigger: "/" as const,
      })),
    [state.commands]
  );

  /**
   * The panel's whole palette, derived from the TERMINAL theme with contrast floors.
   *
   * The derivation — and the reasoning behind every floor — lives in `./palette.ts`,
   * beside the contract test that walks every shipped terminal scheme and checks it.
   * Two things it fixes are worth naming here, because both shipped:
   *
   *   - The panel painted its ground from the terminal theme and its ink from the APP's
   *     tokens. Those are chosen independently, so a light app theme with a dark
   *     terminal put dark ink on a dark ground: 1.03:1, invisible.
   *   - Replacing those tokens with fixed percentage mixes of the terminal foreground
   *     looked right and still failed, because a percentage cannot know what it is
   *     standing on. Solarized Light's own foreground is 4.13:1 before anything is
   *     derived from it; ANSI yellow on Ayu Light is 1.84:1.
   */
  // `termTheme` as well as `term`: `resolveInputBarColors` narrows the 16 ANSI slots
  // away, and fenced-code syntax is coloured from them. Passed straight through rather
  // than widening `InputBarColors` — that shape is the INPUT BAR's contract, shared with
  // the terminal composer, and growing it to carry colours only this panel reads would
  // make every consumer of it pay for one.
  const paletteVars = useMemo(() => buildAssistantPalette(term, termTheme), [term, termTheme]);

  const shellVars = {
    "--ib-bg": term.shellBg,
    "--ib-border": term.shellBorder,
    "--ib-border-hover": term.shellBorderHover,
    "--ib-border-focus": term.shellBorderFocus,
    "--ib-shadow": term.shellShadow,
    "--ib-focus-ring": term.shellFocusRing,
    "--ib-hover-bg": term.shellHoverBg,
    "--ib-focus-bg": term.shellFocusBg,
    "--ib-fg": term.foreground,
    // Derived from the terminal foreground rather than a panel token: a fixed
    // placeholder colour that is legible on the panel surface can be invisible on a
    // terminal theme, and the placeholder is the one string that tells a first-time
    // user what this box is for.
    "--ib-placeholder": `color-mix(in oklab, ${term.foreground} 45%, transparent)`,
  } satisfies Record<string, string>;

  return (
    <div
      // `assistant-panel` sets the terminal typeface across the whole surface — the
      // masthead, the activity rows, the notices — not just the prose. A pane that is
      // mono in its message body and sans in its chrome reads as two things stitched
      // together; the terminal beside it is one typeface throughout.
      className={cn("assistant-panel flex h-full min-h-0 cursor-text flex-col", className)}
      // Custom properties are not part of `CSSProperties`, so the cast is at the point
      // of USE and covers only this object rather than widening the declaration above.
      style={
        {
          backgroundColor: paletteVars["--assistant-surface"],
          // The CORRECTED foreground, not the terminal's raw one.
          //
          // This is what every unstyled element in the panel inherits, so setting the
          // raw value here quietly exempted them all from the correction the palette
          // exists to apply: on a theme whose own foreground is under the floor
          // (Solarized Light is 4.13:1), each tier was corrected and then any text that
          // simply did not name a colour inherited the uncorrected one anyway.
          color: paletteVars["--assistant-fg"],
          // Everything in the panel sizes off this, so one setting moves the whole
          // surface together instead of only the parts that named a size.
          "--assistant-font-family": termFontFamily,
          "--assistant-font-size": `${termFontSize}px`,
          ...paletteVars,
          ...shellVars,
        } as React.CSSProperties
      }
      onMouseDown={notePress}
      onMouseUp={focusComposer}
      onKeyDown={onPanelKeyDown}
    >
      {deckOpen && onRequestOperations ? (
        <AssistantOperationsDeck
          operations={state.operations}
          onRefresh={onRequestOperations}
          onClose={() => setDeckOpen(false)}
        />
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
        >
          {!booting && <Masthead state={state} live={live} />}
          {booting ? (
            // The boot state: the mark draws itself while the engine connects, ALONE —
            // masthead and composer wait for `onDone` rather than arriving underneath a
            // still-drawing mark, so the reveal reads as one deliberate sequence
            // (splash, then panel) instead of two animations landing at once.
            <div className="flex h-full flex-col items-center justify-center">
              <AssistantBootSplash
                // Keyed on the boot generation so a NEW session replays the reveal from
                // frame one, while a session id arriving mid-reveal does not.
                key={bootGen}
                onDone={() => setSplashedGen(bootGen)}
                className="w-full px-6"
              />
            </div>
          ) : empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <DaintreeIcon aria-hidden="true" className="size-6 text-[var(--assistant-fg-dim)]" />
              {/* Names what the assistant DOES. "Ask about this project" framed it as a
                question box, which is the one thing it is not: it plans work, spawns
                visible agents in worktrees and supervises them. It never edits files
                itself, and it can run several at once. Written as plain sentences with
                no dash: the em dash read as an aside, and driving OTHER agents rather
                than editing anything is the whole point, not a footnote. */}
              <p className="text-[1em] text-[var(--assistant-fg)]">Put agents to work</p>
              <p className="max-w-[26rem] text-[1em] text-[var(--assistant-fg-secondary)]">
                Plan a change and it spawns agents across your worktrees, as many as the job needs,
                then keeps watch on the runs. It doesn&rsquo;t edit files itself. Every agent it
                starts is one you can see and take over.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {state.turns.map((turn) => (
                <div key={turn.turnId} className="space-y-1">
                  <TurnBlock
                    turn={turn}
                    state={state}
                    onActivateReference={onActivateReference}
                    forgeAvailable={forgeAvailable}
                  />
                  {noticesByTurn.get(turn.turnId)?.map((notice) => (
                    <NoticeRow key={notice.id} notice={notice} />
                  ))}
                  {/* AFTER the turn's own notices, not inside `TurnBlock`.
                      A notice attributed to a turn is part of what happened in it — a
                      rate-limit warning, a retry — and the rule that closes the turn has
                      to come after everything it closes. Rendered from inside the block
                      it landed above them, so a five-second turn with a warning read as
                      "answer, end of turn, then an unattached warning". */}
                  <TurnEndcap turn={turn} />
                  {/* AFTER the endcap, because these did not happen inside the turn —
                      they arrived behind it. A command result belongs under the command
                      that produced it, and for a slash line that command IS the user
                      turn immediately above. */}
                  {anchoredNotices.get(turn.turnId)?.map((notice) => (
                    <NoticeRow key={notice.id} notice={notice} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* The cockpit's live status line, at the tail of the running turn rather
            than in the footer (internal/ui/render_turn.go renderLiveStatus).

            Placement is the whole point of it. Down in the composer strip it sits
            below the input, outside where anyone is reading, and a long silent
            stretch reads as the panel having died. Here it is the last thing in the
            transcript — exactly where the next output will appear — so "the model is
            working and has not said anything yet" is visible in the place you are
            already looking.

            Shown only for the silent phases: while tools run, the activity rows
            above are a better answer than a label repeating them. */}
          {liveLabel && (
            <div
              // aria-live so a screen reader hears the turn progressing; "polite"
              // because it must never cut across the prose being streamed above it.
              aria-live="polite"
              className={cn(
                "mt-3 flex items-baseline gap-1.5 text-[1em] tabular-nums",
                // A slow model and a hung one look identical without this.
                stalled ? "text-[var(--assistant-warning)]" : "text-[var(--assistant-fg-secondary)]"
              )}
            >
              <span aria-hidden="true" className="assistant-spinner" />
              <span>
                {liveLabel}
                {stalled && " · still working"}
                {elapsed && ` · ${elapsed}`}
              </span>
            </div>
          )}

          {state.queuedInterjections.map((queued, i) => (
            // The cockpit's queued follow-up. These sit after the running turn because
            // they have not landed anywhere yet — the engine decides whether to fold each
            // into this turn, and only then does it move into the transcript proper.
            <div
              key={`queued-${i}`}
              className="mt-3 rounded-md border border-dashed border-[var(--assistant-border-strong)] px-2 py-1.5 text-[1em] text-[var(--assistant-fg-secondary)]"
            >
              <span className="text-[var(--assistant-fg-secondary)]">Queued: </span>
              {queued}
            </div>
          ))}

          {/* Approvals sit at the bottom of the scroller, next to the composer, because
            they block the turn: they are the next thing to do, not history. */}
          {state.approvals.length > 0 && (
            <div className="mt-3 space-y-2">
              {state.approvals.map((approval: AssistantApproval) => (
                <AssistantApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  onDecide={onDecideApproval}
                  onGrant={onGrantTool}
                />
              ))}
            </div>
          )}

          {sessionNotices.length > 0 && (
            <div className="mt-3 space-y-0.5">
              {/* NOT truncated, and not a fixed-height strip. The cockpit committed every
                notice to scrollback as its own cell; showing only the last few is how a
                warning that mattered (the engine replaying a turn) disappeared behind
                the notices that followed it. Turn-scoped notices are drawn with their
                turn above; these are the ones the engine did not attribute to one. */}
              {sessionNotices.map((notice) => (
                <NoticeRow key={notice.id} notice={notice} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* No horizontal padding here: HybridInputBar carries its own, and doubling it
          is what made the assistant's input sit visibly further inset than the one in
          every terminal pane.

          Held back for the whole boot state, composer and status row alike: showing
          either underneath a still-drawing splash read as two things happening on top
          of each other rather than one boot finishing before the panel does. */}
      {!booting && (
        <div className="shrink-0 pb-2.5 pt-2.5">
          {state.pendingQuestion && onAnswerQuestion ? (
            // The sheet REPLACES the composer, as the cockpit's did: the engine has
            // parked the tool dispatch, so there is nothing a typed message could reach.
            // The status line below stays, because it is still true.
            <AssistantQuestionCard question={state.pendingQuestion} onAnswer={onAnswerQuestion} />
          ) : (
            <>
              {/* The terminal's OWN input bar, not a copy of it.
                This was a copy: the same border, radius and `--ib-*` variables, hand
                rebuilt around a plain textarea. It drifted immediately — different font,
                different size, a different command menu — which is what a copy always
                does. Now it is the component, so the two panes cannot look different
                without someone changing the thing both of them render.

                What the assistant supplies is the one thing that genuinely differs: its
                commands come from the engine over the host protocol, not from disk. */}
              <HybridInputBar
                ref={composerRef}
                terminalId={composerId}
                // Not a terminal pane surface, so it neither records nor obeys the
                // session-wide xterm-vs-input-bar preference. Writing it from here made
                // every click in this composer re-run the focus effect of whatever grid
                // terminal still held store focus, which took the caret back.
                participatesInTerminalFocus={false}
                cwd={cwd ?? ""}
                agentId="daintree-assistant"
                commands={slashCommands}
                disabled={!live}
                // The bar resolves Escape's local meanings first — close the completion
                // menu, collapse the expanded editor — and forwards what is left. For a
                // terminal that goes to the PTY; here it lands on the cockpit's Escape
                // matrix (internal/ui/composer/hints.go), minus the draft-clearing branch
                // the editor already owns.
                onSendKey={(key) => {
                  if (key !== "escape") return;
                  // Retract before cancel, as the cockpit ordered it: a follow-up typed
                  // mid-turn is buffered by the engine until the turn folds it in, so
                  // Escape can still pull it back. Cancelling instead would abandon the
                  // work when the user only asked to take back a message.
                  if (state.queuedInterjections.length > 0 && onRetractInterjection) {
                    onRetractInterjection();
                    return;
                  }
                  if (busy && interruptible !== false) onInterrupt();
                }}
                // The bar hands back a PTY payload as well; the engine takes prose. The
                // acceptance flag has to be RETURNED, not dropped: the shared send path
                // clears the draft on a truthy result, so swallowing a refusal is what
                // makes a prompt vanish when the session was not ready to take it.
                onSend={({ text }) => (text.trim() ? onSubmit(text) : false)}
              />
            </>
          )}

          {/* The status row under the composer.

          The cockpit put its adaptive key hints here (internal/ui/composer/keymap.go
          hintRow). Those hints now belong to the input bar, which owns the editor and
          teaches its own bindings — duplicating them here would state the composer's
          contract in a second place, free to drift from it.

          This is the narrowest row in the app, and it had grown to hold the phase, the
          stall warning, the clock, the standing approval, the context meter, the cost
          and an overflow button — at a sidebar's width that wrapped to two lines. What
          is left is one reading the transcript cannot give (the connection), the one
          control that has to be reachable mid-turn (stop), and the session readouts.

          The PHASE is gone from here on purpose. It was being drawn twice: once at the
          tail of the running turn, where the next output will appear and where anyone
          waiting is already looking, and again down here below the input. Two labels
          for one fact, and this was the copy with no room for it — "Inspecting
          project… · still working · 41s" is the longest string the phase vocabulary
          can produce and it is unbounded from here, since a future phase label is
          whatever the engine names it.

          The CLOCK is gone from here too, for the same reason and one more: it was
          also drawn at the tail of the running turn, and down here it sat right next
          to "Connected" — reading as how long the session had been connected, not how
          long the current turn had been running. */}

          <div
            data-testid="assistant-status-row"
            className="mt-1.5 flex items-center gap-2 px-3.5 text-[0.92em] text-[var(--assistant-fg-secondary)]"
          >
            {/* A DOT, then the word, as the cockpit drew it (render_chrome.go). The word
              alone made the one line that is true for the whole session read as body
              text; a lit dot is what says "live" at a glance. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state.connection !== "ready"
                    ? "bg-[var(--assistant-fg-secondary)]"
                    : state.mcpUnavailable
                      ? "bg-[var(--assistant-warning-graphic)]"
                      : "bg-[var(--assistant-success-graphic)]"
                )}
              />
              {/* Truncated, not wrapped. `state.connection` carries whatever the host
                names the state, so the width of this cell is not something this
                component gets to know — and the row has to stay one line. */}
              <span className="truncate">
                {state.connection === "ready"
                  ? state.mcpUnavailable
                    ? // Qualified deliberately. The engine is up, but it cannot reach
                      // Daintree — so it can talk and cannot act, and "Connected" alone
                      // would describe only the half that works.
                      "Connected · no Daintree tools"
                    : "Connected"
                  : state.connection}
              </span>
            </span>

            {busy && (
              // Stop lives outside the input bar because the bar has no concept of a turn
              // in flight — it drives a PTY, where Ctrl-C is the out.
              //
              // Anchored to the LEFT, beside the status it acts on, rather than floating
              // right-aligned on a strip of its own above this row. Right-aligned put it
              // at the end of a queue of readouts whose widths change as the turn runs —
              // a control that moves while you reach for it — and the strip made the
              // composer three stacked rows deep.
              <button
                type="button"
                onClick={onInterrupt}
                disabled={interruptible === false}
                aria-label="Stop"
                title={
                  interruptible === false
                    ? "Background work the assistant started on its own — it will finish on its own"
                    : "Stop this turn (Esc)"
                }
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5",
                  // Colour, not transparency, for the resting state. `opacity` scales the
                  // element toward whatever is behind it and drags its contrast floor
                  // down with it — and stop is a control someone reaches for mid-turn,
                  // when they are least inclined to hunt for it.
                  "text-[var(--assistant-fg-secondary)] transition-colors duration-150 ease-out",
                  "hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]",
                  "disabled:pointer-events-none disabled:opacity-40"
                )}
              >
                <Square aria-hidden="true" className="size-2.5 fill-current" />
                Stop
              </button>
            )}

            <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
              {/* Both describe a LIVE session, so neither survives it stopping:
                "Auto-approve on" over a dead engine states a standing permission that
                no longer applies to anything, and "Rate limited" a condition nothing
                is subject to. */}
              {live && state.rateLimited && (
                <span className="text-[var(--assistant-warning)]">Rate limited</span>
              )}
              {/* Auto-approve is a standing state, not an event — if confirmations are
                off that must stay visible for the whole session. Worded as what is
                switched ON, because "approvals off" reads ambiguously as "approving is
                unavailable" rather than "nothing will ask you". */}
              {/* "on" is carried by the fact that it is drawn at all — the row shows
                nothing when the setting is off — so the word was spending width in the
                one place there is least of it to say what its presence already says.
                The full sentence still lives in the masthead.

                `whitespace-nowrap` because it is a two-word label in a flex row that
                can be squeezed: without it, "Auto-approve" broke across the hyphen and
                took the whole row to two lines. */}
              {live && state.autoApprove && (
                <span className="whitespace-nowrap font-medium text-[var(--assistant-danger)]">
                  Auto-approve
                </span>
              )}
              {/* Nothing is a floor of zero. A backend that reports no cost figures at
                all yields total 0 with complete false, and "≥ $0.00" is clutter that
                says less than saying nothing — the cockpit stayed silent on unknown
                cost for the same reason. */}
              {state.cost && (state.cost.total > 0 || state.cost.complete) && (
                <span className="whitespace-nowrap">
                  {formatCost(state.cost.total, state.cost.complete)}
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
