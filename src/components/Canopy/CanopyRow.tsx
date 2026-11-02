import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { BAND_GLYPH_TONE, PilotRunState } from "@/components/Pilot/PilotRunState";
import { Archive, ArchiveRestore, Mic } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AskingCircle, Clock } from "@/components/icons";
import type { CanopyCategory } from "@shared/types/ipc/canopy";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { formatTimeAgo } from "@/utils/timeAgo";
import { pluralize } from "@/lib/pluralize";
import {
  answerOptions,
  itemAnswerAttention,
  itemContextWarning,
  itemFacts,
  itemArchived,
  itemHandled,
  itemIsBusy,
  itemLooksDone,
  itemNeedsAttention,
  itemProgress,
  itemSubject,
  repeatsSubject,
  shownPriority,
  unseenLabelMs,
  type CanopyItem,
} from "./canopyModel";

/** Waiting on the user at least this long, the row's clock stands out. */
export const OVERDUE_WAIT_MS = 5 * 60_000;

/** What a run is doing when the readers have nothing better to say. */
export const KIND_LABEL: Record<CanopyCategory, string> = {
  approval: "Wants approval",
  question: "Asking you",
  error: "Stopped on an error",
  finished: "Finished",
  working: "Working",
  running: "Running",
  idle: "Idle",
};

/**
 * The ask: what the run needs from the user, or what it is doing. Words from an
 * earlier reading stay until a new one replaces them, so a row never blanks
 * while its screen is re-read — except on a run back at work, which says what
 * it is doing rather than what it last stopped on.
 */
export function rowStatus(item: CanopyItem): string {
  return glanceStatus(item) ?? KIND_LABEL[item.kind];
}

/**
 * The ask's words, or null when there are none and only the run's state can
 * be named. The readers' headline once written; before it — or instead of
 * words about a stop the run has left — the screen's own words at a glance.
 * Never words that only say the row's title again.
 */
function glanceStatus(item: CanopyItem): string | null {
  const status = statusWords(item);
  return status !== null && repeatsSubject(item, status) ? null : status;
}

function statusWords(item: CanopyItem): string | null {
  const card = item.card;
  const glance = item.glance;
  const busy = item.kind === "working" || item.kind === "running";
  // The classifier's pick, for the states Daintree's own shape rules read
  // worst: an error has no fixed grammar, and an interrupted turn ends on the
  // CLI's own words rather than a report. A one-word spinner says nothing.
  const picked =
    !item.stale && card?.statusLine && /\s/.test(card.statusLine) ? card.statusLine : null;
  const working = () => glance?.doing ?? picked ?? card?.activity ?? glance?.said ?? null;
  if (card !== null) {
    // Progress words stay between describes; words about a prompt or a stop
    // the run has since left behind give way to the step it is on, whatever
    // else the card says about how recent they are.
    const wordsAboutWork = card.wordsCategory === "working" || card.wordsCategory === "running";
    if (busy && !wordsAboutWork) return working();
    if (card.headline && !repeatsSubject(item, card.headline)) return card.headline;
    if (card.question) return card.question;
  }
  if (busy) return working();
  if (item.kind === "idle" || glance === null) return picked;
  if (item.kind === "error" || item.kind === "approval" || item.kind === "question") {
    return picked ?? glance.said;
  }
  // A stop not worded yet: the agent's own recap, else its newest report,
  // each opening sentence alone — the rest goes beneath it. A turn the
  // classifier saw interrupted says so before a report written before it.
  if (glance.recap === null && picked !== null && /\binterrupt|\bcancel/i.test(picked)) {
    return picked;
  }
  const lead = glance.recap ?? glance.said;
  return lead === null ? picked : firstSentence(lead).head;
}

/**
 * What goes under the ask before the readers have written a summary: the
 * rest of the recap or report the ask opened with, or the agent's newest
 * words beside a question or a working step. Null when the screen offers
 * nothing more than the ask already says.
 */
