import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionReference,
} from "../../../shared/types/decisionsQuestion.js";
import type { MetaStore } from "./attentionList.js";

/**
 * The questions this computer has raised a desktop notification for (#17232),
 * by full reference, kept in the store's own meta table so a restart, a
 * reconnect or a Remote Host coming back never raises one again. Ids only.
 */
export const NOTIFIED_QUESTIONS_META_KEY = "daintree:notified-questions";

const MAX_KEY_LENGTH = 1024;

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
  /** Whether this computer's notifications are on for the question's project. */
  notificationsOn: (projectId: string) => boolean;
  show: (question: DecisionQuestionListItem, openingLine: string | null, key: string) => void;
  /** Takes down the banner shown under `key`, once its question no longer waits. */
  close: (key: string) => void;
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

/** The record as stored, or null when there is none or it can't be read as one. */
function parseRecord(text: string | null): Set<string> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return new Set(
    parsed.filter(
      (key): key is string =>
        typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH
    )
  );
}

/**
 * Raises one desktop notification for each question an agent asks (#17232),
 * whatever terminal asked it and whether anyone watches it, for one owner
 * store's lifetime. Each question is claimed in the store before it shows, so
 * it shows at most once across restarts; one that stopped waiting before it
 * would show, or asked while notifications are off, is claimed and never
 * shown. With no record yet (the first run, or one damaged), the questions
 * asked before this lifetime began are taken as already seen.
 */
export class QuestionNotifier implements QuestionNotifications {
  private claimed: Set<string> | null = null;
  private written = "";
  private writing: Promise<void> = Promise.resolve();
  private shown = new Set<string>();
  private stopped = false;
  private off: (() => void) | null = null;
  private readonly startedAt: number;
  /** Questions asked before this time are taken as seen; null once the record held. */
  private seenBefore: number | null = null;
  private readonly now: () => number;

  constructor(private readonly o: QuestionNotifierOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Reads the record, then follows the list. A record that can't be read leaves it silent. */
  async start(): Promise<void> {
    let text: string | null;
    try {
      text = await this.o.store.getMeta(NOTIFIED_QUESTIONS_META_KEY);
    } catch (error) {
      // Without the record every open question could show again: show none.
      console.warn(
        "[Decisions] Question notifications are off for this lifetime: the record couldn't be read:",
        error instanceof Error ? error.name : "error"
      );
      return;
    }
    if (this.stopped) return;
    const record = parseRecord(text);
    this.claimed = record ?? new Set();
    this.written = record === null ? "" : JSON.stringify([...record]);
    this.seenBefore = record === null ? this.startedAt : null;
    this.off = this.o.questions.onChange((list) => this.follow(list));
    this.follow(this.o.questions.get());
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
  }

  /** Resolves once every claim made so far has been written, or failed to be. */
  settled(): Promise<void> {
    return this.writing;
  }

  private follow(list: DecisionQuestionList): void {
    const claimed = this.claimed;
    if (this.stopped || claimed === null) return;
    const fresh: DecisionQuestionListItem[] = [];
    const listed = new Set<string>();
    for (const question of list.questions) {
      const key = questionKey(question.reference);
      listed.add(key);
      const asked = isNewlyAsked(question);
      if (!asked) {
        // A settled question never waits again: its claim has done its job.
        if (question.standing.kind === "settled") claimed.delete(key);
        if (this.shown.delete(key)) this.o.close(key);
        continue;
      }
      if (claimed.has(key)) continue;
      claimed.add(key);
      const askedAt = Date.parse(question.askedAt);
      if (this.seenBefore !== null && Number.isFinite(askedAt) && askedAt < this.seenBefore) {
        continue;
      }
      fresh.push(question);
    }
    // An emptied list is Decisions stopping, not its questions going.
    for (const key of this.shown) {
      if (listed.size > 0 && !listed.has(key)) {
        this.shown.delete(key);
        this.o.close(key);
      }
    }
    const written = this.persist(claimed);
    for (const question of fresh) void this.deliver(question, written);
  }

  /** Writes the record when it changed, one write at a time. */
  private persist(claimed: ReadonlySet<string>): Promise<void> {
    const text = JSON.stringify([...claimed]);
    if (text === this.written) return this.writing;
    this.written = text;
    this.writing = this.writing.then(() =>
      this.o.store.setMeta(NOTIFIED_QUESTIONS_META_KEY, text).catch((error: unknown) => {
        console.warn(
          "[Decisions] The question notification record couldn't be saved:",
          error instanceof Error ? error.name : "error"
        );
      })
    );
    return this.writing;
  }

  private async deliver(asked: DecisionQuestionListItem, written: Promise<void>): Promise<void> {
    const key = questionKey(asked.reference);
    await written;
    let line: string | null = null;
    try {
      line = await this.o.readOpeningLine(asked.reference);
    } catch {
      // Shown without its opening line: the question itself still waits for the person.
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
