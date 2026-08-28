import type {
  SearchableProject,
  SearchableScratch,
  WorkspaceRowStatusFields,
} from "@/hooks/useProjectSwitcherPalette";
import { classifyAssistantActivity, type AssistantActivity } from "@/lib/projectAssistantActivity";
import { formatTimeAgo } from "@/utils/timeAgo";

/** Visual weight of a row's status line. Maps to status tokens, never the accent. */
export type ProjectRowTone =
  | "blocked"
  | "waiting"
  | "review"
  | "working"
  | "running"
  | "snoozed"
  | "muted"
  | "assistant"
  | "assistant-blocked";

/**
 * Text colour for a status line, by tone.
 *
 * Lives here rather than in the switcher that first used it so any surface
 * drawing a status sentence draws it in one vocabulary. The fleet overview no
 * longer prints a status word at all — its rows say the state with a glyph and
 * in their accessible name — so the switcher is the caller that keeps this
 * honest today.
 */
export const ROW_TONE_CLASS: Record<ProjectRowTone, string> = {
  blocked: "text-status-danger/80",
  waiting: "text-activity-waiting",
  // Finished-awaiting-review: the completed-state hue, distinct from both the
  // warning of a wait and the success-green of a healthy process. Never danger
  // — completion is the desired outcome, not a fault.
  review: "text-activity-completed",
  // Mark-only today: `working` is what a row draws when liveness has claimed a
  // mark demand had no use for, and such a row has no sentence to colour. The
  // entry stays because the map is total over the union — a tone must not be
  // able to ship without an answer here — and because a surface with room for a
  // "running" sentence should draw it in this hue rather than inventing one.
  working: "text-activity-working",
  running: "text-daintree-text/65",
  // Muted like the other settled states, and deliberately NOT the accent: a
  // snooze is the user telling this row to stop asking for them, so it must not
  // be the loudest thing in the list on the way out.
  //
  // One step above the age beside it, though. These states are the quietest
  // text on the row and the age is quieter still — at the same weight, "until
  // 3:45 PM" read as the headline and "1 snoozed" as its footnote, which is the
  // hierarchy upside down.
  snoozed: "text-daintree-text/65",
  muted: "text-daintree-text/65",
  // Machine-initiated work the user didn't launch, so it reads at the same
  // weight as the settled states rather than competing with the runs they
  // started (#11806).
  assistant: "text-daintree-text/65",
  // An assistant that failed says so in the danger hue — the severity is real
  // — while its dot stays hollow, so it never reads as a worker run.
  "assistant-blocked": "text-status-danger/80",
};

/**
 * The mark for one tone, as the utility classes that draw it.
 *
 * The mark answers one question: is this project busy, and does any of it want
 * me? The row's line says who and how many; the band says how urgent. The mark
 * only carries those two facts, and it carries them in colour:
 *
 * - green, filled — something is executing here. Agents, the assistant, or
 *   both; the line beside it says which.
 * - amber, filled — something has stopped and is waiting on the user.
 * - red, filled — something is blocked: stopped on a failure, where input may
 *   not restart it.
 * - green/amber pie — both at once, in the proportion of the counts
 *   (see `AgentMixDot` and `runningShare`).
 * - hollow ring — settled: finished and seen, or snoozed (dashed).
 * - no mark at all — the project is merely open, which its presence in the
 *   list already says (#11692).
 *
 * One standing exception: `review` keeps the completed hue, which derives from
 * `status-success` and so reads green in most palettes even though nothing is
 * executing. It predates this legend and the row's line always names the count
 * ("2 ready for review"), so it is recorded here rather than quietly reconciled.
 *
 * A hollow ring must never land on a row with something running. It used to:
 * an assistant waiting beside a working agent took the mark and drew it grey,
 * so a project with an agent in flight reported itself as idle.
 */
