import { memo } from "react";
import { Check, ChevronRight, CircleDashed, Hourglass, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantToolCall } from "@/store/assistantStore";

/**
 * One tool call in the transcript.
 *
 * The states are not decoration — each one means something different about who is
 * blocked, and the row is designed so that reads at a glance:
 *
 * - `queued`   the batch was announced; this call has not started. Shown from the
 *              moment the batch lands so a five-step plan reads as a plan rather than
 *              as the assistant improvising one call at a time.
 * - `active`   running. Also the state of an accepted async call whose work continues
 *              in the background — never rendered as finished.
 * - `waiting`  blocked on the USER, not on the tool. This is the one that must not
 *              look like ordinary progress: otherwise someone watches a spinner that
 *              is waiting for their own unanswered approval.
 * - `done` / `failed` settled.
 * - `cancelled` / `not-run` terminal after an interrupt: was running vs never started.
 */

interface StateStyle {
  Icon: typeof Check;
  /**
   * The GLYPH's colour. Semantic status colours, never the accent.
   *
   * Split from the label's because the two answer to different contrast floors: an icon
   * has to be recognisable (WCAG's 3:1 for non-text), a label has to be readable (4.5:1).
   * Holding them to the same figure means one of them is wrong — either the glyph is
   * pushed so far toward black or white that it stops being the theme's own red, or the
   * label is left at a ratio nobody can read. See `palette.ts`.
   */
  glyph: string;
  /** The LABEL's colour. Always a text tier. */
  ink: string;
  label: string;
  spin?: boolean;
}

function styleFor(call: AssistantToolCall): StateStyle {
  switch (call.state) {
    case "queued":
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-dim)]",
        // Not the dim tier: "Queued" is a word someone reads, and dim is the
        // decoration tier that only answers to the 3:1 graphical floor.
        ink: "text-[var(--assistant-fg-secondary)]",
        label: "Queued",
      };
    case "active":
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-secondary)]",
        ink: "text-[var(--assistant-fg-secondary)]",
        // "Handed off", not "Running": the engine gives the work to its runtime and
        // reports completion later as its own wake turn, never back to this row. This
        // panel cannot know whether it is still going, so a present-tense claim goes
        // stale the moment it finishes and keeps asserting something untrue.
        label: call.asyncId ? "Handed off to run in the background" : "Running",
        // An accepted ASYNC call does not spin. The engine handed the work to its
        // runtime and delivers completion later as its own wake turn, never as a late
        // result for this call — so nothing will ever settle this row, and a spinner
        // that never stops reads as a hang rather than as work continuing elsewhere.
        // It is terminal for THIS turn, which is exactly how the cockpit drew it.
        spin: !call.asyncId,
      };
    case "waiting":
      // Amber, and worded from the user's side: the system is not busy, it is waiting
      // for them.
      return {
        Icon: Hourglass,
        glyph: "text-[var(--assistant-warning-graphic)]",
        ink: "text-[var(--assistant-warning)]",
        label: "Needs your approval",
      };
    case "failed":
      return {
        Icon: X,
        glyph: "text-[var(--assistant-danger-graphic)]",
        ink: "text-[var(--assistant-danger)]",
        label: "Failed",
      };
    case "cancelled":
      // Neutral, not danger: the user stopped it deliberately. Colouring their own
      // decision as an error reads as something having gone wrong.
      return {
        Icon: X,
        glyph: "text-[var(--assistant-fg-dim)]",
        ink: "text-[var(--assistant-fg-secondary)]",
        label: "Cancelled",
      };
    case "not-run":
      // Announced but never started, so nothing happened at all — worth saying,
      // because "the model planned this" and "the model did this" are different facts.
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-dim)]",
        ink: "text-[var(--assistant-fg-secondary)]",
        label: "Not run",
      };
    case "done":
    default:
      return {
        Icon: Check,
        glyph: "text-[var(--assistant-success-graphic)]",
        ink: "text-[var(--assistant-success)]",
        label: "Done",
      };
  }
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * The in-progress verb in effect for a call, if any.
 *
 * `activeVerb` is the present-participle form the engine supplies for the handful of
 * tools that visibly block for many seconds ("Waiting", "Extracting"), and it holds only
 * until the call settles — after which the past tense is the true one. Everything else
 * settles fast enough that the settled label never reads wrong, so its absence means
 * "keep the settled one".
 *
 * Exported because the collapsed group header names the SAME calls. Reading `verb` there
 * while the rows read `activeVerb` printed "Waited on terminals · 1 still running" — one
 * header disagreeing with itself about whether the call had finished.
 */
