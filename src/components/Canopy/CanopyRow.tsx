import { cn } from "@/lib/utils";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Kbd } from "@/components/ui/Kbd";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { BAND_GLYPH_TONE, PilotRunState } from "@/components/Pilot/PilotRunState";
import { Archive, ArchiveRestore } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AskingCircle, Clock } from "@/components/icons";
import type { CanopyCategory } from "@shared/types/ipc/canopy";
import { formatWaitAge } from "@/lib/projectRowStatus";
import {
  answerOptions,
  itemContextWarning,
  itemFacts,
  itemArchived,
  itemHandled,
  itemIsBusy,
  itemLooksDone,
  itemNeedsAttention,
  itemProgress,
  itemSubject,
  shownPriority,
  unseenLabelMs,
  type CanopyItem,
} from "./canopyModel";

/** Waiting on the user at least this long, the row's clock stands out. */
const OVERDUE_WAIT_MS = 5 * 60_000;

/** One line of a summary still being written; `SkeletonBone`'s look, as a span for the row's inline slot. */
const DETAIL_BONE = "block h-2 rounded-[var(--radius-xs)] bg-tint/[0.1] animate-pulse-delayed";

/** A dialog choice this short keeps its whole label on the row. */
const SHORT_CHOICE_CHARS = 16;

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
 */
