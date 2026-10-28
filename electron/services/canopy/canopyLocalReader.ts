/**
 * Canopy's reads, on this machine: the chosen model, loaded in its own process
 * on first use and let go when Canopy stops reading. One reading gives a run
 * its state, its attention and its words together, all lines copied off the
 * screen; nothing is generated and nothing leaves the machine.
 */
import { CANOPY_CATEGORIES, type CanopyCategory } from "../../../shared/types/ipc/canopy.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { displayText, readerCard, type Reading, type ReaderState } from "./canopyReader.js";
import { CanopyReaderError, CanopyReaderProcess } from "./canopyReaderProcess.js";
import {
  CanopyProviderError,
  toDescriberResult,
  type CanopyScreenInput,
  type ClassifierResult,
  type DescriberResult,
} from "./canopyProviders.js";
import { cleanStatusLine } from "./canopyScreen.js";
import { irreversibleReason } from "./canopyRisk.js";

/**
 * One reading of one screen: the verdict at once, and the words that go with
 * it, turned from line picks into text only when a row's words are due.
 */
export interface CanopyReading {
  classifier: ClassifierResult;
  words: () => Promise<DescriberResult>;
}

/** Rows above an approval's prompt that can hold the command it asks about. */
const APPROVAL_LOOKBACK_ROWS = 8;

/** Times a reader may die in a row before Canopy stops starting new ones until the model changes. */
const MAX_CRASHES = 3;

/** Whole seconds, as the model was trained on: `JSON.stringify(1.0)` writes `1`. */
function seconds(value: number | null | undefined): number | undefined {
  return value === null || value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.round(value));
}

/**
 * The state the model reads above the screen. Key order matters: it is
 * tokenized as JSON, in the order it was trained on, with unknown fields left out.
 */
export function readerState(input: CanopyScreenInput): ReaderState & Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  if (input.observed.agentState) observed.agent_state = input.observed.agentState;
  if (input.observed.waitingReason) observed.waiting_reason = input.observed.waitingReason;
  const inState = seconds(input.observed.secondsInState);
  if (inState !== undefined) observed.seconds_in_state = inState;
  const unchanged = seconds(input.observed.screenUnchangedSeconds);
  if (unchanged !== undefined) observed.screen_unchanged_seconds = unchanged;
  const state: ReaderState & Record<string, unknown> = {
    agent_program: input.agent,
    terminal_title: input.title,
  };
  if (Object.keys(observed).length > 0) state.daintree_observed = observed;
  const action = input.userAction;
  if (action) {
    state.user_action = action.kind;
    state.seconds_since_user_action = Math.max(0, Math.round(action.secondsAgo));
    state.screen_changed_since_user_action = action.screenChangedSince;
  }
  return state;
}