export const ROW_DOT_CLASS: Record<ProjectRowTone, string> = {
  blocked: "bg-status-danger",
  waiting: "bg-status-warning",
  review: "bg-activity-completed",
  // Filled and pulsing, the way every other surface draws a run in flight. This
  // tone is only ever reached as the liveness fallback now — a row with real
  // demand keeps its demand hue — so the pulse lands on the rows whose only
  // fact is that they are moving, and nowhere near twenty at once.
  working: "bg-activity-working animate-activity-pulse",
  // Same hue as `working` and for the same reason: this is a run in flight, not
  // a run that succeeded. It sat on `status-success` until #12002, which reads
  // as "finished well" in every palette that separates the two.
  //
  // That makes it identical to `working` wherever the pulse is off — reduced
  // motion and performance mode both kill `animate-activity-pulse`. Deliberate:
  // the legend above draws one filled green for "something is executing here",
  // and these are its two spellings. Which one is executing is the row's line's
  // job ("2 running" against "1 process running"), not the mark's.
  running: "bg-activity-working",
  // Dashed rather than solid, because "snoozed" and "settled" are different
  // facts and the switcher's greys already carry the settled ones. Colour alone
  // could not separate them — a dashed ring reads as temporarily suspended at a
  // glance, and survives both high-contrast modes and a colour-blind reader.
  snoozed: "border border-dashed border-daintree-text/40",
  // Hollow, because "finished" and "suspended" are settled states rather than
  // live ones. It used to sit on every dormant row too, which made a ring the
  // most common mark in the list and left it competing with the filled dots
  // that mean something — dormant rows draw no dot at all now (#11692), so the
  // ring is back to marking the two muted states that earned a line.
  muted: "border border-daintree-text/20",
  // Amber, like any other wait. Only ever reached with nothing running — a
  // live row hands the mark to the run — so this is a project that has fully
  // stopped and has the assistant sitting at its prompt. Who is waiting is the
  // line's job to say; the mark says only that someone is. It was hollow grey
  // under #11806, on the theory that the assistant is not a run the user
  // launched, but that made the mark answer "who" instead of "does this want
  // me", and grey is how the row says nobody is waiting at all.
  assistant: "bg-status-warning",
  // Filled danger, and it keeps the mark even on a row whose agents are still
  // running: a failed assistant is not a slower wait, and green beside it would
  // report the project as healthy.
  "assistant-blocked": "bg-status-danger",
};

/**
 * The colour each tone paints with, as a CSS value rather than a utility class.
 *
 * Parallel to `ROW_DOT_CLASS` because the mark draws two ways: a solid mark is
 * a class on a div, and a two-tone mark is a pair of SVG fills, which need
 * actual colour values and cannot be assembled out of Tailwind backgrounds. The
 * two maps are kept adjacent and both total over the union, so a tone added
 * later has to answer for both or fail to compile.
 *
 * The ring tones resolve to the same greys their borders use. They cannot reach
 * the split mark today — a settled tone hands the mark to the run rather than
 * splitting it — but the map is total over the union, so a tone added later
 * cannot ship without a colour and silently paint transparent.
 */
export const ROW_MARK_COLOR: Record<ProjectRowTone, string> = {
  blocked: "var(--color-status-danger)",
  waiting: "var(--color-status-warning)",
  review: "var(--color-activity-completed)",
  working: "var(--color-activity-working)",
  running: "var(--color-activity-working)",
  snoozed: "rgb(from var(--color-text-primary) r g b / 0.4)",
  muted: "rgb(from var(--color-text-primary) r g b / 0.2)",
  assistant: "var(--color-status-warning)",
  "assistant-blocked": "var(--color-status-danger)",
};

/**
 * Share of the mark the running agents take (#11832).
 *
 * The exact proportion: a project with three runs against one wait draws
 * three-quarters green, and one with seven against five draws the angle those
 * twelve actually make. An earlier version snapped this to quarters on the
 * theory that angle is a weak channel at 8px — true of *reading* a pie, but the
 * mark is not asked to be measured. Snapping bought nothing and cost accuracy:
 * the five statements it allowed were as hard to tell apart as the real angles
 * would have been, and every one of them was a lie about the counts printed on
 * the same row.
 *
 * `MIN_VISIBLE_SHARE` is the one departure, and only at the extremes. A single
 * run among fifty is 2% of the disc — a sub-pixel splinter that either
 * disappears into antialiasing or reads as a rendering artefact — so any
 * non-zero count keeps a wedge wide enough to be a wedge. The exact figures
 * lead the line beside the mark, which is where anyone who needs them reads
 * them anyway.
 */
const MIN_VISIBLE_SHARE = 0.06;

export function runningShare(mix: { demand: number; running: number }): number {
  const total = mix.demand + mix.running;
  if (total === 0) return 0;
  if (mix.demand === 0) return 1;
  if (mix.running === 0) return 0;

  const share = mix.running / total;
  return Math.min(1 - MIN_VISIBLE_SHARE, Math.max(MIN_VISIBLE_SHARE, share));
}