export function glanceDetail(item: CanopyItem, status: string): string | null {
  const glance = item.glance;
  if (!glance || item.kind === "idle") return null;
  const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  if (glance.recap !== null && status === firstSentence(glance.recap).head) {
    const rest = firstSentence(glance.recap).rest;
    if (rest !== null) return rest;
    // A one-sentence recap: the report beneath it, less any opening that
    // says the same.
    if (glance.said === null) return null;
    if (!flat(glance.said).startsWith(flat(status))) return glance.said;
    return firstSentence(glance.said).rest;
  }
  if (glance.said === null) return null;
  const { head, rest } = firstSentence(glance.said);
  // The ask is often the report's own opening — the question it ends on, or
  // the line the classifier picked from it — so beneath it goes what follows.
  if (
    flat(status).startsWith(flat(head)) ||
    flat(head).startsWith(flat(firstSentence(status).head))
  ) {
    return rest;
  }
  return glance.said === status ? null : glance.said;
}

/** A text's opening sentence, and what follows it (null when nothing does). */
export function firstSentence(text: string): { head: string; rest: string | null } {
  const match = /^(.{12,}?[.!?])\s+(\S.*)$/s.exec(text);
  if (!match) return { head: text, rest: null };
  return { head: match[1]!, rest: match[2]! };
}

/**
 * How old the reader's words beside it are: `Read 2m ago` for words on the
 * screen as it was read (inside Canopy the reader needs no naming), `Earlier screen` — with
 * `read failed` or `reading again` as the case may be — for words kept after
 * the run moved on. Null for words that are not the reader's. Never a
 * confidence number: the age is what lets the user judge the reading.
 */
export function readerAttribution(item: CanopyItem, nowMs: number): string | null {
  const card = item.card;
  if (card === null) return null;
  if (item.stale || card.wordsFromEarlierRead) {
    if (item.failed) return "Earlier screen, read failed";
    if (item.pending) return "Earlier screen, reading again";
    return "Earlier screen";
  }
  return `Read ${formatTimeAgo(card.observedAt, nowMs)}`;
}

/**
 * The attribution as a row can afford it: a fresh read says nothing, its age
 * left to the selected pane and the row's description — it is the same "just
 * now" down a list read in one pass. Words kept from an earlier screen still
 * say so in full: that is news.
 */
export function readerTag(item: CanopyItem, nowMs: number): string | null {
  const card = item.card;
  if (card === null || !(item.stale || card.wordsFromEarlierRead)) return null;
  return readerAttribution(item, nowMs);
}

/** When a snooze lifts, as the clock on the wall says it. */
function snoozedLabel(until: number | undefined): string {
  if (until === undefined) return "Snoozed";
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    until
  );
  return `Snoozed until ${time}`;
}

/** Whether the ask is the reader's own headline or question, not a glance or a category label. */
function statusIsReaderWords(item: CanopyItem, status: string): boolean {
  const card = item.card;
  return (
    card !== null &&
    card.stage === "described" &&
    (status === card.headline || status === card.question)
  );
}

/**
 * What the row leaves to the selected pane: the summary (or a risky approval's
 * reason, or the screen's own words), the command an approval would run, how
 * far through its task the run is, and what the agent reported.
 */
export function itemDetail(item: CanopyItem): {
  detail: string | null;
  action: string | null;
  progress: ReturnType<typeof itemProgress>;
  facts: string[];
  contextWarning: string | null;
  /** The detail is the reader's summary or risk note, not the screen's own words. */
  readerWritten: boolean;
} {
  const card = item.card;
  const status = rowStatus(item);
  const wordsShown =
    card !== null &&
    (status === card.headline ||
      status === card.question ||
      (card.headline !== null && repeatsSubject(item, card.headline)));
  const caution = card?.risk === "caution" && wordsShown && !item.stale;
  const summary =
    card?.summary && card.summary !== status && !repeatsSubject(item, card.summary)
      ? card.summary
      : null;
  const glanceDetailText =
    summary === null && card?.stage !== "described" ? glanceDetail(item, status) : null;
  const glanceText =
    glanceDetailText !== null && !repeatsSubject(item, glanceDetailText) ? glanceDetailText : null;
  const action =
    !item.stale && item.kind === "approval" && (wordsShown || card?.stage !== "described")
      ? (card?.action ?? item.glance?.action ?? null)
      : null;
  const detail =
    caution && card?.riskReason
      ? `${card.riskReason}.${summary ? ` ${summary}` : ""}`
      : (summary ?? glanceText);
  return {
    detail,
    action,
    progress: itemProgress(item),
    facts: itemFacts(item),
    contextWarning: itemContextWarning(item),
    readerWritten: detail !== null && (summary !== null || (caution && !!card?.riskReason)),
  };
}