function count(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** A reading as the service takes it: the classifier's verdict and the run's card. */
export function toCanopyReading(reading: Reading, input: CanopyScreenInput): CanopyReading {
  if (!CANOPY_CATEGORIES.includes(reading.category as CanopyCategory)) {
    throw new CanopyProviderError("classifier", "unexpected category");
  }
  const category = reading.category as CanopyCategory;
  const lines = input.lines;
  const asks = category === "approval" || category === "question";
  // The status line alone, not the sentence joined over the lines after it:
  // what the row quotes must be found on the screen as it is.
  const statusLine = reading.status_line >= 0 ? displayText(lines[reading.status_line]) : null;
  const status = statusLine === null ? null : cleanStatusLine(statusLine);
  const question =
    asks && reading.question_line >= 0 ? displayText(lines[reading.question_line]) : null;
  const classifier: ClassifierResult = {
    category,
    confidence: Math.max(...reading.category_probs),
    attention: reading.needs_attention,
    blocked: reading.blocked_on_user,
    notable: reading.notable,
    question,
    status: status !== null && status.length >= 4 ? status : null,
  };
  const words = async (): Promise<DescriberResult> => {
    const card = readerCard(reading, lines);
    // The command is on the dialog whether or not the reader picked its line:
    // the rows around the prompt, down to the choices, are all read for it.
    const around =
      reading.question_line >= 0
        ? lines.slice(Math.max(0, reading.question_line - APPROVAL_LOOKBACK_ROWS))
        : lines.slice(-APPROVAL_LOOKBACK_ROWS);
    // A summary-only card has no headline: its first line takes the ask's
    // place under the terminal's own title, and the second the summary's.
    const [first, ...rest] =
      card.headline === null ? card.summary : [card.headline, card.summary.join(" ")];
    const caution = irreversibleReason(card.action, first ?? null, question, ...around);
    return toDescriberResult(
      {
        category,
        headline: first ?? "",
        summary: rest.join(" "),
        question: card.question,
        options: card.options,
        attention_score: Number(reading.score),
        // Only a raise: a command known to be irreversible takes the second press
        // whatever the reader said, and the reader's own caution is never lowered.
        risk: category === "approval" && caution !== null ? "caution" : reading.risk,
        risk_reason: category === "approval" ? caution : null,
        progress: reading.progress === "none" ? null : Number(reading.progress),
        tests: reading.tests,
        changes: reading.changes,
        action: card.action,
        task: card.task,
        instruction: reading.instruction,
        failure_repeats: count(reading.failure_repeats),
      },
      input
    );
  };
  return { classifier, words };
}

/**
 * The reader process for the chosen model: started on the first read, let go
 * on `release()`, and swapped when the model changes. A process that dies is
 * replaced on the next read, up to `MAX_CRASHES` in a row.
 */
export class CanopyLocalReader {
  private process: CanopyReaderProcess | null = null;
  /** Processes lost in a row for `crashedDir`, each counted once however many reads it took with it. */
  private crashes = 0;
  private crashedDir: string | null = null;
  private readonly counted = new WeakSet<CanopyReaderProcess>();
  /** Bumped by `release()`: a read started before it says nothing about the model's health. */
  private generation = 0;

  constructor(
    /** The folder of the chosen model when it is on this machine, else null. */
    private readonly modelDir: () => Promise<string | null>,
    private readonly spawn: (dir: string, onExit: () => void) => CanopyReaderProcess = (
      dir,
      onExit
    ) => new CanopyReaderProcess(dir, onExit)
  ) {}

  /** A process is up, with a model loaded or loading. */
  get loaded(): boolean {
    return this.process?.live ?? false;
  }

  async read(input: CanopyScreenInput, signal: AbortSignal): Promise<CanopyReading> {
    const generation = this.generation;
    const dir = await this.modelDir();
    if (dir === null) throw new CanopyProviderError("classifier", "model not downloaded", true);
    if (signal.aborted || generation !== this.generation) {
      throw new CanopyProviderError("classifier", "request cancelled");
    }
    if (this.crashedDir === dir && this.crashes >= MAX_CRASHES) {
      throw new CanopyProviderError("classifier", "the model keeps failing to run");
    }
    let process = this.process;
    if (process === null || !process.live || process.modelDir !== dir) {
      process?.retire();
      const made: CanopyReaderProcess = this.spawn(dir, () => {
        if (this.process === made) this.process = null;
      });
      process = made;
      this.process = made;
    }
    try {
      await process.ready;
      const { reading } = await process.read(readerState(input), [...input.lines]);
      this.crashes = 0;
      this.crashedDir = null;
      // A read cancelled while the model ran is dropped, its answer unused.
      if (signal.aborted) throw new CanopyProviderError("classifier", "request cancelled");
      return toCanopyReading(reading, input);
    } catch (error) {
      if (error instanceof CanopyProviderError) throw error;
      // Let go on purpose meanwhile: not the model's fault.
      if (generation !== this.generation) {
        throw new CanopyProviderError("classifier", "request cancelled");
      }
      const message = formatErrorMessage(error, "");
      // A model this build can't read will never load: no retry, and say why.
      if (/newer version/i.test(message)) {
        throw new CanopyProviderError("classifier", "the model needs a newer version");
      }
      if (error instanceof CanopyReaderError && error.processLost) {
        if (!this.counted.has(process)) {
          this.counted.add(process);
          if (this.crashedDir !== dir) this.crashes = 0;
          this.crashedDir = dir;
          this.crashes++;
        }
        const timedOut = /too long|timed out/i.test(message);
        throw new CanopyProviderError(
          "classifier",
          timedOut ? "the model timed out" : "the model stopped",
          this.crashes < MAX_CRASHES
        );
      }
      throw new CanopyProviderError("classifier", "the model couldn't read this screen");
    }
  }

  /** Lets the model go: Canopy turned off, or its model removed or changed. */
  release(): void {
    this.generation++;
    this.process?.retire();
    this.process = null;
    this.crashes = 0;
    this.crashedDir = null;
  }
}