export function inProgressVerb(call: AssistantToolCall): string | undefined {
  const inProgress = call.state === "queued" || call.state === "active" || call.state === "waiting";
  return inProgress ? call.activeVerb : undefined;
}

export interface AssistantToolRowProps {
  call: AssistantToolCall;
}

export const AssistantToolRow = memo(function AssistantToolRow({ call }: AssistantToolRowProps) {
  const { Icon, glyph, ink, label, spin } = styleFor(call);
  // A duration is only meaningful for a call that has actually FINISHED. An accepted
  // async call reports how long the dispatch took while the work carries on in the
  // background, so showing "1.2s" there reads as "done in 1.2s" — the precise
  // misreading the async state exists to prevent. The state label wins instead.
  const settled = call.state === "done" || call.state === "failed";
  // A cancelled or never-started call has no duration worth showing: the first ran for
  // an arbitrary slice of time that means nothing, the second for none at all.
  const duration = settled ? formatDuration(call.durationMs) : null;

  // A past tense on a row that has not finished reads as already done, so an
  // in-progress verb wins while there is one.
  const activeVerb = inProgressVerb(call);
  const verb = activeVerb ?? call.verb;

  // A running row whose verb the engine wrote for exactly this state does not also need
  // "Running" in the status slot: "Waiting on 3 terminals · Running" is one call
  // described twice, in two words that disagree about what it is doing. The spinner
  // already carries liveness. Only `active` — "Queued", "Needs your approval" and the
  // handed-off label each say something no verb does, and a settled row shows its
  // duration here instead.
  const statusRestatesVerb = call.state === "active" && !call.asyncId && activeVerb !== undefined;
  const status = duration ?? (statusRestatesVerb ? null : label);

  return (
    <li className="assistant-tool-row assistant-mark-row flex items-start py-1 assistant-text-base">
      <Icon
        aria-hidden="true"
        className={cn("mt-px size-3.5 shrink-0", glyph, spin && "animate-spin-slow")}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          {/* "Read src/main.go", not "fs.read" — the cockpit's activity tree led with a
              human verb and its object, and its own comment called that the brand
              signature. The verb is set in prose type; only the fallback identifier
              stays monospaced, because only then is a machine name being shown.

              Both come from the ENGINE, which holds the raw arguments the target is
              lifted from and reports nothing at all for a tool it does not know, rather
              than guessing a label. */}
          {verb ? (
            <span className="min-w-0 truncate assistant-text-sm text-[var(--assistant-fg)]">
              {verb}
              {call.target && (
                <span className="ml-1 text-[var(--assistant-fg-secondary)]">{call.target}</span>
              )}
            </span>
          ) : (
            <span className="truncate assistant-text-sm text-[var(--assistant-fg)]">
              {call.toolId}
            </span>
          )}
          {/* Only while the call is actually BLOCKED on the user. The engine tags every
              mutating call this way regardless of outcome, so showing it on a settled
              row — after the user already approved it, or auto-approve did — repeats
              amber alarm colour on a decision that is no longer live. Five agents
              spawned and checked off is not five things needing attention. */}
          {call.danger && call.state === "waiting" && (
            <TriangleAlert
              aria-label="Mutating action"
              className="size-3 shrink-0 text-[var(--assistant-warning-graphic)]"
            />
          )}
          {/* One slot renders either a duration (metadata) or a STATE (meaning), so
              its treatment has to follow the content. A state label in the muted slot
              measured ~4.1:1 in the dark theme — too faint for the thing telling you
              the assistant is blocked on your approval. */}
          {status && (
            <span
              className={cn(
                "ml-auto shrink-0 tabular-nums assistant-text-sm",
                duration ? "text-[var(--assistant-fg-secondary)]" : cn(ink, "font-medium")
              )}
            >
              {status}
            </span>
          )}
        </div>

        {/* The in-tool substep, when there is one — so a long call never looks frozen. */}
        {call.state === "active" && call.progress && (
          <p className="mt-0.5 truncate assistant-text-sm text-[var(--assistant-fg-secondary)]">
            {call.progress}
          </p>
        )}

        {/* What the tool says it DID, in its own words. The cockpit led with this
            rather than the identifier, and it is the difference between "git.push" and
            "Pushed 3 commits to origin/main". Shown above the arguments because the
            outcome matters more than the inputs once a call has settled. */}
        {/* What is running in the background, when the engine named it. The
            completion never comes back to this row, so this is the only chance to say
            what was handed off. */}
        {call.asyncId && call.asyncTitle && (
          <p className="mt-0.5 assistant-text-sm text-[var(--assistant-fg-secondary)]">
            {call.asyncTitle}
          </p>
        )}

        {call.summary && <p className="mt-0.5 assistant-text-sm">{call.summary}</p>}

        {call.argsSummary && (
          <p className="mt-0.5 truncate assistant-text-sm text-[var(--assistant-fg-secondary)]">
            {call.argsSummary}
          </p>
        )}

        {call.state === "failed" && (call.errorMessage ?? call.errorCode) && (
          <p className="mt-0.5 assistant-text-sm text-[var(--assistant-danger)]">
            {/* The sentence when there is one, the code only as a fallback: a bare
                code tells a reader that something failed, not what. */}
            {call.errorMessage ?? call.errorCode}
            {/* No size class on the span below: it sits INSIDE a `.assistant-text-sm`
                paragraph and `em` compounds, so restating the step there resolved to
                0.8464em — a third type step, below the chrome tier, on a panel that has
                exactly two and reserves anything smaller for keycaps. */}
            {call.errorMessage && call.errorCode && (
              <span className="ml-1 text-[var(--assistant-fg-secondary)]">({call.errorCode})</span>
            )}
          </p>
        )}
      </div>
    </li>
  );
});