/** The meta line's separator: the same space either side, wherever it falls. */
export function MetaDot() {
  return <span className="shrink-0 px-1">·</span>;
}

/**
 * How long a row has been in its state, where a mail list puts the date; the
 * glyph at the left already says which state.
 */
export function CanopyRowAge({
  age,
  overdue,
  yieldsToArchive = false,
}: {
  age: string;
  overdue: boolean;
  /** The archive button takes its place under the pointer. */
  yieldsToArchive?: boolean;
}) {
  return (
    <span
      data-overdue={overdue || undefined}
      data-canopy-age=""
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs leading-4 whitespace-nowrap tabular-nums",
        // Left waiting this long, the wait itself is the news: the clock
        // steps up to full ink, never to colour — that stays the glyph's.
        overdue ? "font-medium text-text-primary" : "text-text-secondary",
        // Faded, it still sits over the archive button that takes its
        // place: it lets the pointer through, or the click lands on it.
        yieldsToArchive &&
          "transition-opacity duration-150 group-hover/row:pointer-events-none group-hover/row:opacity-0"
      )}
    >
      <Clock aria-hidden="true" className="size-3.5" />
      {age === "just now" ? "now" : age}
    </span>
  );
}

/**
 * The location line says location only: project, worktree, host. The host
 * has a slot of its own that holds its width while the worktree gives way,
 * and the project keeps its name longer than either.
 */
export function CanopyWhereLine({
  emoji,
  project,
  worktree,
  host,
}: {
  emoji: string | null;
  project: string | null;
  worktree: string | null;
  host: string | null;
}) {
  return (
    <span
      data-canopy-where=""
      className="flex h-4 min-w-0 items-center overflow-hidden text-xs leading-4 whitespace-nowrap text-text-secondary"
    >
      {/* The emoji leads a place, never stands for one. */}
      {emoji && (project !== null || worktree !== null || host !== null) && (
        <span className="mr-1.5 shrink-0 leading-none select-none">{emoji}</span>
      )}
      {project !== null && (
        <span data-canopy-project="" className="max-w-[45%] min-w-0 shrink-[0.5] truncate">
          {project}
        </span>
      )}
      {worktree !== null && (
        <span data-canopy-worktree="" className="flex max-w-max min-w-0 grow basis-12">
          {project !== null && <MetaDot />}
          <span className="min-w-0 truncate">{worktree}</span>
        </span>
      )}
      {host !== null && (
        <span data-canopy-host="" className="flex max-w-[35%] min-w-12 shrink-0">
          {(project !== null || worktree !== null) && <MetaDot />}
          <span className="min-w-0 truncate">{host}</span>
        </span>
      )}
    </span>
  );
}

interface CanopyRowProps {
  item: CanopyItem;
  domId: string;
  isSelected: boolean;
  /** The run did something the user hasn't seen since they last looked, or they marked it unread. */
  unread: boolean;
  /** Archived rows: a one-line status, still where they run. */
  compact?: boolean;
  /** The panel's clock, for how long a busy run has gone unseen. */
  nowMs: number;
  /** The row its group's Tab stop lands on: the selected row, else the group's first. */
  tabbable: boolean;
  /** What the user did to put it aside and when ("Replied 2m ago"), or null. */
  asideLabel?: string | null;
  /** Which assistant started it or holds it, from main's own records; null when none is known. */
  workLabel?: string | null;
  /** A dictation is writing into this run's reply, whichever row is selected. */
  dictating?: boolean;
  onSelect: () => void;
  /** A click on the row: the user opened it. */
  onClick: () => void;
  /** A double-click on the row: go to its terminal (Cmd/Ctrl: in a new window). */
  onOpen: (event: React.MouseEvent<HTMLElement>) => void;
  /**
   * Archive the run, or bring it back: offered on the row under the pointer,
   * for a mouse. The keyboard has E, and the context menu says so.
   */
  onArchive?: () => void;
}

/**
 * One agent in the inbox. A leading column holds what Daintree observed — its
 * state, whose agent, and the clock for that state; beside it, the task it is
 * carrying out, what it needs from you, and, always on its bottom
 * line, the project (its emoji and name) and worktree it runs in. An unread run
 * carries a heavier name, as a mail list's does: a mark in the gutter would sit
 * outside the lead column and make the list's left edge ragged. The list's
 * order is its priority; the row shows why it ranks there in words, never as a
 * score — on screen or read aloud. A click opens its terminal beside the list.
 */
