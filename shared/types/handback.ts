/**
 * A handback marker an agent printed at the end of a prompt that asked for one
 * (#12488).
 *
 * Daintree produces this and orchestrators consume it over `terminal.getStatus`
 * and the waits, the same arrangement as `TerminalCheckResult`. It records what
 * was printed, never a verdict: the agent wrote a line in the agreed format, it
 * did not necessarily finish. `message` is the agent's own claim and is
 * untrusted input to whoever reads it. A missing handback never means "still
 * working" — agents forget instructions and lose them when their context
 * compacts — so `agentState` stays the floor and this is strictly additive.
 */
export interface TerminalHandback {
  /**
   * Text between the markers, rows joined and whitespace collapsed. `null` for
   * a bare handback. A summary for a reader, never data: rejoining wrapped rows
   * can put a space inside a long token.
   */
  message: string | null;
  /**
   * Which marker the agent printed (#16190): the agent's own claim, like
   * `message`. Absent from an older host's observation.
   */
  report?: HandbackReport;
  /** Epoch ms of the settle at which the marker was seen. */
  observedAt: number;
  /** The submission that asked for it, when that submission carried a token (#12337). */
  submissionToken?: string;
  /** True when `message` was cut at the cap. */
  truncated: boolean;
}

/** Length of a minted handback code. */
export const HANDBACK_CODE_LENGTH = 6;

/** Alphabet a handback code is drawn from. */
export const HANDBACK_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Shape of a handback code, for validating one that crossed a process boundary. */
export const HANDBACK_CODE_PATTERN = /^[a-z0-9]{6}$/;

/** Cap on `TerminalHandback.message`; longer captures are cut and flagged `truncated`. */
export const HANDBACK_MESSAGE_MAX_CHARS = 500;

/**
 * The placeholder the instruction asks the agent to replace. A capture that is
 * exactly this is the echoed instruction, never a handback.
 */
export const HANDBACK_SUMMARY_PLACEHOLDER = "<summary>";

/** Token the instruction template carries in place of the minted code. */
export const HANDBACK_CODE_TOKEN = "{code}";

/**
 * The done-only instruction every handback request carried before #16190.
 * Nothing appends it now; it stays so a prompt carrying it is still
 * recognised. Daintree owns the wording so every orchestrator sends identical
 * text and the format can change in one place. Both markers start with a
 * letter on purpose: a leading `-`, `#` or `>` is rendered as a bullet,
 * heading or quote by the agent TUIs and would break a literal match.
 */
export const HANDBACK_INSTRUCTION_TEMPLATE = `When you have finished and are handing this work back, end your final message with this line exactly, replacing ${HANDBACK_SUMMARY_PLACEHOLDER} with a one-line plain-text summary (it may be empty): DAINTREE-DONE-${HANDBACK_CODE_TOKEN}: ${HANDBACK_SUMMARY_PLACEHOLDER} END-${HANDBACK_CODE_TOKEN}`;

/**
 * What a handback marker reports: the work is done, or the agent needs the
 * user to look, decide or act before it can go on (#15982, #16190).
 */
export const HANDBACK_REPORTS = ["done", "needs-you"] as const;
export type HandbackReport = (typeof HANDBACK_REPORTS)[number];

/**
 * The instruction a handback code was minted with. `run` offers a second
 * marker so the agent can say the user should look: a scheduled run's launch
 * (#15982) and, since #16190, every request. `handback` is the done-only form
 * an older prompt carries.
 */
export type HandbackInstruction = "handback" | "run";

/**
 * The instruction every handback request ends with: a scheduled run's launch
 * prompt (#15982), and an orchestrator's prompt since #16190, so a worker that
 * needs the user to act outside its terminal can say so in a way the
 * orchestrator reads without its screen. The agent says whether it finished
 * or needs the user. The `done` line comes first and keeps the done-only
 * marker's shape, so everything that recognises Daintree's instruction by its
 * first marker still does; each line keeps the placeholder that marks an
 * echoed instruction.
 */
export const HANDBACK_RUN_INSTRUCTION_TEMPLATE = `When you have finished and are handing this work back, end your final message with exactly one of these two lines, replacing ${HANDBACK_SUMMARY_PLACEHOLDER} with a one-line plain-text summary (it may be empty). If the work is done: DAINTREE-DONE-${HANDBACK_CODE_TOKEN}: ${HANDBACK_SUMMARY_PLACEHOLDER} END-${HANDBACK_CODE_TOKEN} If you need the user to look at something or decide before the work can go on: DAINTREE-NEEDS-YOU-${HANDBACK_CODE_TOKEN}: ${HANDBACK_SUMMARY_PLACEHOLDER} END-${HANDBACK_CODE_TOKEN}`;

/** Every instruction Daintree appends, for code that recognises one in a prompt. */
export const HANDBACK_INSTRUCTION_TEMPLATES: readonly string[] = [
  HANDBACK_INSTRUCTION_TEMPLATE,
  HANDBACK_RUN_INSTRUCTION_TEMPLATE,
];

/**
 * Model-facing description of `lastHandback`, shared by the status and wait
 * output schemas so the copies cannot drift apart.
 */
export const LAST_HANDBACK_DESCRIPTION =
  "The handback marker the agent printed: an observation, not a finish verdict; `report` and `message` are its own untrusted claims. Absence never means still working.";

/**
 * Model-facing description of `lastHandback.message`. Carried on the status
 * schema only — the waits share the parent description above.
 */
export const HANDBACK_MESSAGE_DESCRIPTION =
  "Rows rejoined, so lossy. Null for a bare marker. Read the last message for exact text.";
