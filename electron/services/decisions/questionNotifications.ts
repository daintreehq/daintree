import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "../../../shared/types/decisionsQuestion.js";
import type { MetaStore } from "./attentionList.js";
import { NotificationClaims } from "./notificationClaims.js";

/**
 * The questions this computer has raised a desktop notification for (#17232),
 * by full reference, kept in the store's own meta table so a restart, a
 * reconnect or a Remote Host coming back never raises one again. Ids only.
 */
export const NOTIFIED_QUESTIONS_META_KEY = "daintree:notified-questions";

/**
 * Most claims kept for settled questions. A settled question can be reopened,
 * so its claim outlives settling; past this the oldest settled ones go, and
 * only a question reopened that long after would show again.
 */
export const MAX_SETTLED_CLAIMS = 500;

/** A lifetime's desktop question notifications, as the service holds them. */
export interface QuestionNotifications {
  stop(): void;
}

/** The list the notifier reads, and how it hears it change. */
export interface QuestionListSource {
  get(): DecisionQuestionList;
  onChange(listener: (list: DecisionQuestionList) => void): () => void;
}

export interface QuestionNotifierOptions {
  store: MetaStore;
  questions: QuestionListSource;
  /** The question's opening line; null when it can't be read. */
  readOpeningLine: (reference: DecisionQuestionReference) => Promise<string | null>;
  /**
   * Readies what showing the question takes (whatever presents it, and its
   * project's alert settings). One that fails shows nothing.
   */
  prepare?: (reference: DecisionQuestionReference) => Promise<void>;
  /** Whether this computer's notifications are on for the question's project. */
  notificationsOn: (projectId: string) => boolean;
  show: (question: DecisionQuestionListItem, openingLine: string | null, key: string) => void;
  /** Takes down the banner shown under `key`, once its question no longer waits. */
  close: (key: string) => void;
  /** It started following the list, or stopped: `following` changed (#17240). */
  onFollowing?: () => void;
  now?: () => number;
}

/** One key per question wherever it was asked: a Host's ids are never mistaken for this computer's. */
export function questionKey(reference: DecisionQuestionReference): string {
  return JSON.stringify([
    reference.hostId,
    reference.projectId,
    reference.terminalId,
    reference.questionId,
  ]);
}

/** Just asked: committed and not yet sent, or sent and waiting for its first answer. */
function isNewlyAsked(question: DecisionQuestionListItem): boolean {
  const { standing } = question;
  return standing.kind === "queued" || (standing.kind === "waiting" && standing.reason === "open");
}

/**
 * Raises one desktop notification for each question an agent asks (#17232),
 * whatever terminal asked it and whether anyone watches it, for one owner
 * store's lifetime. A question shows only once its claim is saved in the
 * store, so it shows at most once across restarts; one that stopped waiting
 * before it would show, or asked while notifications are off, stays claimed
 * and never shows. With no record yet (the first run, or one damaged), the
 * questions already waiting when this lifetime began are taken as seen.
 */
export class QuestionNotifier implements QuestionNotifications {
  private claimed: Set<string> | null = null;
  private readonly record: NotificationClaims;
  private shown = new Set<string>();
  private stopped = false;
  private off: (() => void) | null = null;
  private readonly startedAt: number;
  /** Only for the first list, with no record: questions asked before this time are taken as seen. */
  private seenBefore: number | null = null;

  constructor(private readonly o: QuestionNotifierOptions) {
    this.startedAt = (o.now ?? Date.now)();
    this.record = new NotificationClaims(
      o.store,
      NOTIFIED_QUESTIONS_META_KEY,
      "question notification"
    );
  }

  /** Reads the record, then follows the list. A record that can't be read leaves it silent. */
  async start(): Promise<void> {
    let record: Set<string> | null;
    try {
      record = await this.record.read();
    } catch (error) {
      // Without the record every open question could show again: show none.
      console.warn(
        "[Decisions] Question notifications are off for this lifetime: the record couldn't be read:",
        error instanceof Error ? error.name : "error"
      );
      return;
    }
    if (this.stopped) return;
    this.claimed = new Set(record ?? []);
    this.seenBefore = record === null ? this.startedAt : null;
    this.off = this.o.questions.onChange((list) => this.follow(list));
    this.follow(this.o.questions.get());
    this.o.onFollowing?.();
  }

  stop(): void {
    this.stopped = true;
    const following = this.off !== null;
    this.off?.();
    this.off = null;
    if (following) this.o.onFollowing?.();
  }

  /**
   * Following the list, so a newly asked question can show (#17240): false
   * before its record is read, for a lifetime whose record couldn't be, and
   * once stopped.
   */
  get following(): boolean {
    return this.off !== null;
  }

  /** Resolves once every claim made so far has been written, or failed to be. */
  settled(): Promise<void> {
    return this.record.settled();
  }

  private follow(list: DecisionQuestionList): void {
    const claimed = this.claimed;
    if (this.stopped || claimed === null) return;
    const seenBefore = this.seenBefore;
    this.seenBefore = null;
    const fresh: DecisionQuestionListItem[] = [];
    const listed = new Set<string>();
    const settled: string[] = [];
    for (const question of list.questions) {
      const key = questionKey(question.reference);
      listed.add(key);
      if (!isNewlyAsked(question)) {
        if (question.standing.kind === "settled" && claimed.has(key)) settled.push(key);
        if (this.shown.delete(key)) this.o.close(key);
        continue;
      }
      if (claimed.has(key)) continue;
      claimed.add(key);
      const askedAt = Date.parse(question.askedAt);
      if (seenBefore !== null && Number.isFinite(askedAt) && askedAt < seenBefore) continue;
      fresh.push(question);
    }
    // The list is oldest first, so the oldest settled claims go first.
    for (const key of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_CLAIMS))) {
      claimed.delete(key);
    }
    // An emptied list is Decisions stopping, not its questions going.
    for (const key of this.shown) {
      if (listed.size > 0 && !listed.has(key)) {
        this.shown.delete(key);
        this.o.close(key);
      }
    }
    this.record.save(claimed);
    for (const question of fresh) void this.deliver(question);
  }

  private async deliver(asked: DecisionQuestionListItem): Promise<void> {
    const key = questionKey(asked.reference);
    // Until a saved snapshot holds the claim: a later one may save what an earlier one failed to.
    let writes: Promise<void>;
    do {
      writes = this.record.settled();
      await writes;
    } while (!this.record.isSaved(key) && writes !== this.record.settled());
    if (this.stopped) return;
    if (!this.record.isSaved(key)) {
      // Shown unsaved, a restart would show it again; the list's next change claims it afresh.
      if (this.claimed?.delete(key)) this.record.save(this.claimed);
      return;
    }
    let line: string | null;
    try {
      [line] = await Promise.all([
        this.o.readOpeningLine(asked.reference).catch(() => null),
        this.o.prepare?.(asked.reference),
      ]);
    } catch {
      // Nothing can present it.
      return;
    }
    if (this.stopped) return;
    // Answered, withdrawn or answered by the model while it was being read: nothing to ask.
    const current = this.o.questions
      .get()
      .questions.find((question) => questionKey(question.reference) === key);
    if (current === undefined || !isNewlyAsked(current)) return;
    if (!this.o.notificationsOn(current.reference.projectId)) return;
    this.shown.add(key);
    this.o.show(current, line, key);
  }
}