/**
 * Wording boundary between "just finished" and plain "finished" on a
 * ready-for-review line. Copy only — it never affects band membership,
 * ordering, or acknowledgement, so being wrong here costs a word, not an
 * event.
 */
export const JUST_FINISHED_MS = 15 * 60_000;

export interface ProjectRowStatus {
  /** Status sentence, or the fallback "Opened …" line when the row has nothing to report. */
  text: string;
  tone: ProjectRowTone;
  /**
   * The row's running work, as the count itself: "2 agents running", or
   * "Assistant working" when the machine's own session is the only thing
   * executing.
   *
   * A count rather than a flag, because "how many of my agents are still
   * going" is the question this surface gets asked — a boolean can say that
   * something is moving but never that four things are, and four is the answer
   * someone came here for. Absent when nothing is running, so its absence is
   * the other half of the signal: a row with a wait and no count is a row that
   * has fully stopped on you.
   *
   * Rendered in its own trailing column rather than trailing the sentence, so
   * the number sits at the same place on every row and a fleet reads down it in
   * one pass.
   */
  livenessDetail?: string;
  /**
   * The tone the leading mark draws in, or null when the row has earned no mark
   * at all.
   *
   * Demand first: a row that wants something marks itself with what it wants.
   * Liveness only claims the mark when demand has nothing to say — a project
   * quietly running four agents is not asking for anything, so it takes the
   * working hue rather than leaving the slot empty. Dormant rows keep the empty
   * slot #11692 gave them.
   *
   * Derived here rather than read off `tone` by the renderer, because the two
   * genuinely differ: the liveness fallback carries the dormant line's `muted`
   * tone for its (absent) text while marking itself as working.
   */
  markTone: ProjectRowTone | null;
  /**
   * When the row's state started, phrased for the end of the line: "oldest 10m",
   * "just finished 3m ago", "until 3:45 PM".
   *
   * Split out of the sentence rather than appended to it, because it is the one
   * fragment on the line that is never a demand. Inside the sentence it wore
   * the demand hue, which made the coloured run long enough to outweigh the
   * running count that leads the line — the age is the slowest-moving fact
   * here, so it draws in the quietest ink.
   */
  ageDetail?: string;
  /**
   * How the row's agents split between running and asking, as the two counts
   * the mark weighs against each other — or null when the row has no agents in
   * either bucket and its mark is a plain settled one.
   *
   * `demand` counts the agents the row's own sentence is about, so the mark and
   * the line can never disagree about how many there are: waits (blocked
   * included, since a block is a wait that needs more) for the waiting tiers,
   * unreviewed hand-backs for the review tier, and zero for the settled tones,
   * where nothing is being asked of anyone. `running` is the same figure the
   * count column prints.
   *
   * Both are raw counts rather than a ready-made fraction: the floor the mark
   * applies to keep a lone agent visible at 8px is a rendering decision, and a
   * classifier that had already clamped would leave the renderer unable to tell
   * a genuine near-zero share from a floored one.
   */
  agentMix: { demand: number; running: number } | null;
  /**
   * Disambiguating path fragment, present only when this project's folder name
   * collides with another registered project's, so identical-looking monorepo
   * siblings can be told apart without giving every row a second line of chrome
   * it doesn't need. Trails the status sentence where there is one, and stands
   * alone on a row that has gone quiet — it describes which project this is,
   * not what it is doing, so it outlives the status line.
   */
  pathHint?: string;
  /**
   * Set only by the opened-time fallback — the line a row shows when it has
   * nothing else to say (#11692). Callers use it to drop both the status line
   * and the leading dot, so an ordinary row is one line with no mark on it.
   *
   * Deliberately not derived from `tone`. `muted` also carries "Agent finished
   * · 2h ago" and "Suspended to free memory", which are facts a row earned and
   * keeps — a tone check would silently delete them along with the timestamps.
   */
  isDormantFallback?: true;
  /**
   * Set when this status will yield its leading dot to the resumable-agent mark
   * (#11801, #11822). Both of the rows that reach it have stopped: the
   * opened-time fallback draws no dot at all, and an auto-parked project keeps
   * its explanatory line but has only a settled ring to give up.
   *
   * Separate from `isDormantFallback` because the two answer different
   * questions. That flag decides whether a row has a second line; this one
   * decides which mark wins the slot, and auto-park needs to say yes to the
   * second while still saying no to the first.
   *
   * Unset is the conservative answer: a status that says what a project is
   * doing keeps its own dot, so a state added later cannot start promising a
   * resume it was never classified for.
   */
  allowsResumeMark?: true;
}

