import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "../../../shared/types/decisionsQuestion.js";
import type { MetaStore } from "./attentionList.js";
import { NotificationClaims } from "./notificationClaims.js";
import type { QuestionListSource, QuestionNotifications } from "./questionNotifications.js";

/**
 * The follow-ups and stalled deliveries this computer has raised a desktop
 * notification for (#17235), by id, kept apart from the questions' own
 * record: a record started after those were already pending takes them as
 * seen, rather than raising one for each at once.
 */
export const NOTIFIED_THREAD_EVENTS_META_KEY = "daintree:notified-question-events";

export interface ThreadNotifierOptions {
  store: MetaStore;
  questions: QuestionListSource;
  /** The question's opening line; null when it can't be read. */
  readOpeningLine: (reference: DecisionQuestionReference) => Promise<string | null>;
  /** Readies what showing it takes. One that fails shows nothing. */
  prepare?: (reference: DecisionQuestionReference) => Promise<void>;
  /** Whether this computer's notifications are on for the question's project. */
  notificationsOn: (projectId: string) => boolean;
  /** The agent asked for a reply with `question.replyRequest`. */
  showReply: (question: DecisionQuestionListItem, openingLine: string | null, key: string) => void;
  /** Delivery stopped on what `question.stall` holds. */
  showStall: (question: DecisionQuestionListItem, key: string) => void;
  /** Takes down the banner shown under `key`, once what it said no longer holds. */
  close: (key: string) => void;
}

type ThreadEvent =
  | { kind: "reply"; banner: string; claims: string[]; question: DecisionQuestionListItem }
  | { kind: "stall"; banner: string; claims: string[]; question: DecisionQuestionListItem };

/**
 * A question's events are keyed by the machine that asked it and its id
 * alone: sending an answer to another terminal moves the question's pane,
 * not what was asked of the person.
 */
function eventKey(kind: string, reference: DecisionQuestionReference, ...ids: string[]): string {
  return JSON.stringify([kind, reference.hostId, reference.questionId, ...ids]);
}

function replyKey(question: DecisionQuestionListItem): string | null {
  return question.replyRequest === null
    ? null
    : eventKey("reply", question.reference, question.replyRequest);
}

/** One per thing delivery stopped on: the answer at its revision, and each follow-up. */
function stallKeys(question: DecisionQuestionListItem): string[] {
  const { stall, reference } = question;
  if (stall === null) return [];
  const keys = stall.followUpIds.map((id) => eventKey("stall", reference, "follow-up", id));
  if (stall.answerRevision !== null) {
    keys.unshift(eventKey("stall", reference, "answer", String(stall.answerRevision)));
  }
  return keys;
}

/** A question's stall banner, one at a time: a later stall on it replaces it. */
function stallBanner(reference: DecisionQuestionReference): string {
  return eventKey("stall", reference);
}

/**
 * Raises one desktop notification for each follow-up an agent sends asking
 * the person for a reply, and for each answer or follow-up delivery stops on
 * (#17235), for one owner store's lifetime. Each shows only once its claim is
 * saved in the store, so at most once across restarts and reconnects; one
 * that stops holding before it would show (replied to, handled, delivered),
 * or arrives while notifications are off, stays claimed and never shows. A
 * claim goes once its event ends, so a later stall of the same answer, after
 * a person tries it again, is a new one. With no record yet, whatever was
 * already pending when this lifetime began is taken as seen.
 */
export class ThreadNotifier implements QuestionNotifications {
  private claimed: Set<string> | null = null;
  /**
   * The delivery each claim made this lifetime belongs to, while its event
   * holds: a stall that ends and comes back under the same key while the
   * first delivery still reads is the second's to show, never both.
   */
  private owners = new Map<string, ThreadEvent>();
  private readonly record: NotificationClaims;
  private shown = new Set<string>();
  private stopped = false;
  private off: (() => void) | null = null;

  constructor(private readonly o: ThreadNotifierOptions) {
    this.record = new NotificationClaims(
      o.store,
      NOTIFIED_THREAD_EVENTS_META_KEY,
      "follow-up notification"
    );
  }

  /** Reads the record, then follows the list. A record that can't be read leaves it silent. */
  async start(): Promise<void> {
    // Taken before the read: what arrives during it is new.
    const pending = this.o.questions.get();
    let record: Set<string> | null;
    try {
      record = await this.record.read();
    } catch (error) {
      // Without the record every pending event could show again: show none.
      console.warn(
        "[Decisions] Follow-up notifications are off for this lifetime: the record couldn't be read:",
        error instanceof Error ? error.name : "error"
      );
      return;
    }
    if (this.stopped) return;
    const claimed = new Set(record ?? []);
    if (record === null) {
      for (const question of pending.questions) {
        const reply = replyKey(question);
        if (reply !== null) claimed.add(reply);
        for (const key of stallKeys(question)) claimed.add(key);
      }
    }
    this.claimed = claimed;
    this.off = this.o.questions.onChange((list) => this.follow(list));
    this.follow(this.o.questions.get());
    // The baseline is saved even when nothing new follows it.
    this.record.save(claimed);
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
    this.owners.clear();
  }

