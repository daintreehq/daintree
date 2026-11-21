import type { DecisionDeliveryStatus, DecisionsRequirement } from "./decisions.js";

/** One question of a pane, asked by id (#17097). */
export interface GetDecisionQuestionPayload {
  terminalId: string;
  questionId: string;
}

/**
 * Part of one image of a pane's question, asked by its attachment id and
 * where the part starts (#17100). An image comes in parts small enough to
 * cross a Remote Host's link, which carries at most 16 MiB in one message.
 */
export interface GetDecisionQuestionImagePayload {
  terminalId: string;
  questionId: string;
  attachmentId: string;
  offset: number;
}

/** The questions of a pane whose opening lines a list needs (#17097). */
export interface GetDecisionQuestionSummariesPayload {
  terminalId: string;
  questionIds: string[];
}

/** A person withdrawing one of a pane's questions from that pane's view (#17099). */
export interface CancelDecisionQuestionPayload {
  terminalId: string;
  questionId: string;
}

/**
 * A person's cancel. `cancelled`: the store records it cancelled, either
 * dropped here because it was never sent or already withdrawn.
 * `cancelling`: the withdrawal is committed and goes to the relay, and the
 * question is cancelled once the relay confirms it. `refused`: it isn't
 * waiting any more (answered, expired, or never published), or the store
 * holds no such question for this pane. `off` and `not-running` as for a read.
 */
export type DecisionQuestionCancelResult =
  | { result: "cancelled" }
  | { result: "cancelling" }
  | { result: "refused"; reason: DecisionQuestionCancelRefusal }
  | { result: "off" }
  | { result: "not-running" }
  | DecisionQuestionHostNotConnected;

/**
 * The question is a Remote Host's (#17230) and this computer had no link to
 * that Host, so nothing was read or done there. For a cancel, also a link
 * that went or timed out before the Host answered: it may or may not have
 * been withdrawn.
 */
export interface DecisionQuestionHostNotConnected {
  result: "host-not-connected";
}

/**
 * A Remote Host's question this computer can't read now, with what it last
 * read of it over that Host's link (#17946), for the owner to dismiss it by.
 * Absent where the Host's last report doesn't list it as waiting for the person.
 */
export interface DecisionQuestionHostAway extends DecisionQuestionHostNotConnected {
  lastRead?: DecisionQuestionLastRead;
}

/**
 * What this computer last read of a waiting Host question, kept for the
 * owner identity, Host and Host device it was read under, while it runs:
 * - `read`: open on the relay at `revision`, read at `readAt` (epoch ms): a
 *   dismissal can be signed against that revision, and the relay refuses it
 *   if the question moved on since;
 * - `not-sent`: it hadn't reached the relay when last read, so the relay
 *   can't take a dismissal of it until the Host sends it;
 * - `not-read`: nothing read of it here can say which revision it is open at.
 */
export type DecisionQuestionLastRead =
  | { result: "read"; revision: number; alias: number; readAt: number }
  | { result: "not-sent" }
  | { result: "not-read" };

export type DecisionQuestionCancelRefusal = "answered" | "expired" | "publish-failed" | "not-found";

/** The question's state in the local store: the library's `LocalStatus`. */
export type DecisionQuestionStatus =
  | "queued"
  | "open"
  | "proxy-answered"
  | "human-answered"
  | "cancelled"
  | "expired"
  | "publish-failed";

/** An image the question was published with, as its content describes it. The bytes aren't read here. */
export interface DecisionQuestionAttachment {
  attachmentId: string;
  role: "before" | "after" | "reference" | "other";
  alt: string | null;
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** Bytes of the image itself. */
  size: number;
  /** SHA-256 (hex) of the image itself: what it is checked against, and what an approval names it by. */
  sha256: string;
}

/** An image a person attached to an answer or a follow-up from their phone. */
export interface DecisionThreadImage {
  attachmentId: string;
  alt: string | null;
  mime: "image/png" | "image/jpeg" | "image/webp";
  size: number;
}

/**
 * One answer stored for the question, opened. `person` is a human on a
 * paired device, `model` the proxy model. `unreadable` when its content
 * couldn't be opened here: the choices, text and images are then empty.
 */
