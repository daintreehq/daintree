import { z } from "zod";
import {
  HANDBACK_MESSAGE_DESCRIPTION,
  HANDBACK_REPORTS,
  LAST_HANDBACK_DESCRIPTION,
} from "./handback.js";
import {
  INPUT_LINE_DESCRIPTION,
  INPUT_LINE_TEXT_DESCRIPTION,
  INPUT_LINE_TRUNCATED_DESCRIPTION,
  LAST_OUTPUT_CHANGE_AT_DESCRIPTION,
  LAST_TYPED_INPUT_AT_DESCRIPTION,
} from "./terminalStatus.js";

/**
 * The wire shape `terminal.getStatus` publishes, shared so main can check and
 * carry a status answer it gathered across projects (#16191) against the same
 * contract the action advertises.
 */

/**
 * One submission's delivery record (#12337).
 *
 * `z.enum` rather than a union of literals on purpose: a union renders as
 * `anyOf`, which strict-mode MCP clients reject, while an enum renders as a
 * plain `{ type: "string", enum: [...] }`.
 */
export const TerminalSubmissionRecordSchema = z.object({
  token: z.string(),
  phase: z
    .enum(["queued", "writing", "pty_written", "failed", "cancelled", "unknown"])
    .describe(
      "`pty_written`: the text and its Enter reached the pty; it does NOT mean the agent read or acted on them. `queued`/`writing`: in progress. `failed`/`cancelled`: not sent whole and part may sit in the composer, so re-sending is not safe. `unknown`: no record, including tokens older than the last 32."
    ),
  at: z.number().optional().describe("Epoch ms the phase was entered. Absent for `unknown`."),
  // Kept inside the 160-byte property target: the tool description is at its
  // cap, so what a caller should do with an absent value lives in the help
  // partials instead (#12478).
  outputChangeAfterWriteAt: z
    .number()
    .optional()
    .describe(
      "For pty_written only: epoch ms of the latest screen change stamped >200ms after the Enter. Ordering, not attribution; absent means no such change seen."
    ),
});

/** Wire shape of `TerminalHandback` (#12488). */
const TerminalHandbackSchema = z.object({
  message: z.string().nullable().describe(HANDBACK_MESSAGE_DESCRIPTION),
  report: z.enum(HANDBACK_REPORTS).optional(),
  observedAt: z.number(),
  submissionToken: z.string().optional(),
  truncated: z.boolean(),
});

/** What a terminal read saw in the agent's input box (#16189), on `getStatus` and `getOutput` alike. */
export const TerminalInputLineSchema = z
  .object({
    state: z.enum(["empty", "typed", "suggestion", "unknown"]),
    text: z.string().describe(INPUT_LINE_TEXT_DESCRIPTION),
    truncated: z.literal(true).optional().describe(INPUT_LINE_TRUNCATED_DESCRIPTION),
  })
  .describe(INPUT_LINE_DESCRIPTION);

export const TerminalStatusEntrySchema = z.object({
  terminalId: z.string(),
  agentId: z.string().nullable(),
  agentState: z.string().nullable(),
  waitingReason: z.string().optional(),
  lastTransitionAt: z.number().optional(),
  lastOutputChangeAt: z.number().optional().describe(LAST_OUTPUT_CHANGE_AT_DESCRIPTION),
  lastTypedInputAt: z.number().optional().describe(LAST_TYPED_INPUT_AT_DESCRIPTION),
  exitCode: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Set once the process exits, so absence means still running unless listed in `unavailableFields`. Null means killed by a signal with no numeric code."
    ),
  spawnedAt: z.number().optional().describe("Spawn time, epoch ms."),
  agentIncarnation: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Times a new agent took over this PTY after one exited, which `spawnedAt` misses. Absent is unobserved, not 0."
    ),
  lastCheckResult: z
    .object({
      command: z.string().nullable(),
      passed: z.boolean(),
      ranAt: z.number(),
      failureSummary: z.string().nullable(),
      truncated: z.boolean(),
    })
    .optional()
    .describe(
      "Best-effort parse of the agent's latest test, lint or build summary from its output, not an exit code. Absence means no summary seen, not no check and not a pass. Check its time for freshness."
    ),
  lastHandback: TerminalHandbackSchema.optional().describe(LAST_HANDBACK_DESCRIPTION),
  recentOutput: z.string().nullable().optional(),
  inputLine: TerminalInputLineSchema.optional(),
  recentOutputTruncated: z
    .boolean()
    .optional()
    .describe(
      "Older output was cut, by `lines` or the shared 50 KiB budget; the newest lines are kept."
    ),
  armed: z
    .boolean()
    .optional()
    .describe(
      "Whether fleet broadcast input reaches this terminal. Set for every found terminal unless in `unavailableFields`."
    ),
  hasPty: z
    .boolean()
    .optional()
    .describe(
      "False once the process exited or a kill was requested. Not a health probe: a keep-open shell or a wedged agent still reads true. Unavailable on the `renderer` surface."
    ),
  submission: TerminalSubmissionRecordSchema.optional().describe(
    "Delivery record for the named token. Absent without a token or when the terminal could not be read, which differs from holding no record."
  ),
  error: z
    .string()
    .optional()
    .describe(
      "Set when the terminal was not found, and on every resolved entry when a batched fetch fails; then the status fields are still set and only that fetch's field is missing. Never fails the call."
    ),
});

export const TerminalStatusResultSchema = z.object({
  terminals: z.array(TerminalStatusEntrySchema),
  source: z
    .enum(["renderer", "pty"])
    .describe(
      "Which surface answered; `pty` is the reduced reading when this workspace has no open window."
    ),
  unavailableFields: z
    .array(
      z.enum([
        "armed",
        "lastCheckResult",
        "exitCode",
        "hasPty",
        "lastOutputChangeAt",
        "lastTypedInputAt",
      ])
    )
    .describe(
      "Fields this surface cannot observe: absent from every entry, unknown rather than false."
    ),
});