/**
 * The aggregate state of a whole group, for the collapsed header's glyph.
 *
 * Deliberately NOT `AssistantToolCall["state"]`: a group of five calls has an outcome
 * that no single call's state describes, and the two that matter most here — work handed
 * off to keep running after the turn, and a group stopped part-way — do not exist in the
 * per-call vocabulary at all.
 */
export type AssistantToolGroupState =
  "done" | "failed" | "waiting" | "running" | "queued" | "handedOff" | "interrupted";

/**
 * The collapsed group's glyph and its accessible verb, reusing the expanded rows'
 * vocabulary on purpose: collapsed and expanded are one object in two states, so a
 * finished call must not be a green check in one and a bare chevron in the other.
 *
 * `word` is the past-tense clause the accessible name is built from — the screen-reader
 * user gets the completion state the sighted user reads off the glyph (WCAG 4.1.2).
 */
function groupStyleFor(state: AssistantToolGroupState): {
  Icon: typeof Check;
  glyph: string;
  word: string;
  spin?: boolean;
} {
  switch (state) {
    case "failed":
      return { Icon: X, glyph: "text-[var(--assistant-danger-graphic)]", word: "Failed" };
    case "waiting":
      return {
        Icon: Hourglass,
        glyph: "text-[var(--assistant-warning-graphic)]",
        word: "Waiting for approval on",
      };
    case "running":
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-secondary)]",
        word: "Running",
        spin: true,
      };
    case "queued":
      // Announced but not started. A dashed ring like running, but STILL — a spinner
      // here would claim work is under way when nothing has begun.
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-dim)]",
        word: "Queued",
      };
    case "handedOff":
      // Not a spinner. The work continues in the engine's runtime and reports back as
      // its own wake turn, so nothing will ever settle this header — a spinner here
      // reads as a hang rather than as work continuing elsewhere.
      return {
        Icon: CircleDashed,
        glyph: "text-[var(--assistant-fg-secondary)]",
        word: "Handed off",
      };
    case "interrupted":
      return { Icon: X, glyph: "text-[var(--assistant-fg-dim)]", word: "Stopped" };
    case "done":
    default:
      return { Icon: Check, glyph: "text-[var(--assistant-success-graphic)]", word: "Ran" };
  }
}