export interface DecisionThreadAnswer {
  type: "answer";
  entryId: string;
  revision: number;
  from: "person" | "model";
  /**
   * A person's answer given on their computer (#17101), signed by the owner
   * desktop; false for a phone's or tablet's, and for the model's.
   */
  onComputer: boolean;
  /** Replaces an earlier answer. */
  correction: boolean;
  /** A person confirming the model's answer. */
  confirmsModel: boolean;
  /** Chosen options by id, with the label they had when chosen. */
  choices: { id: string; label: string | null }[];
  text: string | null;
  /** Why a person corrected an earlier answer. */
  reason: string | null;
  images: DecisionThreadImage[];
  sentAt: string;
  unreadable: boolean;
  /**
   * Whether typing this answer into the asking terminal was confirmed
   * (#17943), apart from a later correction's delivery, which the question's
   * own `deliveryStatus` follows. Absent from a Remote Host from before it.
   */
  delivered?: boolean;
}

/** The question expired unanswered. */
export interface DecisionThreadExpiry {
  type: "expired";
  entryId: string;
  sentAt: string;
}

/**
 * The person declined to answer, from their phone or tablet (#17234). It
 * carries no answer and authorises nothing.
 */
export interface DecisionThreadDecline {
  type: "declined";
  entryId: string;
  sentAt: string;
}

/**
 * A follow-up message on the question's thread, from the person or the
 * agent. A follow-up never answers the question. `deliveryStatus` is how far
 * a person's message has got into the pane; null for the agent's own.
 */
export interface DecisionThreadMessage {
  type: "message";
  messageId: string;
  from: "person" | "agent";
  text: string | null;
  images: DecisionThreadImage[];
  expectsReply: boolean;
  /**
   * A person's message written on their computer (#17238), signed by the
   * owner desktop; false for a phone's or tablet's, and for the agent's own.
   * Absent from a Remote Host from before it, which reads as a phone's.
   */
  onComputer?: boolean;
  sentAt: string;
  deliveryStatus:
    "received" | "terminal-delivered" | "needs-attention" | "delivery-uncertain" | null;
  /**
   * A person's message that will never be typed in: its question was
   * withdrawn, or the person handled it, so it stays in the thread only.
   * Absent from a Remote Host from before #17238.
   */
  deliveryStopped?: boolean;
  unreadable: boolean;
}

export type DecisionThreadEntry =
  DecisionThreadAnswer | DecisionThreadExpiry | DecisionThreadDecline | DecisionThreadMessage;

/**
 * Why a closed question has no answer: `declined` by the person from their
 * phone or tablet, `withdrawn` (cancelled from the desktop), `expired`, or
 * `never-published`: its deadline passed before it ever reached the relay, so
 * no phone showed it and no answer to it was recorded (#17943).
 */
export type DecisionQuestionClosedReason = "declined" | "withdrawn" | "expired" | "never-published";

/**
 * The current round's reply mode (Decisions protocol section 21), as the
 * library's `get_decision` reads it: `advisory` while the question is in the
 * round its agent asked for advice in, so an unanswered deadline lets the plan
 * it stated go ahead; `blocking` otherwise, a reopened question included: it
 * waits for a reply, and its expiry authorises nothing.
 */
export type DecisionReplyMode = "advisory" | "blocking";

/**
 * The notice that closed a question without an answer (its expiry, the
 * person's decline, or that it was never published), on its way into the
 * asking terminal (#17943). `delivery`: `pending` until it is typed in,
 * `delivered` once typing it in was confirmed (never that the agent acted on
 * it), `uncertain` when it may or may not have been typed, `needs-attention`
 * when typing it stopped and a person has to decide, `stopped` when it will
 * never be typed. `disposition`, for an advisory round's notice only: whether
 * it lets the agent go ahead with its stated plan; null otherwise.
 */
export interface DecisionClosureNotice {
  delivery: "pending" | "delivered" | "uncertain" | "needs-attention" | "stopped";
  disposition: "fallback-due" | "fallback-withheld" | null;
}

/**
 * The asking agent's own account of how it prepared a question (#18042), as
 * its content states it: how many other agents it says it consulted, whether
 * they `agreed`, `split` (no agreement, or inconclusive), or the consultation
 * was `not-run`, and its summary, null when it gave none. Nothing checks it:
 * it never answers, approves or changes anything.
 */
export interface DecisionPreparation {
  agentsConsulted: number;
  outcome: "agreed" | "split" | "not-run";
  summary: string | null;
}