function parkedLabel(note: string | undefined): string {
  const trimmed = note?.trim();
  return trimmed ? `Parked: ${trimmed}` : "Parked";
}

export function CanopyRow({
  item,
  domId,
  isSelected,
  unread,
  compact = false,
  nowMs,
  tabbable,
  asideLabel = null,
  workLabel = null,
  dictating = false,
  onSelect,
  onClick,
  onOpen,
  onArchive,
}: CanopyRowProps) {
  const { row } = item;
  const card = item.card;
  const subject = itemSubject(item);
  const status = rowStatus(item);
  const priority = shownPriority(item, nowMs);
  const unseenMs = compact ? null : unseenLabelMs(item, nowMs);
  // Why a busy run ranks where it does: not a reading, but how long it has
  // gone without the user looking at it — said apart from "unread", which is
  // about what it did, not about being looked at.
  const unseenLabel =
    unseenMs === null ? null : `Not checked ${formatWaitAge(nowMs - unseenMs, nowMs)}`;
  const handled = itemHandled(item);
  const archived = itemArchived(item);
  // The reading's words are on the row, under the title or as it: a headline
  // dropped for saying the title again still counts as said.
  const wordsShown =
    card !== null &&
    (status === card.headline ||
      status === card.question ||
      (card.headline !== null && repeatsSubject(item, card.headline)));
  // Where it runs, on every row: the bottom line always says which project,
  // even on a row titled after it or a list that is all one project.
  const project = item.workspace.name || null;
  const worktree = row.worktreeLabel !== subject ? row.worktreeLabel : null;
  const host = item.workspace.host || null;
  const where = [project, worktree, host].filter(Boolean).join(" · ");
  // A first read in flight, with no words yet: in the ask's place, or under a
  // verbatim question that is already on screen. A re-read keeps the words it
  // has until the new ones land.
  // Words the screen gave at a glance stand in meanwhile, so only a row with
  // none of its own shows the reading placeholder.
  const reading = item.pending && !item.stale && card?.headline == null;
  const caution = card?.risk === "caution" && wordsShown && !item.stale;
  const WarningGlyph = SEVERITY_GLYPH.warning;
  // An approval whose command is on show already says enough: no placeholder.
  const detail = compact ? null : itemDetail(item);
  const action = detail?.action ?? null;
  const progress = detail?.progress ?? null;
  const facts = detail?.facts ?? [];
  const hasAction = action !== null;
  const readingInAsk = reading && glanceStatus(item) === null && !hasAction;

  // Waiting on the user, and the screen shows it asking something: the
  // waiting ring takes a question mark. Only on a reading of the screen as it
  // is now — the reader tells a question from a finished turn — and only while
  // Daintree itself sees the agent waiting.
  const asking =
    item.kind === "question" &&
    card !== null &&
    // The reading of the screen as it is now is enough: words still from an
    // earlier one don't make the ask any less current.
    !item.stale &&
    // A screen that moved and has not been read again yet.
    !card.priorityFromEarlierRead &&
    // Never over the blocked mark: an observed error keeps its own shape. A
    // hand-back band is no bar: the passive classifier's fallback prompt is
    // exactly the screen the reader can tell is a question.
    (row.band === "needs-you" || row.band === "review" || row.band === "done") &&
    row.run.agentState === "waiting";

  const looksDone = itemLooksDone(item);
  const needsYou = itemNeedsAttention(item);
  // An agent left blocked on the user for minutes: the commonest way a fleet
  // loses time is a prompt nobody saw since it appeared.
  const overdue =
    !compact &&
    needsYou &&
    row.run.agentState === "waiting" &&
    row.run.since !== undefined &&
    nowMs - row.run.since >= OVERDUE_WAIT_MS;
  const choices = compact ? [] : answerOptions(item);
  // The user's own decision, said first so a held ask is never read as live.
  const asideWord =
    row.run.park !== undefined
      ? parkedLabel(row.run.park.note)
      : row.run.snooze !== undefined
        ? snoozedLabel(row.run.snooze.snoozedUntil)
        : null;
  // A run put aside says why on its ask line, in the user's own words: the held
  // ask waits in the selected pane, so it is never read here as live.
  // A quiet run with no words of its own is named for its band, not "Working".
  const quietLead = row.band === "quiet" && glanceStatus(item) === null;
  const leadWord = asideWord ?? (quietLead ? "Quiet" : null);
  // What follows the ask on its line, each part whole. Quiet and working share
  // the spinner and differ only in hue once motion is reduced; the word says
  // which, since the clock beside the glyph is only a time. Everything else the
  // run reported or is carrying out waits in the selected pane.
  const stalledSince = card?.stalledSince ?? null;
  const stalled =
    !compact && row.band !== "quiet" && stalledSince !== null && itemIsBusy(item)
      ? `No change ${formatWaitAge(stalledSince, nowMs)}`
      : null;
  // The reader's words carry who read them and when; a failed read then says
  // so there, not in a tail that clips.
  const attribution =
    !compact && !reading && leadWord === null && statusIsReaderWords(item, status)
      ? readerAttribution(item, nowMs)
      : null;
  const tag = attribution !== null ? readerTag(item, nowMs) : null;
  // One health note beside the attribution at most, the most pressing first,
  // so the trailing words can never outgrow the ask they follow; the rest are
  // in the row's description and the selected pane.
  // Decisions saw an answer for this run stop on its way in. Daintree's own
  // observation, and the reason the run sits with what needs the user, so it
  // leads the tail.
  const answers = itemAnswerAttention(item);
  const answerNote =
    answers === 0
      ? null
      : answers === 1
        ? "Answer needs attention"
        : `${pluralize(answers, "answer")} need attention`;
  const statusTail = [
    answerNote,
    stalled,
    row.band === "quiet" && !quietLead ? "Quiet" : null,
    item.failed && attribution === null ? "Read failed" : null,
    asideLabel,
    unseenLabel,
  ]
    .filter((part): part is string => part !== null)
    .slice(0, 1);
  const askId = `${domId}-ask`;
  const metaId = `${domId}-meta`;
  // The name is only which agent this is, so arrowing down the list hears
  // each one at once; the ask, then the state and where it runs follow as its
  // description.
  const accessibleName = [subject, row.chrome.label !== subject ? row.chrome.label : null]
    .filter(Boolean)
    .join(", ");
  const meta = [
    dictating ? "dictating a reply" : null,
    unread ? "unread" : null,
    asking ? "asking you a question" : null,
    looksDone ? "looks done" : null,
    asideWord !== null ? asideWord.toLowerCase() : null,
    row.agePhrase,
    !compact && row.band !== "quiet" && card?.stalledSince != null && itemIsBusy(item)
      ? `screen unchanged for ${formatWaitAge(card.stalledSince, nowMs)}`
      : null,
    overdue ? "waiting a while" : null,
    answerNote !== null ? answerNote.toLowerCase() : null,
    progress?.spoken ?? null,
    facts.length > 0 ? `reported ${facts.map((fact) => fact.toLowerCase()).join(", ")}` : null,
    compact ? null : itemContextWarning(item),
    caution && card?.riskReason ? `caution: ${card.riskReason}` : null,
    action !== null ? `for ${action}` : null,
    choices.length > 0
      ? `answer with ${choices.map((choice, index) => `${index + 1} ${choice}`).join(", ")}`
      : null,
    unseenLabel !== null ? unseenLabel.toLowerCase() : null,
    workLabel,
    where,
    asideLabel !== null ? asideLabel.toLowerCase() : handled ? "replied" : null,
    item.failed ? "read failed" : null,
    attribution !== null ? attribution.toLowerCase() : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== "")
    .join(", ");

  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={accessibleName}
      aria-describedby={[askId, metaId].join(" ")}
      tabIndex={tabbable ? 0 : -1}
      data-canopy-card=""
      data-kind={item.kind}
      data-priority={compact || priority === null ? undefined : priority}
      data-unread={unread ? "true" : undefined}
      onFocus={() => {
        if (!isSelected) onSelect();
      }}
      onClick={() => {
        onSelect();
        onClick();
      }}
      onDoubleClick={onOpen}
      className={cn(
        // One size whichever group the row is in.
        "canopy-inbox-row group/row relative flex w-full shrink-0 cursor-pointer items-stretch gap-3 px-3 py-2.5 text-left"
      )}
    >
      {onArchive && (
        // Named as the context menu names it, with the key that does it from
        // the keyboard. Hover only: the button never takes focus, so its
        // tooltip never opens on one.
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              data-canopy-row-archive=""
              // A mouse affordance: it never takes focus, so the press neither
              // selects the row on its way nor leaves focus somewhere hidden.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onArchive();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              // In the age's place on the name line, which gives way to
              // it under the pointer, as a mail list's actions take the date's.
              // 24px square for WCAG 2.5.8: it sits inside the row's own target.
              className="absolute top-2 right-1.5 flex size-6 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 hover:bg-overlay-highlight hover:text-text-primary [&_svg]:size-3.5"
            >
              {archived ? <ArchiveRestore /> : <Archive />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent(archived ? "Move to inbox" : "Archive", "E")}
          </TooltipContent>
        </Tooltip>
      )}
      {/* The leading column: Daintree's own observation of the run and whose
          agent it is. The text beside it gets the full width. */}
      <span id={metaId} className="sr-only">
        {meta}
      </span>
      <span aria-hidden="true" data-canopy-lead="" className="flex w-10 shrink-0 flex-col">
        <span className="flex h-5 items-center gap-2">
          <span
            className="flex size-4 items-center justify-center"
            data-asking={asking || undefined}
          >
            {asking ? (
              <AskingCircle className={`size-3.5 shrink-0 ${BAND_GLYPH_TONE[row.band]}`} />
            ) : (
              <PilotRunState band={row.band} agentState={row.run.agentState} />
            )}
          </span>
          <span className="flex size-4 items-center justify-center">
            <TerminalIcon
              chrome={row.chrome}
              className="h-4 w-4"
              brandColor={row.presetColor ?? row.chrome.color}
            />
          </span>
        </span>
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm leading-5 text-text-primary",
              unread && "font-semibold"
            )}
          >
            {subject}
          </span>
          {/* Its reply is still taking dictation, wherever the selection went:
              the indicator in the toolbar brings it back. */}
          {dictating && (
            <Mic data-canopy-dictating="" className="size-3.5 shrink-0 text-text-secondary" />
          )}
          {row.age !== null && (
            <CanopyRowAge age={row.age} overdue={overdue} yieldsToArchive={!!onArchive} />
          )}
        </span>
        <span id={askId} className="flex h-4 min-w-0 items-center gap-1.5 text-xs leading-4">
          <span
            className={cn(
              "min-w-0 truncate",
              readingInAsk && "canopy-reading",
              // What it wants stays in full ink after it has been looked at:
              // reading a request doesn't make it any less outstanding. A run
              // that needs nothing from the user steps down a tone, so the ones
              // that do stand out down the list without a colour of their own.
              !compact && !readingInAsk && needsYou && leadWord === null
                ? "text-text-primary"
                : "text-text-secondary"
            )}
          >
            {readingInAsk ? "Reading the screen…" : (leadWord ?? status)}
          </span>
          {/* Beside the words it qualifies, not out at the line's far end. */}
          {caution && leadWord === null && (
            <WarningGlyph className="size-3.5 shrink-0 text-status-warning" />
          )}
          {(tag !== null || statusTail.length > 0) && (
            <span className="ml-auto flex max-w-[55%] min-w-0 shrink-0 items-center gap-2 pl-1.5 text-text-secondary">
              {tag !== null && (
                <span data-canopy-attribution="" className="min-w-0 truncate">
                  {tag}
                </span>
              )}
              {statusTail.map((part) =>
                // The reason the run sits with what needs the user: full ink and
                // the warning shape, so it outranks the run's own status words.
                part === answerNote ? (
                  <span
                    key={part}
                    data-canopy-answer-attention=""
                    className="flex min-w-0 items-center gap-1 text-text-primary"
                  >
                    <WarningGlyph className="size-3.5 shrink-0 text-status-warning" />
                    <span className="truncate">{part}</span>
                  </span>
                ) : (
                  <span key={part} className="min-w-0 truncate">
                    {part}
                  </span>
                )
              )}
            </span>
          )}
        </span>
        <CanopyWhereLine
          emoji={item.workspace.emoji ?? null}
          project={project}
          worktree={worktree}
          host={host}
        />
      </span>
    </div>
  );
}