function glanceStatus(item: CanopyItem): string | null {
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
    if (card.headline) return card.headline;
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

/** The meta line's separator: the same space either side, wherever it falls. */
function MetaDot() {
  return <span className="shrink-0 px-1">·</span>;
}

interface CanopyRowProps {
  item: CanopyItem;
  domId: string;
  isSelected: boolean;
  /** The run did something the user hasn't seen since they last looked, or they marked it unread. */
  unread: boolean;
  /** Archived rows: subject and status only. */
  compact?: boolean;
  /** Name the project beside the worktree: off while every row is in one project. */
  showProject?: boolean;
  /** The panel's clock, for how long a busy run has gone unseen. */
  nowMs: number;
  /** The row its group's Tab stop lands on: the selected row, else the group's first. */
  tabbable: boolean;
  /** Hold the summary's two lines even before any words exist. */
  reserveDetail: boolean;
  /** What the user did to put it aside and when ("Replied 2m ago"), or null. */
  asideLabel?: string | null;
  onSelect: () => void;
  /** A click on the row: the user opened it. */
  onClick: () => void;
  onOpen: () => void;
  /**
   * Archive the run, or bring it back: offered on the row under the pointer,
   * for a mouse. The keyboard has E, and the context menu says so.
   */
  onArchive?: () => void;
}

/**
 * One agent in the inbox. A leading column holds what Daintree observed — its
 * state, whose agent, and the clock for that state; beside it, the task it is
 * carrying out, what it needs from you, the summary, and the project (by its
 * emoji) and worktree it runs in. An unread run carries a dot in the gutter and
 * a heavier name. The list's order is its priority; the row shows why it ranks
 * there in words, never as a score — on screen or read aloud. A click opens its
 * terminal beside the list.
 */
export function CanopyRow({
  item,
  domId,
  isSelected,
  unread,
  compact = false,
  showProject = true,
  nowMs,
  tabbable,
  reserveDetail,
  asideLabel = null,
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
  // gone without the user looking at it.
  const unseenLabel = unseenMs === null ? null : `Unseen ${formatWaitAge(nowMs - unseenMs, nowMs)}`;
  const handled = itemHandled(item);
  const archived = itemArchived(item);
  const wordsShown = card !== null && (status === card.headline || status === card.question);
  // The summary stays when the run goes back to work and its ask gives way to
  // the newest line: a row always says what the run has been doing, until the
  // next reading replaces it.
  const summary = !compact && card?.summary && card.summary !== status ? card.summary : null;
  // Before the readers have written a summary, what the screen itself says
  // beyond the ask: the rest of a recap or report, the agent's last words.
  const glanceText =
    !compact && summary === null && card?.stage !== "described" ? glanceDetail(item, status) : null;
  // Where it runs, unless the row is already named after it.
  const project = showProject && subject !== item.workspace.name ? item.workspace.name : null;
  const worktree = row.worktreeLabel !== subject ? row.worktreeLabel : null;
  const where = [project, worktree].filter(Boolean).join(" · ");
  // A first read in flight, with no words yet: in the ask's place, or under a
  // verbatim question that is already on screen. A re-read keeps the words it
  // has until the new ones land.
  // Words the screen gave at a glance stand in meanwhile, so only a row with
  // none of its own shows the reading placeholder.
  const reading = item.pending && !item.stale && card?.headline == null;
  const caution = card?.risk === "caution" && wordsShown && !item.stale;
  const WarningGlyph = SEVERITY_GLYPH.warning;
  // What an approval would let the agent do, verbatim — the command or the
  // file — in the summary's place: the headline already says what is asked.
  // Before any reading, the command the dialog shows stands under the state.
  const action =
    !compact &&
    !item.stale &&
    item.kind === "approval" &&
    (wordsShown || card?.stage !== "described")
      ? (card?.action ?? item.glance?.action ?? null)
      : null;
  // The placeholder only where the row has no words of its own at all: an
  // approval whose command is on show already says enough.
  const readingInAsk = reading && glanceStatus(item) === null && action === null;
  const detail = compact
    ? null
    : caution && card?.riskReason
      ? `${card.riskReason}.${summary ? ` ${summary}` : ""}`
      : (summary ?? glanceText);

  // Waiting on the user, and the screen shows it asking something: the
  // waiting ring takes a question mark. Only on a reading of the screen as it
  // is now — the classifier's or the describer's, both tell a question from a
  // finished turn — and only while Daintree itself sees the agent waiting.
  const asking =
    item.kind === "question" &&
    card !== null &&
    // The classifier's reading of the screen as it is now is enough: words
    // still from an earlier one don't make the ask any less current.
    !item.stale &&
    // A screen that moved and has not been classified again yet.
    !card.priorityFromEarlierRead &&
    // Never over the blocked mark: an observed error keeps its own shape.
    row.band === "needs-you" &&
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
  // What follows where it runs, in order; only the reported facts give way
  // when the line runs out of room, each one whole.
  const metaTail: Array<{ text: string } | { facts: string[] }> = [];
  const progress = compact ? null : itemProgress(item);
  const facts = compact ? [] : itemFacts(item);
  const choices = compact ? [] : answerOptions(item);
  if (asideLabel !== null) metaTail.push({ text: asideLabel });
  // Quiet and working share the spinner and differ only in hue once motion is
  // reduced; the word says which, since the clock beside the glyph is only a time.
  if (row.band === "quiet") metaTail.push({ text: "Quiet" });
  // A reading, not an observation, so it is said as one: it looks done.
  if (!compact && looksDone) metaTail.push({ text: "Looks done" });
  if (facts.length > 0) metaTail.push({ facts });
  // Still behind a ticking spinner: Daintree's own quiet tracking cannot see it.
  const stalledSince = card?.stalledSince ?? null;
  if (!compact && row.band !== "quiet" && stalledSince !== null && itemIsBusy(item)) {
    metaTail.push({ text: `Still ${formatWaitAge(stalledSince, nowMs)}` });
  }
  const contextWarning = compact ? null : itemContextWarning(item);
  if (contextWarning !== null) metaTail.push({ text: contextWarning });
  if (unseenLabel !== null) metaTail.push({ text: unseenLabel });
  if (item.failed) metaTail.push({ text: "Read failed" });
  // Every inbox row keeps the same height, idle ones too: a run that goes idle
  // or wakes up must not move every row beneath it.
  // A summary on its way and nothing to stand in for it: its two lines show as
  // bones, so the row reads as written-so-far rather than empty.
  const detailDue = !compact && reading && detail === null && action === null;
  const holdsDetail = detail !== null || detailDue || (reserveDetail && !compact);
  const askId = `${domId}-ask`;
  const detailId = `${domId}-detail`;
  const metaId = `${domId}-meta`;
  // The name is only which agent this is, so arrowing down the list hears
  // each one at once; the ask, the summary, then the state and where it runs
  // follow as its description.
  const accessibleName = [subject, row.chrome.label !== subject ? row.chrome.label : null]
    .filter(Boolean)
    .join(", ");
  const meta = [
    unread ? "unread" : null,
    asking ? "asking you a question" : null,
    looksDone ? "looks done" : null,
    row.agePhrase,
    !compact && row.band !== "quiet" && card?.stalledSince != null && itemIsBusy(item)
      ? `still for ${formatWaitAge(card.stalledSince, nowMs)}`
      : null,
    overdue ? "waiting a while" : null,
    progress?.spoken ?? null,
    ...facts.map((fact) => fact.toLowerCase()),
    compact ? null : itemContextWarning(item),
    action !== null ? `for ${action}` : null,
    choices.length > 0
      ? `answer with ${choices.map((choice, index) => `${index + 1} ${choice}`).join(", ")}`
      : null,
    unseenLabel !== null ? unseenLabel.toLowerCase() : null,
    where,
    asideLabel !== null ? asideLabel.toLowerCase() : handled ? "replied" : null,
    item.failed ? "read failed" : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined && part !== "")
    .join(", ");

  return (
    <div
      id={domId}
      role="option"
      aria-selected={isSelected}
      aria-label={accessibleName}
      aria-describedby={[askId, detail !== null ? detailId : null, metaId]
        .filter(Boolean)
        .join(" ")}
      data-detail={detail !== null ? "true" : undefined}
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
      {/* Unread: a dot in the gutter, in a slot every row keeps, so a row
          read or unread never moves its text. Neutral ink — the focus ring
          owns this list's one accent. */}
      {unread && (
        <span
          aria-hidden="true"
          data-canopy-unread-dot=""
          className="absolute top-[17px] left-1 size-1.5 rounded-full bg-text-primary"
        />
      )}
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
              // In the progress meter's place on the name line, which gives way to
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
          agent it is, and how long it has been in that state. The text beside
          it gets the full width. */}
      <span id={metaId} className="sr-only">
        {meta}
      </span>
      <span aria-hidden="true" data-canopy-lead="" className="flex w-16 shrink-0 flex-col gap-1">
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
        {/* How long it has been in that state. The glyph above already says
            which state, so the clock carries only the time, on one line, a
            step quieter than the name. */}
        {row.age !== null && (
          <span
            data-overdue={overdue || undefined}
            data-canopy-age=""
            className={cn(
              "flex items-center gap-1.5 text-xs leading-4 whitespace-nowrap tabular-nums",
              // Left waiting this long, the wait itself is the news: the clock
              // steps up to full ink, never to colour — that stays the glyph's.
              overdue ? "font-medium text-text-primary" : "text-text-secondary"
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Clock aria-hidden="true" className="size-3.5" />
            </span>
            {row.age === "just now" ? "now" : row.age}
          </span>
        )}
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
          {/* How far through its task, where a mail list puts the date: a
              glance down the column reads the whole fleet's progress. */}
          {progress !== null && (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 text-xs leading-4 text-text-secondary tabular-nums",
                // Faded, it still sits over the archive button that takes its
                // place: it lets the pointer through, or the click lands on it.
                onArchive &&
                  "transition-opacity duration-150 group-hover/row:pointer-events-none group-hover/row:opacity-0"
              )}
            >
              <ProgressBar value={progress.value} label={progress.spoken} className="w-10" />
              <span className="min-w-7 text-right">{progress.label}</span>
            </span>
          )}
        </span>
        <span id={askId} className="flex h-4 min-w-0 items-center gap-2 text-xs leading-4">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              readingInAsk && "canopy-reading",
              // What it wants stays in full ink after it has been looked at:
              // reading a request doesn't make it any less outstanding. A run
              // that needs nothing from the user steps down a tone, so the ones
              // that do stand out down the list without a colour of their own.
              !compact && !readingInAsk && needsYou ? "text-text-primary" : "text-text-secondary"
            )}
          >
            {readingInAsk ? "Reading the screen…" : status}
          </span>
          {caution && <WarningGlyph className="size-3.5 shrink-0 text-status-warning" />}
        </span>
        {/* Two lines held whether the words are in or on their way, so a
            summary landing never pushes the rows below it down; a dialog's
            choices take the second, at the same line height. An idle agent
            holds them too, so going idle or waking moves nothing below it. */}
        {(holdsDetail || choices.length > 0) && (
          <span className="flex min-w-0 flex-col">
            {holdsDetail && (
              <span
                id={detailId}
                className={cn(
                  "text-xs leading-4 text-text-secondary",
                  // One line above a dialog's choices ends mid-word rather than
                  // at the last word that fits, which can leave a third of it empty.
                  choices.length > 0 ? "min-h-4 truncate" : "line-clamp-2 min-h-8"
                )}
              >
                {detailDue ? (
                  <span data-canopy-detail-due="" className="flex h-8 flex-col justify-around">
                    <span className={cn(DETAIL_BONE, "w-full")} />
                    <span className={cn(DETAIL_BONE, "w-2/3")} />
                  </span>
                ) : action !== null && !caution ? (
                  <span className="font-mono text-text-primary">
                    {/^[\w./-]+$/.test(action) && /[./]/.test(action) ? action : `$ ${action}`}
                  </span>
                ) : (
                  detail
                )}
              </span>
            )}
            {/* What the dialog offers, numbered as the keys that pick it from
                here: the strip carries its own remedy, one key away. Its key
                caps overhang the line by a pixel rather than grow it. */}
            {choices.length > 0 && (
              <span className="flex h-4 min-w-0 items-center gap-3 text-xs leading-4 text-text-secondary">
                {choices.map((choice, index) => (
                  <span
                    key={choice}
                    className={cn(
                      "flex items-center gap-1",
                      // A short choice ("Yes, proceed") is read whole; a long one
                      // ("Yes, and don't ask again for …") gives way first.
                      choice.length <= SHORT_CHOICE_CHARS ? "shrink-0" : "min-w-0"
                    )}
                  >
                    <Kbd className="shrink-0">{index + 1}</Kbd>
                    <span className="min-w-0 truncate">{choice}</span>
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
        {/* Held at its line's height even with nothing to say: facts landing,
            a reply noted or a run going quiet must not move the rows below. */}
        <span
          data-canopy-meta=""
          className="flex h-4 min-w-0 items-center text-xs leading-4 whitespace-nowrap text-text-secondary"
        >
          {/* The emoji leads a place, never stands for one: a row titled after
              its project drops the name here, and its emoji goes with it. */}
          {item.workspace.emoji && where !== "" && (
            <span className="mr-1.5 shrink-0 leading-none select-none">{item.workspace.emoji}</span>
          )}
          {/* Where it runs is how a row is told apart: the project keeps its
              name longest, the worktree's gives way before it, and the facts
              after them never take the last ten rems of the line. */}
          {project !== null && (
            <span className="max-w-[45%] min-w-0 shrink-0 truncate">{project}</span>
          )}
          {worktree !== null && (
            <span className="flex min-w-0 shrink-[4]">
              {project !== null && <MetaDot />}
              <span className="min-w-0 truncate">{worktree}</span>
            </span>
          )}
          {metaTail.map((part, index) => {
            const dot = index > 0 || where !== "" ? <MetaDot /> : null;
            if ("text" in part) {
              return (
                <span key={part.text} className="flex shrink-0">
                  {dot}
                  {part.text}
                </span>
              );
            }
            // A fact that doesn't fit drops whole rather than ending "Tests p…":
            // each wraps onto a second line the box clips, and the empty
            // first item holds the first line open for none of them.
            return (
              <span
                key="facts"
                className="flex h-4 max-w-[calc(100%-10rem)] shrink-0 flex-wrap overflow-hidden"
              >
                <span className="h-4 w-0" />
                {part.facts.map((fact, factIndex) => (
                  <span key={fact} className="flex shrink-0 whitespace-nowrap">
                    {(factIndex > 0 || dot !== null) && <MetaDot />}
                    {fact}
                  </span>
                ))}
              </span>
            );
          })}
        </span>
      </span>
    </div>
  );
}