/** A question with its content opened, in memory, for the desktop to show. Never stored. */
export interface DecisionQuestionContent {
  questionId: string;
  alias: number;
  terminalId: string;
  /**
   * The question named by the machine, project and terminal that asked it,
   * as that machine's store records it: what an answer from this computer
   * names it by (#17101), whichever machine the content was read from.
   */
  reference: DecisionQuestionReference;
  /** The question's revision as it was read: an answer is signed against it, never a later one. */
  revision: number;
  question: string;
  /** The notes the agent gave with the question. */
  context: string | null;
  kind: "choice" | "approval" | "text" | "mixed";
  options: { id: string; label: string; description: string | null }[];
  /** A person may answer in their own words. */
  allowText: boolean;
  requirement: DecisionsRequirement;
  askedAt: string;
  /**
   * The current round's deadline, ISO 8601 as recorded: the effective one,
   * after policy and any reopen. Null when the question never expires.
   */
  expiresAt: string | null;
  status: DecisionQuestionStatus;
  /**
   * Why a `cancelled`, `expired` or never-published question has no answer;
   * null otherwise. A Remote Host from before #17943 never says never-published.
   */
  closedReason: DecisionQuestionClosedReason | null;
  /** The current round's mode (#17943); absent from a Remote Host from before it. */
  replyMode?: DecisionReplyMode;
  /**
   * The plan the agent stated for an advisory round, from its content as
   * verified against the round (#17943): null for a blocking round, and absent
   * from a Remote Host from before it. Never an action taken.
   */
  plannedFallback?: string | null;
  /**
   * How the agent says it prepared the question (#18042); null when its
   * content states none, and absent from a Remote Host from before it.
   */
  preparation?: DecisionPreparation | null;
  /**
   * The notice that closed it without an answer, on its way into the asking
   * terminal (#17943); null when there is none (open, answered, withdrawn), and
   * absent from a Remote Host from before it.
   */
  closureNotice?: DecisionClosureNotice | null;
  deliveryStatus: DecisionDeliveryStatus;
  attachments: DecisionQuestionAttachment[];
  /** Answers, expiry, a decline and follow-ups, in the order the relay recorded them. */
  thread: DecisionThreadEntry[];
}

/**
 * Reading a question. `off`: Decisions is off here, so nothing loaded.
 * `not-running`: no relay connection runs to open content with.
 * `not-found`: the store holds no such question for this pane.
 * `unreadable`: the store holds it, but its content can't be opened here.
 */
export type DecisionQuestionContentResult =
  | { result: "read"; question: DecisionQuestionContent }
  | { result: "off" }
  | { result: "not-running" }
  | { result: "not-found" }
  | { result: "unreadable" }
  | DecisionQuestionHostAway;

/**
 * The asking pane as the machine that owns it observed it (#18037): its agent
 * state, the title its header shows and its screen's newest lines, redacted
 * and bounded as a phone's terminal snapshot is. `observedAt` is when that
 * machine read it, as an ISO time.
 */
export interface DecisionQuestionPane {
  agentState: string;
  waitingReason: string | null;
  paneTitle: string;
  lines: string[];
  observedAt: string;
}

/**
 * Reading a question's asking pane (#18037), never shared off the machine
 * that owns it but to this computer. `closed`: the pane no longer holds the
 * run that asked. `moved`: the answer was moved to another terminal, by a
 * person or a resume, so the run that asked isn't known any more. `unreadable`: nothing could say
 * what the pane holds now. `needs-update`: the Remote Host that asked is too
 * old to read it. The rest as a content read's.
 */
export type DecisionQuestionPaneResult =
  | { result: "read"; reference: DecisionQuestionReference; pane: DecisionQuestionPane }
  | { result: "closed" }
  | { result: "moved" }
  | { result: "unreadable" }
  | { result: "not-found" }
  | { result: "off" }
  | { result: "not-running" }
  | { result: "needs-update" }
  | DecisionQuestionHostNotConnected;

/**
 * One question's opening line, or why there is none: `host-not-connected`
 * for a Remote Host's question while this computer has no link to the Host.
 */
export type DecisionQuestionSummary =
  | { questionId: string; result: "read"; line: string | null }
  | { questionId: string; result: "not-found" }
  | { questionId: string; result: "unreadable" }
  | { questionId: string; result: "host-not-connected" };