  /** Resolves once every claim made so far has been written, or failed to be. */
  settled(): Promise<void> {
    return this.record.settled();
  }

  private follow(list: DecisionQuestionList): void {
    const claimed = this.claimed;
    // An emptied list is Decisions stopping, not its questions going.
    if (this.stopped || claimed === null || list.questions.length === 0) return;
    const active = new Set<string>();
    const banners = new Set<string>();
    const fresh: ThreadEvent[] = [];
    for (const question of list.questions) {
      const reply = replyKey(question);
      if (reply !== null) {
        active.add(reply);
        banners.add(reply);
        if (!claimed.has(reply)) {
          claimed.add(reply);
          const event: ThreadEvent = { kind: "reply", banner: reply, claims: [reply], question };
          this.owners.set(reply, event);
          fresh.push(event);
        }
      }
      const held = stallKeys(question);
      if (held.length === 0) continue;
      const banner = stallBanner(question.reference);
      banners.add(banner);
      const claims: string[] = [];
      for (const key of held) {
        active.add(key);
        if (claimed.has(key)) continue;
        claimed.add(key);
        claims.push(key);
      }
      if (claims.length > 0) {
        const event: ThreadEvent = { kind: "stall", banner, claims, question };
        for (const key of claims) this.owners.set(key, event);
        fresh.push(event);
      }
    }
    // A reply request never waits again once answered or superseded, and a
    // stall that ended and comes back is a new attempt that stopped.
    for (const key of claimed) {
      if (!active.has(key)) claimed.delete(key);
    }
    for (const key of this.owners.keys()) {
      if (!active.has(key)) this.owners.delete(key);
    }
    for (const banner of this.shown) {
      if (!banners.has(banner)) {
        this.shown.delete(banner);
        this.o.close(banner);
      }
    }
    this.record.save(claimed);
    for (const event of fresh) void this.deliver(event);
  }

  /** The claims of `event` no later delivery has taken over. */
  private ownedBy(event: ThreadEvent): string[] {
    return event.claims.filter((key) => this.owners.get(key) === event);
  }

  /** The event's question now, while it still holds what the event claimed. */
  private stillHolds(event: ThreadEvent): DecisionQuestionListItem | null {
    const owned = this.ownedBy(event);
    if (owned.length === 0) return null;
    const { hostId, questionId } = event.question.reference;
    const current = this.o.questions
      .get()
      .questions.find(
        (question) =>
          question.reference.hostId === hostId && question.reference.questionId === questionId
      );
    if (current === undefined) return null;
    if (event.kind === "reply") return replyKey(current) === event.banner ? current : null;
    const held = new Set(stallKeys(current));
    return owned.some((key) => held.has(key)) ? current : null;
  }

  private async deliver(event: ThreadEvent): Promise<void> {
    try {
      await this.present(event);
    } finally {
      for (const key of event.claims) {
        if (this.owners.get(key) === event) this.owners.delete(key);
      }
    }
  }

  private async present(event: ThreadEvent): Promise<void> {
    // Until a saved snapshot holds what it still owns: a later one may save what an earlier one failed to.
    let writes: Promise<void>;
    do {
      writes = this.record.settled();
      await writes;
    } while (
      this.ownedBy(event).some((key) => !this.record.isSaved(key)) &&
      writes !== this.record.settled()
    );
    if (this.stopped) return;
    // Shown unsaved, a restart would show it again; the list's next change claims it afresh.
    const unsaved = this.ownedBy(event).filter((key) => !this.record.isSaved(key));
    const claimed = this.claimed;
    if (unsaved.length > 0 && claimed !== null) {
      for (const key of unsaved) {
        claimed.delete(key);
        this.owners.delete(key);
      }
      this.record.save(claimed);
    }
    if (this.ownedBy(event).length === 0) return;
    const { reference } = event.question;
    let line: string | null;
    try {
      [line] = await Promise.all([
        event.kind === "reply" ? this.o.readOpeningLine(reference).catch(() => null) : null,
        this.o.prepare?.(reference),
      ]);
    } catch {
      // Nothing can present it.
      return;
    }
    if (this.stopped) return;
    // Replied to from the phone, handled or delivered while it was being read: nothing to say.
    const current = this.stillHolds(event);
    if (current === null) return;
    if (!this.o.notificationsOn(current.reference.projectId)) return;
    this.shown.add(event.banner);
    if (event.kind === "reply") this.o.showReply(current, line, event.banner);
    else this.o.showStall(current, event.banner);
  }
}