/**
 * The collapsed group header — the transcript's Tool Call Disclosure.
 *
 * Once a clean turn settles this row is the ONLY record in the chat history that a
 * function was ever called, so it has to read as one. It previously carried a dim
 * chevron and secondary-tier text on no surface at all, which is the documented "ghost
 * row" failure of this pattern: pushed so far back that it reads as a nav link or a
 * disabled label, and the reader cannot tell any action was taken. It was, measurably,
 * the quietest thing in the transcript — quieter than the markdown bullet list under it
 * and than the reference chips inside the answer.
 *
 * So it now borrows the expanded row's own grammar rather than inventing a quieter one:
 * the same inset surface, the same status glyph in the same status colours, the verb at
 * full ink, and the duration in the same right-aligned metadata slot. What keeps it
 * restrained is that nothing is ADDED beyond what a row already shows — no accent, no
 * border, no weight the rows do not have. It reads as significant because it looks like
 * the thing it summarises, not because it shouts.
 *
 * The chevron moves to the trailing edge, which is both the convention for this pattern
 * and a necessity once the leading slot carries the status.
 */
export function AssistantToolGroupHeader({
  count,
  failedCount = 0,
  runningCount = 0,
  awaitingApprovalCount = 0,
  queuedCount = 0,
  state = "done",
  durationMs,
  what,
  open,
  panelId,
  onToggle,
}: {
  count: number;
  /** Failures must remain visible when the group is collapsed. */
  failedCount?: number;
  /** Calls actively RUNNING. Excludes handed-off async work, queued, and waiting. */
  runningCount?: number;
  /**
   * Calls blocked on the USER's approval. Counted apart from running on purpose: the
   * system is not busy, it is waiting for them, and reporting that as "still running"
   * is how someone comes to watch a spinner that is waiting on their own answer.
   */
  awaitingApprovalCount?: number;
  /** Announced but not started. Not running — nothing has begun. */
  queuedCount?: number;
  /** The group's aggregate outcome, driving the glyph and the accessible name. */
  state?: AssistantToolGroupState;
  /**
   * Summed duration of the calls that reported one. A SUM, not wall-clock: a batch
   * dispatches concurrently, so this is total tool time and the accessible name says so
   * rather than claiming the turn took this long.
   */
  durationMs?: number;
  /**
   * What the batch actually DID, in the engine's verbs — the thing a bare count throws
   * away. A settled clean turn collapses by default, so without this the cockpit's
   * "Read src/main.go" became "1 action", which is the count of a fact rather than the
   * fact. Empty when no call in the batch resolved to a verb.
   */
  what?: string;
  open: boolean;
  /** The id of the list this button discloses, for `aria-controls`. */
  panelId: string;
  onToggle: () => void;
}) {
  const { Icon, glyph, word, spin } = groupStyleFor(state);
  const duration = formatDuration(durationMs);

  // "Ran 2 tool calls: Listed worktrees, Read git state" — the completion state a
  // sighted reader takes from the glyph, spelled out. Both glyphs stay aria-hidden so
  // the name is the only thing announced (WCAG 4.1.2).
  const calls = `${count} ${count === 1 ? "tool call" : "tool calls"}`;
  const accessibleName = [
    `${word} ${calls}`,
    what ? `: ${what}` : "",
    duration ? ` in ${duration} of tool time` : "",
    failedCount > 0 ? `, ${failedCount} failed` : "",
    awaitingApprovalCount > 0 ? `, ${awaitingApprovalCount} needs approval` : "",
    // Every live state, not just the two that used to be here. An `aria-label`
    // REPLACES the descendant text, so a group visibly itemised as one waiting, one
    // running and one queued announced itself as "Waiting for approval on 3 tool
    // calls, 1 needs approval" — a name that drops two thirds of the breakdown and
    // implies the leading state describes all three.
    runningCount > 0 ? `, ${runningCount} still running` : "",
    queuedCount > 0 ? `, ${queuedCount} queued` : "",
  ].join("");

  // The live counts are an AGGREGATE, and an aggregate over one row is that row's own
  // label read back to it — which is what put two spinners and two "running"s on screen
  // for a single call. Over several they say something no row does: how many of the
  // group are still going, when the rows that are may be below the fold.
  const showLiveCounts = !open || count > 1;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={accessibleName}
      className={cn(
        "assistant-tool-header flex w-full items-center gap-2 py-1 text-left",
        "assistant-text-sm",
        // No border and no radius: the expanded calls already hang under a left rule,
        // and a box here made the summary a third container shape in a single turn.
        // Hover is the affordance, and it bleeds the full width of the rail the way a
        // terminal highlights a line.
        "transition-colors duration-150 ease-out hover:bg-[var(--assistant-hover)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
      )}
    >
      {/* The glyph SHAPE always renders — it is the group's outcome, which the rows
          cannot state for themselves. The ANIMATION does not, once the group is open:
          every live row below carries its own spinner, so a spinning header put two
          spinners on screen for a single running call. Whichever of the two is on
          screen owns liveness; open, that is the rows. */}
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", glyph, spin && !open && "animate-spin-slow")}
      />

      {/* The verbs lead, at full ink, because they are what happened. Falling back to a
          call count rather than "N actions": "action" describes almost anything in an
          IDE, and the one thing this row exists to say is that a FUNCTION ran.

          Only while COLLAPSED, though. Open, the rows below say the same verbs in the
          same words — for a one-call group the header was a verbatim copy of the single
          row under it, which reads as the heading having been rendered twice. Expanded,
          the detail is already on screen, so the header steps back to what the rows
          cannot say for themselves: how many there are, and the group's outcome. */}
      {!open && what ? (
        <span className="min-w-0 truncate text-[var(--assistant-fg)]">{what}</span>
      ) : (
        <span className="min-w-0 truncate text-[var(--assistant-fg)]">{calls}</span>
      )}
      {!open && what && count > 1 && (
        <span className="shrink-0 text-[var(--assistant-fg-secondary)]">· {count}</span>
      )}

      {/* Survives collapse: otherwise a failed run and a clean one render the same
          header, and the outcome most worth noticing is the one that disappears. */}
      {failedCount > 0 && (
        <span className="shrink-0 font-medium text-[var(--assistant-danger)]">
          · {failedCount} failed
        </span>
      )}
      {/* The three LIVE counts. Suppressed only where they duplicate: one open call,
          whose row sits directly beneath saying that exact state in more words than a
          count can carry. Failures, above, are not suppressed at all — that is the
          outcome a reader must never have to expand a group to find.

          Approval leads: of the three, it is the only one that will not resolve
          without the reader. */}
      {showLiveCounts && awaitingApprovalCount > 0 && (
        <span className="shrink-0 font-medium text-[var(--assistant-warning)]">
          · {awaitingApprovalCount} needs approval
        </span>
      )}
      {/* An accepted async call keeps running after the turn ends, so "the turn
          finished" is not "the work finished". Saying so in the collapsed header is
          what stops a background agent from vanishing off the transcript. */}
      {showLiveCounts && runningCount > 0 && (
        <span className="shrink-0 font-medium text-[var(--assistant-fg-secondary)]">
          · {runningCount} still running
        </span>
      )}
      {showLiveCounts && queuedCount > 0 && (
        <span className="shrink-0 text-[var(--assistant-fg-secondary)]">
          · {queuedCount} queued
        </span>
      )}
      {/* "Handed off" existed only in the accessible name, so a sighted reader saw a
          static dashed circle, "1 tool call" and nothing else — formatted identically to
          a finished group, with the leading glyph at 14px carrying the entire difference
          between "done" and "an agent is still working on this somewhere else". */}
      {state === "handedOff" && (
        <span className="shrink-0 text-[var(--assistant-fg-secondary)]">· handed off</span>
      )}

      {/* The metadata slot, in the same place and the same tier the expanded rows put it
          — evidence the call cost real time, which a summary that hides it makes the
          reader expand the group to find. */}
      {duration && (
        <span className="ml-auto shrink-0 tabular-nums text-[var(--assistant-fg-secondary)]">
          {duration}
        </span>
      )}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0 text-[var(--assistant-fg-dim)]",
          "transition-transform duration-150 ease-out",
          open && "rotate-90",
          // Without a duration the chevron is what takes the trailing edge.
          !duration && "ml-auto"
        )}
      />
    </button>
  );
}