/** The opening lines of a pane's questions, in the order they were asked for, each id once. */
export type DecisionQuestionSummariesResult =
  | { result: "read"; summaries: DecisionQuestionSummary[] }
  | { result: "off" }
  | { result: "not-running" };

/**
 * Why one of a question's images can't be shown, as checked in order:
 * `key-unavailable`, the key it was sealed under isn't held here;
 * `fetch-failed`, the relay didn't serve it (gone, past retention, unreachable);
 * `size-mismatch`, it isn't the size the question declares;
 * `decrypt-failed`, it doesn't open under the question's binding;
 * `digest-mismatch`, what opened doesn't hash to the question's digest;
 * `type-mismatch`, it isn't the PNG, JPEG or WebP image the question declares;
 * `timed-out`, fetching and checking it took too long.
 */
export type DecisionQuestionImageUnavailable =
  | "key-unavailable"
  | "fetch-failed"
  | "size-mismatch"
  | "decrypt-failed"
  | "digest-mismatch"
  | "type-mismatch"
  | "timed-out";

/** One of a question's images, opened and checked against its digest, in memory. Never stored. */
export interface DecisionQuestionImage {
  attachmentId: string;
  mime: DecisionQuestionAttachment["mime"];
  /** The digest the image was checked against. */
  sha256: string;
  /** Backed by a plain ArrayBuffer, as structured clone and the Remote Host link both deliver bytes. */
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Part of one of a question's images: the whole image was opened and checked
 * against its digest for this read, and `bytes` are the part of it that
 * starts at `offset`, empty past its end.
 */
export interface DecisionQuestionImagePart extends DecisionQuestionImage {
  /** Bytes of the whole image. */
  size: number;
  offset: number;
}

/**
 * Reading one of a question's images. `not-found`: the store holds no such
 * question for this pane, or the question names no such image.
 * `unreadable`: the question's content can't be opened here.
 */
type DecisionQuestionImageRead<Read> =
  | Read
  | { result: "unavailable"; reason: DecisionQuestionImageUnavailable }
  | { result: "off" }
  | { result: "not-running" }
  | { result: "not-found" }
  | { result: "unreadable" }
  | DecisionQuestionHostNotConnected;

/** One part of an image, as one read over IPC answers. */
export type DecisionQuestionImagePartResult = DecisionQuestionImageRead<{
  result: "read";
  part: DecisionQuestionImagePart;
}>;

/** A whole image, as the renderer's client assembles it from its parts. */
export type DecisionQuestionImageResult = DecisionQuestionImageRead<{
  result: "read";
  image: DecisionQuestionImage;
}>;

/**
 * One question this computer's Decisions holds, named wherever it is read
 * from (#17229): the machine that asked it, and the project, terminal and
 * question there. Any Daintree window on this computer may read it by this
 * reference, whatever project it shows and whether the terminal is still open.
 */
export interface DecisionQuestionReference {
  hostId: string;
  projectId: string;
  terminalId: string;
  questionId: string;
}

/**
 * Where a question stands, in exactly one place:
 * - `waiting`: for the person, because it is `open`, or because it was
 *   answered and the agent's latest follow-up expects a `reply`;
 * - `queued`: not yet sent to the relay; `send-failed`: it never could be;
 * - `to-type`: answered, or followed up by the person, and waiting to be typed
 *   in, with what waits when its machine says (`delivery`, #18032);
 * - `needs-attention`: an answer or a person's follow-up that delivery stopped
 *   on, as the list of answers needing attention shows it;
 * - `settled`: answered and typed in or marked handled, withdrawn, expired,
 *   or declined by the person from their phone or tablet.
 */
export type DecisionQuestionStanding =
  | { kind: "waiting"; reason: "open" | "reply" }
  | { kind: "queued" }
  | { kind: "send-failed" }
  | { kind: "to-type"; delivery?: DecisionPendingDelivery }
  | { kind: "needs-attention"; deliveryStatus: "needs-attention" | "delivery-uncertain" }
  | { kind: "settled"; outcome: "answered"; handled: boolean }
  | { kind: "settled"; outcome: "withdrawn" | "expired" | "declined" };

/**
 * What waits to be typed into the asking terminal while a question is
 * `to-type` (#18032), as its store records it: an answer (or its correction),
 * how many of the person's follow-ups, which of those was recorded first and
 * when, and whether the answer waits for the terminal's host to be back
 * (`pending-host`). Counts and times only. Absent from a Remote Host's
 * question, whose link doesn't carry it.
 */
export interface DecisionPendingDelivery {
  answer: boolean;
  followUps: number;
  /** The one waiting longest, and when it was recorded, ISO 8601 as stored. */
  first: "answer" | "follow-up";
  recordedAt: string;
  hostAway: boolean;
}

/**
 * A question as the list names it: who asked, where, when, and where it
 * stands. Never its words: they are read on demand by reference.
 */
export interface DecisionQuestionListItem {
  reference: DecisionQuestionReference;
  alias: number;
  /** The agent that asked (`claude`, `codex`, …). */
  agentKind: string;
  /** The project's name as it was when asked; null when the question carries none. */
  projectLabel: string | null;
  worktreeId: string;
  /** Where the worktree was on this computer when asked. */
  worktreeRoot: string;
  requirement: DecisionsRequirement;
  askedAt: string;
  /**
   * The current round's deadline, ISO 8601 as recorded: the effective one,
   * after policy and any reopen. Null when the question never expires.
   */
  expiresAt: string | null;
  /** The current round's mode (#17943); absent from a Remote Host from before it. */
  replyMode?: DecisionReplyMode;
  /**
   * Why it closed without an answer (#17943), also while delivery needs a
   * person; null while it isn't closed that way, and absent from a Remote
   * Host from before it.
   */
  closedReason?: DecisionQuestionClosedReason | null;
  /** As `DecisionQuestionContent.closureNotice` (#17943). */
  closureNotice?: DecisionClosureNotice | null;
  /**
   * When it was settled: the answer that settled it, or its expiry. Null
   * while it isn't settled, and for a withdrawal, which records no time.
   */
  settledAt: string | null;
  standing: DecisionQuestionStanding;
  /**
   * The agent's follow-up asking the person for a reply they haven't given
   * yet, by message id (#17235): what brings an answered question back to
   * Needs you on the phone. Null otherwise.
   */
  replyRequest: string | null;
  /** What delivery stopped on while it needs a person (#17235); null otherwise. */
  stall: DecisionQuestionStall | null;
  /**
   * A withdrawal (`withdrawing`) or the person's decline (`declining`) this
   * computer has queued for the relay and the question hasn't closed for yet
   * (#18052), whichever window started it. Only this computer's list carries
   * it, never a Host's own: a decline of a Host's question is signed here.
   */
  closing?: "withdrawing" | "declining";
  /**
   * The enrolled Remote Host that asked (#17230), by the id and name this
   * computer's host list gives it, and whether this computer has a link to it
   * now; absent for this computer's own questions. A Host that isn't
   * connected keeps the questions it last reported, as it last reported them.
   */
  remoteHost?: DecisionQuestionRemoteHost;
  /**
   * What this computer last observed of the run that asked (#18029), for its
   * own open or queued questions only, once observed: never a Remote Host's,
   * whose panes this computer can't see.
   */
  asker?: DecisionAskerPresence;
  /**
   * What a waiting or queued question asks of the person now, and what they
   * did with that on this computer (#17895). Only this computer's list
   * carries it, never a Host's own, and only while the question is in Needs you.
   */
  inbox?: DecisionQuestionInbox;
}

/**
 * The run that asked an open question, as this computer last observed it
 * (#18029). Observations only: nothing here closes, declines or withdraws the
 * question, and none of it says what the agent is doing.
 * - `target`, the terminal that asked: `running`, the same run with its agent
 *   detected; `agent-undetected`, the same run with its agent no longer
 *   detected; `closed`, it stopped running or closed; `trashed`, in the Trash;
 *   `moved`, the same run now filed under another worktree; `replaced`, it
 *   now runs another session; `unknown`, it couldn't be read.
 * - `directory`, the folder it asked from: `none` for a terminal in no worktree.
 * - `resume`, whether an answer could reopen its session in a new terminal,
 *   by the checks delivery makes before it tries: `resumable` when they all
 *   pass (the launch itself can still fail), else the first that doesn't.
 */
export interface DecisionAskerPresence {
  target: "running" | "agent-undetected" | "closed" | "trashed" | "moved" | "replaced" | "unknown";
  directory: "present" | "missing" | "none" | "unknown";
  resume: DecisionAskerResume;
}

/**
 * `unsupported-agent`, its agent's resume isn't proven; `no-session`, no
 * session id was recorded when it asked; `no-worktree`, it asked from no
 * worktree; `worktree-missing`, its folder is gone; `ended`, a resume already
 * reopened it once this run and that terminal went too; `other-worktree`,
 * the session itself runs in another worktree now, which a resume won't take
 * over; `unknown`, a check couldn't be made.
 */
export type DecisionAskerResume =
  | "resumable"
  | "unsupported-agent"
  | "no-session"
  | "no-worktree"
  | "worktree-missing"
  | "ended"
  | "other-worktree"
  | "unknown";

/**
 * The person's own reading of what a question asks of them, kept on this
 * computer only (#17895). Neither mark answers or declines anything: the
 * question waits for the agent just the same, and stays answerable.
 */
export interface DecisionQuestionInbox {
  /**
   * The agent's latest follow-up the ask takes in, by message id; null for
   * the question alone. A new one is a new ask, which no earlier mark covers.
   * A Host's question takes in only a follow-up asking for a reply.
   */
  ask: string | null;
  /** Shown to the person here: it no longer counts as waiting on them. */
  seen: boolean;
  /** Set aside by the person here: it leaves Needs you and the counts. */
  cleared: boolean;
}

/** The most questions one mark names; more are marked a page at a time. */
export const DECISION_QUESTION_MARKS_PER_CALL = 500;

/**
 * What the person does with a question's current ask on this computer:
 * `seen`, it was shown to them; `clear`, they set it aside; `restore`, they
 * took it back into Needs you. Each question is named with the ask it was
 * shown with, so one that has asked something new since is left alone.
 */
export interface MarkDecisionQuestionsPayload {
  action: "seen" | "clear" | "restore";
  questions: { reference: DecisionQuestionReference; ask: string | null }[];
}

/**
 * Marks recorded. `marked`: how many questions it changed; a question no
 * longer in Needs you, or asking something new, isn't. `failed`: the store
 * couldn't save it, so nothing changed. `off` and `not-running` as for a read.
 */
export type DecisionQuestionMarkResult =
  | { result: "marked"; marked: number }
  | { result: "failed" }
  | { result: "off" }
  | { result: "not-running" };

/**
 * An answer, or follow-ups after it, that delivery stopped on and a person
 * hasn't dealt with, as the list of answers needing attention shows it. Ids
 * and the library's code only.
 */
export interface DecisionQuestionStall {
  /** The answer's revision while it needs a person; null while only follow-ups do. */
  answerRevision: number | null;
  /** The person's follow-ups delivery stopped on, by message id, in thread order. */
  followUpIds: string[];
  /**
   * The library's code for why (`pane_gone`, `resume_timeout`, …), the
   * answer's while it needs a person, else the first follow-up's;
   * `unspecified` when none was recorded.
   */
  reason: string;
}

export interface DecisionQuestionRemoteHost {
  hostId: string;
  name: string;
  connected: boolean;
}

/**
 * Every question this computer's Decisions holds, and those its enrolled
 * Remote Hosts last reported (#17230), oldest first. Empty while Decisions is
 * off or its store is closed. `revision` only rises, so a read
 * and a push can be ordered.
 */
export interface DecisionQuestionList {
  revision: number;
  questions: DecisionQuestionListItem[];
  /**
   * Each enrolled Remote Host this computer heard from but can't reach now,
   * by name, whether or not it reported a question (#18022): what it last
   * reported may be out of date. Absent while none is away.
   */
  hostsAway?: string[];
}

/** Open one question in the window's question view: a click on its desktop notification (#17232). */
export interface DecisionsOpenQuestionRequest {
  reference: DecisionQuestionReference;
  /** The follow-up in its thread to open at (#17235); absent to open at the top. */
  messageId?: string;
}

/** One question read by its reference, from any window (#17229). */
export interface GetDecisionQuestionByReferencePayload {
  reference: DecisionQuestionReference;
}

/** Part of one image of a question, read by its reference. */
export interface GetDecisionQuestionImageByReferencePayload {
  reference: DecisionQuestionReference;
  attachmentId: string;
  offset: number;
}

/** The questions whose opening lines a list needs, by reference. */
export interface GetDecisionQuestionSummariesByReferencePayload {
  references: DecisionQuestionReference[];
}

/** A person withdrawing a question by its reference, from any window. */
export interface CancelDecisionQuestionByReferencePayload {
  reference: DecisionQuestionReference;
}

/**
 * The person's answer to a question, given in Daintree's own view on the
 * owner computer, which signs it (#17101). The question is named by the
 * reference its content was read with, and answered at the revision the
 * person read. `answerId` is minted by the view for this answer, and sent
 * again with the same answer when a submission's result is lost, so a retry
 * is the same answer and never a second one. The digests are those of the
 * images the view showed the person, as the question's content lists them.
 */
export interface AnswerDecisionQuestionPayload {
  reference: DecisionQuestionReference;
  answerId: string;
  expectedRevision: number;
  selectedOptionIds: string[];
  text?: string;
  explicitApproval?: boolean;
  reason?: string;
  reviewedAttachmentDigests: string[];
}

/**
 * Where a person's answer stands, as the Decisions library reports it:
 * - `queued`: committed here and not settled yet (the relay is out of reach,
 *   or the answer waits behind its question's unsent create); it keeps being
 *   sent, and `getAnswerResult` reads its outcome;
 * - `sent`: the relay took it, and it is typed into the asking terminal as
 *   a phone's answer would be;
 * - `already-answered`: another answer (a phone's, the model's or this
 *   computer's) was taken first;
 * - `changed`: the question is open at a revision other than the one read;
 *   read it again;
 * - `closed`: it expired, was cancelled or declined, or the relay holds no
 *   such question;
 * - `unsupported`: the relay, or the computer that asked (a Remote Host),
 *   doesn't take answers made on a computer yet and needs updating;
 * - `rejected`: any other refusal, with the relay's code.
 */
export type DecisionAnswerOutcome =
  | { status: "queued" }
  | { status: "sent" }
  | { status: "already-answered" }
  | { status: "changed" }
  | { status: "closed"; reason: "expired" | "cancelled" | "not-found" }
  | { status: "unsupported"; by: "relay" | "asking-desktop" }
  | { status: "rejected"; code: string };

/**
 * Why an answer wasn't taken here at all, before anything was signed:
 * `not-found`, the reference names no question this computer can answer;
 * `not-owner`, this computer is a Remote Host, whose key never signs a
 * person's answer; `unreadable`, the question is this computer's own but its
 * content can't be opened to check the answer against; `invalid`, the
 * answer breaks the question's rules or reuses an answer id for another
 * answer, as `detail` says.
 */
export type DecisionAnswerRefusal =
  | { result: "refused"; reason: "not-found" | "not-owner" | "unreadable" }
  | { result: "refused"; reason: "invalid"; detail: string };

/**
 * A person's answer, submitted. `off` and `not-running` as for a read: off
 * here, or no relay connection runs to sign with.
 */
export type DecisionQuestionAnswerResult =
  | { result: "submitted"; answerId: string; outcome: DecisionAnswerOutcome }
  | DecisionAnswerRefusal
  | { result: "off" }
  | { result: "not-running" };

/** Where a submitted answer stands, by the id it was submitted with. */
export interface GetDecisionAnswerResultPayload {
  answerId: string;
}

/**
 * The person's follow-up on a question's thread, written in Daintree's own
 * view on the owner computer, which signs it (#17238). The question is named
 * by the reference its content was read with; a follow-up goes to an open or
 * answered question alike and never answers it or changes its answer.
 * `messageId` is minted by the view for this message, and sent again with the
 * same text when a submission's result is lost, so a retry is the same
 * message and never a second one.
 */
export interface SendDecisionFollowUpPayload {
  reference: DecisionQuestionReference;
  messageId: string;
  text: string;
}

/**
 * Where a person's follow-up stands, as the Decisions library reports it:
 * - `queued`: committed here and not settled yet (the relay is out of reach,
 *   or it waits its turn behind the question's unsent create or the person's
 *   earlier answer or follow-up); it keeps being sent, and
 *   `getFollowUpResult` reads its outcome;
 * - `sent`: the relay took it, and it is typed into the asking terminal as
 *   a phone's follow-up would be, marked as sent from the computer;
 * - `closed`: the question expired, was cancelled or declined, or the relay
 *   holds no such question;
 * - `unsupported`: the relay, or the computer that asked (a Remote Host),
 *   doesn't take follow-ups sent from a computer yet and needs updating;
 * - `rejected`: any other refusal, with the relay's code (`invalid_state`
 *   for a thread at its message limit).
 */
export type DecisionFollowUpOutcome =
  | { status: "queued" }
  | { status: "sent" }
  | { status: "closed"; reason: "expired" | "cancelled" | "not-found" }
  | { status: "unsupported"; by: "relay" | "asking-desktop" }
  | { status: "rejected"; code: string };

/**
 * Why a follow-up wasn't taken here at all, before anything was signed:
 * `not-found`, the reference names no question this computer can follow up;
 * `not-owner`, this computer is a Remote Host, whose key never signs the
 * person's message; `invalid`, the text breaks the protocol's bounds or the
 * message id was used for another message, as `detail` says.
 */
export type DecisionFollowUpRefusal =
  | { result: "refused"; reason: "not-found" | "not-owner" }
  | { result: "refused"; reason: "invalid"; detail: string };

/**
 * A person's follow-up, submitted. `off` and `not-running` as for a read: off
 * here, or no relay connection runs to sign with.
 */
export type DecisionQuestionFollowUpResult =
  | { result: "submitted"; messageId: string; outcome: DecisionFollowUpOutcome }
  | DecisionFollowUpRefusal
  | { result: "off" }
  | { result: "not-running" };

/** Where a submitted follow-up stands, by the id it was submitted with. */
export interface GetDecisionFollowUpResultPayload {
  messageId: string;
}

/**
 * A submitted follow-up's standing. `not-found`: no follow-up was ever
 * committed here under that id, or a crash kept it from being queued: submit
 * it again with the same id.
 */
export type DecisionFollowUpResultRead =
  | { result: "read"; questionId: string; outcome: DecisionFollowUpOutcome }
  | { result: "not-found" }
  | { result: "off" }
  | { result: "not-running" };

/**
 * A submitted answer's standing. `not-found`: no answer was ever committed
 * here under that id, or a crash kept it from being queued: submit it again
 * with the same id.
 */
export type DecisionAnswerResultRead =
  | { result: "read"; questionId: string; expectedRevision: number; outcome: DecisionAnswerOutcome }
  | { result: "not-found" }
  | { result: "off" }
  | { result: "not-running" };

/**
 * The person declining a question in Daintree's own view on the owner
 * computer, which signs it as their decline, as a phone's Dismiss would be
 * (#17239). Named and minted as an answer is: the reference its content was
 * read with, the revision the person read, and an id that makes a retry the
 * same decline.
 */
export interface DeclineDecisionQuestionPayload {
  reference: DecisionQuestionReference;
  declineId: string;
  expectedRevision: number;
}

/**
 * Where a person's decline stands, as the Decisions library reports it:
 * `queued` (committed here and still being sent), `declined` (the relay took
 * it: the asking computer tells a listening agent, and phones show it
 * declined on this computer), and otherwise as for an answer. `unsupported`:
 * the relay, or the computer that asked, doesn't take a decline made on a
 * computer yet, and the question can only be withdrawn.
 */
export type DecisionDeclineOutcome =
  | { status: "queued" }
  | { status: "declined" }
  | { status: "already-answered" }
  | { status: "changed" }
  | { status: "closed"; reason: "expired" | "cancelled" | "not-found" }
  | { status: "unsupported"; by: "relay" | "asking-desktop" }
  | { status: "rejected"; code: string };

/**
 * Why a decline wasn't taken here at all, before anything was signed:
 * `not-found` and `not-owner` as for an answer; `invalid`, the decline id was
 * already used for another question or revision, as `detail` says.
 */
export type DecisionDeclineRefusal =
  | { result: "refused"; reason: "not-found" | "not-owner" }
  | { result: "refused"; reason: "invalid"; detail: string };

/** A person's decline, submitted. `off` and `not-running` as for an answer. */
export type DecisionQuestionDeclineResult =
  | { result: "submitted"; declineId: string; outcome: DecisionDeclineOutcome }
  | DecisionDeclineRefusal
  | { result: "off" }
  | { result: "not-running" };

/** Where a submitted decline stands, by the id it was submitted with. */
export interface GetDecisionDeclineResultPayload {
  declineId: string;
}

/** A submitted decline's standing; `not-found` as for an answer's. */
export type DecisionDeclineResultRead =
  | {
      result: "read";
      questionId: string;
      expectedRevision: number;
      outcome: DecisionDeclineOutcome;
    }
  | { result: "not-found" }
  | { result: "off" }
  | { result: "not-running" };