/** Compact duration for a wait that is already minutes old. Sub-minute reads as "just now". */
export function formatWaitAge(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - sinceMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Age for one end of a "3m–2h ago" completion range. Sub-minute clamps to
 * "1m" rather than "just now" — a range needs two comparable durations, and
 * "just now–2h ago" doesn't parse as one.
 */
function formatRangeAge(sinceMs: number, nowMs: number): string {
  const age = formatWaitAge(sinceMs, nowMs);
  return age === "just now" ? "1m" : age;
}

/** "3m" → "3m ago", "just now" stays bare — "just now ago" is not a phrase. */
export function agoPhrase(age: string): string {
  return age === "just now" ? age : `${age} ago`;
}

function pluralAgents(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/**
 * A snooze's wake time as a wall clock reading ("3:45 PM"), in the user's own
 * locale and hour convention.
 *
 * A clock time rather than a duration because it is the one form that stays
 * true without being redrawn: "until 3:45 PM" is as correct ten minutes later
 * as when it rendered, so the row never needs a ticking timer to stay honest.
 */
export function formatWakeTime(wakeAtMs: number): string {
  return new Date(wakeAtMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A status line before the liveness axis is attached.
 *
 * The cascade below answers only "what does this row want?", and every one of
 * its branches would otherwise have to remember to answer the second question
 * too. Leaving liveness out of it entirely, and deriving it once in
 * `withLiveness`, is what makes a branch added later live-aware for free.
 */
type ActivityLine = Omit<
  ProjectRowStatus,
  "pathHint" | "livenessDetail" | "markTone" | "agentMix"
> & {
  /**
   * How many agents this line is about, for the mark to weigh against the
   * running count. Left unset by the tones that ask for nothing — a settled or
   * suppressed line has no demand to give the mark, which is different from
   * having a demand of zero agents only in that nobody has to remember to say
   * so.
   */
  demandCount?: number;
  /**
   * Set by the one line that reports the assistant working — presence, not
   * demand (#11806) — which changes two things.
   *
   * It suppresses the assistant half of the count, since the sentence has
   * already said it; a row whose agents are also running still gets its number,
   * because "Assistant working" was never an answer to how many of them there
   * are. And it yields the mark to a real run: the assistant's hollow ring
   * outranks nothing, so a project with two agents in flight marks itself with
   * them rather than with the machine keeping itself busy alongside.
   */
  assistantPresenceLine?: true;
};

/**
 * Attaches the liveness axis to a finished status line.
 *
 * Worker runs come from `activeAgentCount`, which is already exactly the right
 * set: it counts the agents actually executing, and a snoozed run that is still
 * working is inside it — snoozing withholds a row from the demanding tallies, it
 * does not stop the run. `processCount` is deliberately not consulted: it nets
 * out the assistant's own PTY and lags the truth by a poll interval, so a row
 * would claim to be moving after its last agent stopped.
 *
 * A working assistant counts as live. It is excluded from every worker tally on
 * purpose (#11806) and stays excluded from the number — inventing an agent the
 * user never launched is the thing that exclusion exists to prevent — but "is
 * anything still executing" is a different question from "how many of my runs",
 * and answering it "no" while the assistant works would make the row a lie.
 *
 * Also the one place the mark is decided, because that decision needs both
 * axes: which hue it takes, and how its two counts weigh against each other.
 */
function withLiveness(
  line: ActivityLine,
  workspace: WorkspaceRowStatusFields
): Omit<ProjectRowStatus, "pathHint"> {
  const { assistantPresenceLine, demandCount = 0, ...status } = line;
  const running = workspace.activeAgentCount;
  const isLive = running > 0 || classifyAssistantActivity(workspace) === "working";

  // Running owns the mark unless a worker is asking for something. The lines
  // that yield — a dormant fallback, either assistant line, and the two settled
  // tones — describe a project nothing is stopped on, so a row with anything
  // executing marks itself green rather than as empty, as the assistant's, or
  // as the snooze it happens to also carry.
  //
  // The assistant yields both its states that can coexist with a run: it is one
  // session the user can look at whenever they want, and it must not be able to
  // paint a project that is still working as a project that has stopped.
  //
  // Deliberately NOT every tone with a zero demand count. "Directory not found"
  // and a blocked assistant both report zero agents and both still need saying:
  // a row that turned green because its actionable state involved no agents
  // would be hiding the one fact it exists to raise.
  const yieldsMark =
    status.isDormantFallback === true ||
    assistantPresenceLine === true ||
    status.tone === "assistant" ||
    status.tone === "snoozed" ||
    status.tone === "muted";
  // `isLive`, not `running > 0`: a working assistant is something executing,
  // and the mark's green means exactly that. The count beside it still speaks
  // only for the runs the user launched (#11806) — that is the line's question,
  // not the mark's.
  const markTone: ProjectRowTone | null =
    yieldsMark && isLive ? "working" : status.isDormantFallback ? null : status.tone;

  // The weighting the mark draws (#11832). Null on a row with no agents in
  // either bucket, which is what leaves the settled tones their plain ring:
  // a mark that weighed 0 against 0 would have nothing to divide.
  const agentMix = demandCount > 0 || running > 0 ? { demand: demandCount, running } : null;

  // Nothing running and no working assistant: the row has no second fact.
  if (!isLive) return { ...status, markTone, agentMix };

  // A live row never promises a resume, whichever branch above offered one. The
  // auto-park sweep flips a project to closed while its counts arrive on a
  // debounce, so a settled line can land on a row whose agents are still going
  // — and a resume is the wrong tense for an agent that never stopped.
  // Stripped here rather than in the renderer so the status object itself
  // cannot carry the contradiction.
  delete status.allowsResumeMark;

  // Agents first. The assistant only reaches the count when it is the sole
  // thing executing, and then only if the sentence has not already said so.
  if (running === 0) {
    if (assistantPresenceLine) return { ...status, markTone, agentMix };
    return { ...status, markTone, agentMix, livenessDetail: "Assistant working" };
  }

  return {
    ...status,
    markTone,
    agentMix,
    // Named, not just numbered. The noun grounds the row's most important
    // figure and keeps it apart from the process and assistant counts that use
    // the same shape of phrase.
    livenessDetail: pluralAgents(running, "1 agent running", "agents running"),
  };
}

/**
 * The assistant's line: it says what the assistant is, never a count (#11806).
 *
 * "Assistant working", not "1 agent running" — the assistant is one thing and
 * always has been, so a number would be inventing a plural that cannot exist,
 * and calling it an agent would claim a run the user never launched. Waits
 * carry their age for the same reason worker waits do: one that started forty
 * seconds ago and one that started forty minutes ago are different situations.
 *
 * A wait reads the same whether or not it has gone unseen. Escalation moves the
 * row into "Needs attention", which is a louder statement than any adjective
 * this line could add.
 */
function assistantStatus(
  activity: Exclude<AssistantActivity, null>,
  since: number | undefined,
  nowMs: number
): ActivityLine {
  if (activity === "working") {
    // Names the live work itself, so it never also trails "· Assistant working".
    return { text: "Assistant working", tone: "assistant", assistantPresenceLine: true };
  }

  const lead = activity === "blocked" ? "Assistant blocked" : "Assistant waiting";
  const tone: ProjectRowTone = activity === "blocked" ? "assistant-blocked" : "assistant";
  const age = since !== undefined ? formatWaitAge(since, nowMs) : null;
  return age ? { text: lead, tone, ageDetail: age } : { text: lead, tone };
}

/**
 * The activity half of a row's status line — everything derived purely from
 * agent counts, and so identical for a project and a scratch.
 *
 * Ordered by what would make someone act: a blocked agent first (it has stopped
 * and input may not restart it), then agents waiting on the user, then finished
 * work awaiting review, then the settled states. Counts and
 * ages are carried through rather than collapsed to "Agent waiting…" — one
 * waiting agent and eight are different situations, and a wait that started
 * forty minutes ago is a different situation from one that started forty
 * seconds ago.
 *
 * Returns null when the row has nothing to say, leaving the caller to supply
 * the dormant line its own kind understands (a project can be auto-parked; a
 * scratch only ever has an opened time). A row whose agents are running is one
 * of those cases: running is not a tier here, so it has no sentence to win.
 *
 * Answers the demand axis only. Liveness is attached afterwards by
 * `withLiveness`, which is why a branch here can drop a running agent from its
 * sentence without the row losing the fact (#11832).
 */
function classifyWorkspaceActivity(
  project: WorkspaceRowStatusFields,
  nowMs: number
): ActivityLine | null {
  // Classified once, consumed at three different heights below. Sharing the
  // helper with `sectionForProject` is what keeps a row's band and its line
  // telling the same story about the assistant. Not an absolute guarantee: the
  // palette freezes band membership while it is open (#11071) and lets the
  // facts stay live, so a state change mid-session can move this line under a
  // heading chosen a moment earlier. That is the anti-jump policy working, and
  // it resolves the next time the palette opens.
  const assistant = classifyAssistantActivity(project);
  const age =
    project.oldestWaitingSince !== undefined
      ? formatWaitAge(project.oldestWaitingSince, nowMs)
      : null;

  if (project.waitingAgentCount > 0) {
    // `blockedAgentCount` is a subset of `waitingAgentCount`, so the remainder
    // is still waiting on the user and has to be reported too — collapsing a
    // "3 waiting, 1 blocked" project to "Agent blocked" would hide two agents
    // that are asking for something.
    const blocked = Math.min(project.blockedAgentCount, project.waitingAgentCount);
    const needingInput = project.waitingAgentCount - blocked;

    const parts: string[] = [];
    if (needingInput > 0) {
      // Every state phrase on this line leads with its number, so the reader
      // can compare it against the running count in front of it without
      // re-parsing a sentence. "1 needs input" rather than "Agent needs input"
      // for exactly that reason: a row where one figure is a numeral and the
      // other is a noun is a row you have to read rather than scan.
      parts.push(needingInput === 1 ? "1 needs input" : `${needingInput} need input`);
      if (blocked > 0) parts.push(`${blocked} blocked`);
    } else {
      parts.push(`${blocked} blocked`);
    }

    // `oldestWaitingSince` is the earliest transition across ALL waits, blocked
    // or not, so it can only ever be labelled as the oldest. Attaching it to a
    // blocked count alone would date a fresh block by an older prompt's clock.
    const ageDetail =
      age === null
        ? undefined
        : project.waitingAgentCount > 1
          ? `oldest ${age}`
          : age === "just now"
            ? age
            : `waiting ${age}`;

    return {
      text: parts.join(" · "),
      tone: blocked > 0 ? "blocked" : "waiting",
      // Blocked agents are inside `waitingAgentCount`, so this is every agent
      // the sentence just accounted for and never a double count.
      demandCount: project.waitingAgentCount,
      ...(ageDetail !== undefined ? { ageDetail } : {}),
    };
  }

  // Counts arrive from a single producer that keeps blocked a subset of
  // waiting, but a malformed payload must not silently render as idle.
  if (project.blockedAgentCount > 0) {
    return {
      text: `${project.blockedAgentCount} blocked`,
      tone: "blocked",
      demandCount: project.blockedAgentCount,
    };
  }

  // The two assistant states that put a row in the attention band, reported
  // here so the band and the line agree about why it is there. Below the
  // worker waits above — those are people stalled on a run they started, which
  // outranks the assistant asking — and above review, because both of these
  // are stuck and a finished agent is not.
  if (assistant === "blocked" || assistant === "waiting-unseen") {
    return assistantStatus(assistant, project.assistantStateSince, nowMs);
  }

  // Finished work the user hasn't seen — the hand-back the attention band
  // exists for. States the action ("ready for review") and, in the age beside
  // it, how fresh the hand-back is, so a 3-minute-old completion and a
  // 2-hour-old one stop rendering identically.
  if (project.unacknowledgedCompletedAgentCount > 0) {
    const count = project.unacknowledgedCompletedAgentCount;
    const latest = project.latestUnacknowledgedCompletionAt;
    const oldest = project.oldestUnacknowledgedCompletionAt;
    const line: ActivityLine = {
      text: `${count} ready for review`,
      tone: "review",
      demandCount: count,
    };

    if (count === 1) {
      const at = latest ?? oldest;
      if (at === undefined) return line;
      const finishedAge = formatWaitAge(at, nowMs);
      return {
        ...line,
        ageDetail:
          nowMs - at < JUST_FINISHED_MS
            ? finishedAge === "just now"
              ? "just finished"
              : `just finished ${agoPhrase(finishedAge)}`
            : `finished ${agoPhrase(finishedAge)}`,
      };
    }

    if (latest === undefined || oldest === undefined) return line;
    // Newest-to-oldest range; collapses when both round to the same value.
    // The producer keeps latest >= oldest, but this formatter is defensive
    // everywhere else — a swapped pair must not render as "2h–3m ago".
    const newestAge = formatRangeAge(Math.max(latest, oldest), nowMs);
    const oldestAge = formatRangeAge(Math.min(latest, oldest), nowMs);
    return {
      ...line,
      ageDetail: newestAge === oldestAge ? `${oldestAge} ago` : `${newestAge}–${oldestAge} ago`,
    };
  }

  // Running is deliberately NOT a tier here. It is the second axis (#11832), and
  // a tier is the one thing it cannot be: a tier only speaks when every louder
  // fact is absent, which is exactly when "3 running" is least worth knowing.
  // The count reaches the row through `withLiveness` instead, so it survives a
  // wait, a snooze and a completion winning this cascade.

  // A working assistant, but only on a row with no run of its own. It sits here
  // — above snooze — because on such a row it is the entire reason the project
  // is in the Running band, and "Agent snoozed" announced from that band would
  // be a puzzle. On a row that IS running, the count already explains the band,
  // so the assistant must not take the line: it would evict the snooze or the
  // completion underneath it to report something the user did not start. It
  // gets its turn further down instead.
  if (assistant === "working" && project.activeAgentCount === 0) {
    return assistantStatus(assistant, project.assistantStateSince, nowMs);
  }

  // Reached whether or not something is running — the count says that now, so
  // this line is free to report the snooze underneath it. Above the
  // completed/dormant lines because a snoozed agent is live and coming back,
  // which "Agent finished" would deny.
  //
  // The wake time is stated once, statically. A counting-down "in 12m" would
  // pull the eye back to the row every minute, which is the precise thing the
  // user snoozed it to stop.
  if (project.snoozedAgentCount > 0) {
    const lead = `${project.snoozedAgentCount} snoozed`;
    const wakeAt = project.nextSnoozeWakeAt;
    // Absent when every snooze is the unlimited option — there is no wake time
    // to name, and inventing one would promise a return that no clock will
    // deliver.
    if (wakeAt === undefined) return { text: lead, tone: "snoozed" };
    return { text: lead, tone: "snoozed", ageDetail: `until ${formatWakeTime(wakeAt)}` };
  }

  // An assistant parked at its prompt, already seen. Its resting state, so it
  // sits below everything that is actually asking for something — but above
  // the settled lines, because a live session is a better answer to "what is
  // this project doing" than a completion that was reviewed hours ago.
  if (assistant === "waiting") {
    return assistantStatus(assistant, project.assistantStateSince, nowMs);
  }

  // Everything completed has been seen: drop the action phrase and mute. The
  // fact is still worth a line — it explains why the shell is open.
  if (project.completedAgentCount > 0) {
    const text = `${project.completedAgentCount} finished`;
    if (project.latestCompletionAt === undefined) return { text, tone: "muted" };
    const age = agoPhrase(formatWaitAge(project.latestCompletionAt, nowMs));
    return {
      text,
      tone: "muted",
      ageDetail: project.completedAgentCount === 1 ? age : `latest ${age}`,
    };
  }

  // The working assistant's second chance, on a running row whose own agents had
  // nothing settled to report. Below the worker lines rather than above them,
  // for the reason it was skipped up top: the user's runs outrank the machine's
  // own, and this line only exists to keep a row from reading as empty.
  if (assistant === "working") {
    return assistantStatus(assistant, project.assistantStateSince, nowMs);
  }

  // Bare processes, and only when no agent is running: `processCount` includes
  // the PTYs those agents are sitting in, so a project with two working agents
  // would otherwise say "3 processes running" beside a count of 2 and leave the
  // reader to work out which number was about their work.
  if (project.processCount > 0 && project.activeAgentCount === 0) {
    return {
      // "running" explicitly: a bare "1 process" leaves the reader guessing
      // whether it is executing, idle or residue, and this row exists to say
      // that something is still alive in a project with no agents left in it.
      text: pluralAgents(project.processCount, "1 process running", "processes running"),
      tone: "running",
    };
  }

  return null;
}

/**
 * Dormant fallback shared by both kinds, flagged so callers can decline it.
 *
 * "Opened", explicitly: the browse band is frecency-ordered, so a bare "13h ago"
 * read as a sort key it isn't. The verb turns it back into what it is — one
 * useful fact about the row. Still the weakest thing a row can say, though, and
 * on twenty rows at once it is twenty timestamps nobody reads; the switcher
 * takes the flag and shows nothing (#11692). The text stays here because a
 * surface with room for it should still say it the same way.
 */
function getOpenedStatus(lastOpened: number): ActivityLine {
  if (lastOpened > 0) {
    return {
      text: `Opened ${formatTimeAgo(lastOpened)}`,
      tone: "muted",
      isDormantFallback: true,
      allowsResumeMark: true,
    };
  }
  return {
    text: "Not opened yet",
    tone: "muted",
    isDormantFallback: true,
    allowsResumeMark: true,
  };
}

/**
 * The one status line a project row has to show, if it shows one at all.
 *
 * The clock is required rather than defaulted. Every caller renders inside a
 * row React Compiler auto-memoizes, where a `Date.now()` fallback taken in here
 * is invisible to the cache key the call is stored under — the row keeps the
 * reading from its first render and the age never advances (#11823).
 */
export function getProjectRowStatus(project: SearchableProject, nowMs: number): ProjectRowStatus {
  // Only surface the fragment when it actually disambiguates — a plain basename
  // is already the folder name shown beside it, so repeating it is noise.
  const pathHint = project.displayPath.includes("/") ? project.displayPath : undefined;
  // Every branch leaves through here, so none of them can return a line that
  // never answered the liveness question.
  const finish = (line: ActivityLine): ProjectRowStatus => {
    const status = withLiveness(line, project);
    return pathHint ? { ...status, pathHint } : status;
  };

  // A folder that has gone missing still gets the clause: its agents were
  // spawned before it vanished and may well still be running, and this is the
  // one branch that pre-empts the activity cascade outright.
  if (project.isMissing) {
    return finish({ text: "Directory not found", tone: "blocked" });
  }

  const activity = classifyWorkspaceActivity(project, nowMs);
  if (activity) return finish(activity);

  // Auto-closed by the background-idle sweep (#10830) — name the reason rather
  // than showing a bare time-ago that makes the project look merely stale. The
  // reason is the row's own line; the ring beside it is only settled state, so
  // it steps aside for a resume promise that has more to say (#11822).
  //
  // Withheld while agents are still running. The sweep marks a project closed
  // at once and its counts arrive on a 200ms debounce, so this line can reach a
  // row that is demonstrably still working — and "Suspended to free memory"
  // beside "2 agents running" is a flat contradiction, not a stale timestamp.
  // The row falls through to the dormant fallback for that beat, which prints
  // no sentence at all and lets the count speak alone.
  if (project.status === "closed" && project.autoParkedAt && project.activeAgentCount === 0) {
    return finish({ text: "Suspended to free memory", tone: "muted", allowsResumeMark: true });
  }

  return finish(getOpenedStatus(project.lastOpened));
}

/**
 * The one status line a scratch row has to show, if it shows one at all
 * (#11518).
 *
 * Same activity sentences and tones a project gets — the point of the shared
 * core — minus the states a scratch has no concept of. There is no `isMissing`
 * (the folder is app-managed), no auto-parking (scratches are never swept into
 * a closed status), and no `pathHint`: scratch paths are UUIDs under the app's
 * own directory, so a fragment of one disambiguates nothing.
 *
 * Requires its clock for the same reason `getProjectRowStatus` does.
 */
export function getScratchRowStatus(scratch: SearchableScratch, nowMs: number): ProjectRowStatus {
  return withLiveness(
    classifyWorkspaceActivity(scratch, nowMs) ?? getOpenedStatus(scratch.lastOpened),
    scratch
  );
}

/**
 * The palette header's one-line answer to "is it safe to look away?" (#11832).
 *
 * Null when nothing is executing anywhere, which is the whole point — the line
 * appears while the fleet is busy and disappears when it goes quiet, so its
 * absence is as readable as its content.
 *
 * Assistants are tallied separately rather than added in. They are not runs the
 * user launched, and one number covering both would answer neither "how much of
 * my work is still going" nor "is the machine doing something on its own".
 */
export function formatFleetLiveness(counts: {
  runningAgentCount: number;
  workingAssistantCount: number;
}): string | null {
  const parts: string[] = [];
  if (counts.runningAgentCount > 0) {
    parts.push(pluralAgents(counts.runningAgentCount, "1 running", "running"));
  }
  if (counts.workingAssistantCount > 0) {
    parts.push(
      pluralAgents(counts.workingAssistantCount, "1 assistant working", "assistants working")
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
