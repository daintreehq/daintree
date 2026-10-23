import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import { z } from "zod";
import {
  TerminalSummarySchema,
  TerminalStatusResultSchema,
  TerminalSendCommandResultSchema,
  TerminalLastMessageResultSchema,
  PanelLimitSnapshotSchema,
} from "./schemas";
import {
  LAST_MESSAGE_CURSOR_MAX_CHARS,
  LAST_MESSAGE_INDEX_MAX,
  LAST_MESSAGE_TEXT_REQUEST_MAX_BYTES,
  LAST_MESSAGE_TEXT_REQUEST_MIN_BYTES,
} from "@shared/types/agentLastMessage";
import {
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS,
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  WAIT_UNTIL_IDLE_BATCH_DESCRIPTION,
  WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
} from "@shared/types/terminalWaitUntilIdle";
import { NOTIFY_ARG_DESCRIPTION, NotifyReplyLinesSchema } from "@shared/types/terminalNotify";
import { WaitForReplySchema, WaitSecondsSchema } from "@shared/types/replyWait";
import {
  TerminalCloseManyArgsSchema,
  TerminalSendCommandManyArgsSchema,
} from "@shared/types/mcpBatch";
import type { TerminalQueryActionRunId } from "./terminalQueryActions.impl";

/**
 * The `handback` argument, shared by both submit tools so the two descriptions
 * cannot drift (#12488).
 */
const HANDBACK_ARG_SCHEMA = z
  .boolean()
  .optional()
  .describe(
    "Ask the agent to end its reply with a Daintree marker, read back as `lastHandback`. Agent panes only."
  );

/**
 * Which run of another assistant a send is for (#13496), shared by both submit
 * tools. Main consumes it; an assistant target refuses a send without it, or
 * with a run that has since been replaced.
 */
const ASSISTANT_GENERATION_ARG_SCHEMA = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Sending to another assistant: its generation from the assistant listing.");

/**
 * The `notify` argument, shared by both submit tools and `agent.launch`. Main
 * consumes it before dispatch — which prompt to type into is known only from
 * the caller's MCP credential — so `run()` never acts on it; it is declared so
 * the tool's input schema advertises it.
 */
const NOTIFY_ARG_SCHEMA = z.boolean().optional().describe(NOTIFY_ARG_DESCRIPTION);

/**
 * Run bodies load on first dispatch (#14273). Every view registers these at
 * boot for menus, keybindings and the MCP manifest, but an empty view runs
 * none of them. A failed chunk load rejects inside `run`, which ActionService
 * turns into an error result like any other failure.
 */
async function runTerminalQueryAction(
  id: TerminalQueryActionRunId,
  args: unknown,
  ctx: ActionContext
): Promise<unknown> {
  const { terminalQueryActionRuns } = await import("./terminalQueryActions.impl");
  return terminalQueryActionRuns[id](args, ctx);
}

export function registerTerminalQueryActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.list", () => ({
    id: "terminal.list",
    title: "List terminals",
    description:
      "List open terminals and panels with enough metadata to pick one and learn its id. A cheap inventory, not a polling path: the status snapshot carries agent state for many in one call. Ephemeral and internal panels are omitted; empty means nothing matched.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z
          .string()
          .optional()
          .describe("Only this worktree. Omit for every worktree in the project."),
        location: z
          .enum(["grid", "dock", "trash", "background"])
          .optional()
          .describe("Only this location. Omitted, trash and background are excluded."),
        owned: z
          .boolean()
          .optional()
          .describe(
            "MCP only: true keeps only terminals you created or were handed; false or omitted, no filter. An agent pane keeps them across reconnects."
          ),
        terminalId: z
          .string()
          .min(1)
          .optional()
          .describe("Only this panel id; one not open yields an empty listing, not an error."),
        includeClientMetadata: z
          .boolean()
          .optional()
          .describe(
            "Add each terminal's client-metadata record (up to 2KB each); narrow the listing on a large fleet."
          ),
      })
      .optional(),
    resultSchema: z.object({
      terminals: z.array(TerminalSummarySchema),
      // Unfiltered by the arguments, so an orchestrator can stay under the limit.
      panelLimit: PanelLimitSnapshotSchema,
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) => runTerminalQueryAction("terminal.list", args, ctx),
  }));

  actions.set("terminal.getOutput", () => ({
    id: "terminal.getOutput",
    title: "Get terminal output",
    description:
      "Read one terminal's trailing output: what an agent or command printed. For several, the status snapshot reads every tail in one call. ANSI is stripped by default; a missing terminal returns an error field, not a failed call.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    // Terminal text routinely carries secrets, so plugins read it through
    // `host.terminals.readScreen`, behind `terminal:read` and its consent
    // prompt, never through this ungated `safe` action (#13155).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe(
          "Panel id from the terminal listing. An untracked id returns an error field, not a failed call."
        ),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Max lines (default 100, max 1000)"),
      stripAnsi: z.boolean().default(true).describe("Strip ANSI escape codes (default true)"),
    }),
    examples: [
      {
        args: { terminalId: "term-abc123" },
        description: "Get last 100 lines from a terminal with ANSI stripped",
      },
      {
        args: { terminalId: "term-abc123", maxLines: 500, stripAnsi: false },
        description: "Get last 500 lines with ANSI codes preserved",
      },
    ],
    resultSchema: z.object({
      terminalId: z.string(),
      content: z.string().nullable(),
      lineCount: z.number(),
      truncated: z
        .boolean()
        .describe(
          "True when older output was left out, by `maxLines` or the 50 KiB response budget; the newest lines are kept."
        ),
      error: z.string().optional(),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalQueryAction("terminal.getOutput", args, ctx),
  }));

  // Manifest metadata only: main submits each item as `terminal.sendCommand`
  // (the owned form for an agent pane) under the single call's gate.
  actions.set("terminal.sendCommandMany", () => ({
    id: "terminal.sendCommandMany",
    title: "Submit to several terminals",
    description:
      "Submit a different message to each of several terminals in one call, such as one ballot per voter. Each runs as a single send, with its own notice; results come back in order.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["send", "several", "many", "batch", "broadcast", "each"],
    palette: { mode: "hidden" },
    argsSchema: TerminalSendCommandManyArgsSchema,
    run: async () => {
      throw new Error(
        "terminal.sendCommandMany must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("terminal.closeMany", () => ({
    id: "terminal.closeMany",
    title: "Close several terminals",
    description:
      "Close several terminals in one call, each as a single close (owned for an agent pane), to the trash. Results come back in order.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["close", "several", "many", "batch", "cleanup"],
    palette: { mode: "hidden" },
    argsSchema: TerminalCloseManyArgsSchema,
    run: async () => {
      throw new Error(
        "terminal.closeMany must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("terminal.getStatus", () => ({
    id: "terminal.getStatus",
    title: "Get terminal status",
    description:
      "Snapshot agent and process state for many terminals in one call, with optional output tails, and confirm a submission landed. Prefer it to listing terminals or reading each. Never fails whole; an entry's error means that terminal was missing or unreadable.",
    // The MCP answer to "what state is this agent in" since `agent.getState`
    // left the tool sets, so search has to find it by those words.
    keywords: ["agent", "state", "waiting", "working"],
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        terminalIds: z
          .array(z.string())
          .min(1)
          .max(256)
          .optional()
          .describe(
            "1-256 terminals; overrides the filters. An unknown id gets an `error` entry, not a failed call."
          ),
        worktreeId: z.string().optional().describe("Filter by worktree."),
        location: z
          .enum(["grid", "dock", "trash", "background"])
          .optional()
          .describe("Filter by location. Default: all but trash and background."),
        submissionToken: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "Token from a send; adds its delivery record to each entry. Needs `terminalIds`."
          ),
        // `true` is what a model reaches for first; it reads as the defaults.
        includeOutput: z
          .union([
            z.boolean(),
            z.object({
              lines: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(20)
                .describe("Trailing lines per terminal (max 50, default 20)."),
              stripAnsi: z
                .boolean()
                .default(true)
                .describe("Strip ANSI from `recentOutput` (default true)."),
            }),
          ])
          .optional()
          .describe(
            "`true` or options: adds `recentOutput` (last N lines), plus `lastOutputChangeAt` and `lastTypedInputAt` when observed."
          ),
      })
      .optional(),
    resultSchema: TerminalStatusResultSchema,
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalQueryAction("terminal.getStatus", args, ctx),
  }));

  // terminal.waitUntilIdle is registered here purely for manifest registration —
  // schema, description, tier, and audit metadata. Execution is handled inline
  // in the MCP CallTool handler (electron/services/mcp-server/sessionServer.ts)
  // because the request must stay in the main process: the renderer-dispatch
  // path has a 30s timeout (external sessions may wait up to 2 hours) and
  // cannot serialize the AbortSignal that powers MCP request cancellation.
  // `run()` throws if the renderer ever invokes it directly.
  actions.set("terminal.waitUntilIdle", () => ({
    id: "terminal.waitUntilIdle",
    title: "Wait until terminal idle",
    description: WAIT_UNTIL_IDLE_DESCRIPTION,
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z.string().min(1).describe(
        // Kept under the 160 B property target; `trackingState` is explained
        // in the tool description and its own output-schema entry.
        "Panel id from the terminal listing. A closed or unknown id resolves as idle, not a failure."
      ),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS)
        .optional()
        .describe(
          "0 for an immediate snapshot (recommended); otherwise max ms to long-poll, default 60s. Interactive sessions cap at 60s, headless at 2 hours."
        ),
    }),
    rawOutputSchema: WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
    // Without this, `computeSchemas` leaves `outputSchema` undefined and
    // tools/list advertises nothing — even though the main-process path already
    // attaches `structuredContent` unconditionally (#12339).
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
    },
    run: async () => {
      throw new Error(
        "terminal.waitUntilIdle must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  // Batched sibling of terminal.waitUntilIdle — same manifest-only pattern,
  // executed inline in the MCP CallTool handler (main process). `run()` throws if
  // the renderer ever invokes it directly. See the note above terminal.waitUntilIdle.
  actions.set("terminal.waitUntilIdleBatch", () => ({
    id: "terminal.waitUntilIdleBatch",
    title: "Wait until terminals idle (batch)",
    description: WAIT_UNTIL_IDLE_BATCH_DESCRIPTION,
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalIds: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS)
        .describe(
          `Terminals to watch, 1-${MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS}. Closed or unknown ids settle rather than fail; each row's \`trackingState\` says which.`
        ),
      mode: z
        .enum(["first", "all"])
        .optional()
        .describe(
          "'first' returns when any one stops (refill as each frees up), 'all' once every one has (a join)."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS)
        .optional()
        .describe(
          "0 for an immediate snapshot; otherwise max ms to long-poll, default 60s. Interactive sessions cap at 60s, headless at 2 hours."
        ),
    }),
    rawOutputSchema: WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
    // See the note on terminal.waitUntilIdle above.
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: false,
      destructiveHint: false,
    },
    run: async () => {
      throw new Error(
        "terminal.waitUntilIdleBatch must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  // Registered here for manifest metadata only — schema, description, tier and
  // audit registration. Execution lives in the MCP CallTool handler
  // (electron/services/mcp-server/sessionServer.ts): the ownership ledger it
  // authorizes against is keyed by MCP session id, which the renderer never
  // sees, and the transcript it reads is a file only main can open. Main checks
  // ownership — for Daintree's own assistant, the pinned view's project as well
  // (#12883, #13439) — then reads the agent's session from host state alone
  // (#12479).
  // `run()` throws if the renderer ever invokes it directly.
  actions.set("terminal.readLastMessageOwned", () => ({
    id: "terminal.readLastMessageOwned",
    title: "Read owned agent's last message",
    description:
      "Read an agent's last transcript reply and unanswered tool calls, e.g. a question and its options. Agents this connection launched or was handed (right-click > Hand to orchestrator); Daintree's assistant: any in its project. Claude Code only, or another assistant's screen. Not proof the agent is waiting.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["transcript", "reply", "question", "owned"],
    palette: { mode: "hidden" },
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe(
          "Agent panel `id` the description says you may read. Required; no focus fallback."
        ),
      maxBytes: z
        .number()
        .int()
        .min(LAST_MESSAGE_TEXT_REQUEST_MIN_BYTES)
        .max(LAST_MESSAGE_TEXT_REQUEST_MAX_BYTES)
        .optional()
        .describe("Text budget in escaped bytes, 1024 to 49152; default 24576."),
      messageIndex: z
        .number()
        .int()
        .min(0)
        .max(LAST_MESSAGE_INDEX_MAX)
        .optional()
        .describe("Replies back from the latest with text: 0 (default) to 20. Not with `cursor`."),
      cursor: z
        .string()
        .min(1)
        .max(LAST_MESSAGE_CURSOR_MAX_CHARS)
        .optional()
        .describe("A result's `message.nextCursor`, unchanged, for the text before that page."),
    }),
    resultSchema: TerminalLastMessageResultSchema,
    mcpOutputSchema: true,
    examples: [
      {
        args: { terminalId: "term-abc123" },
        description:
          "An agent you launched stopped, and you need its hand-off or the exact question it asked before replying.",
      },
    ],
    run: async () => {
      throw new Error(
        "terminal.readLastMessageOwned must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("terminal.sendCommand", () => ({
    id: "terminal.sendCommand",
    title: "Submit text to terminal",
    description:
      "Queue text as one submission to a terminal: a shell runs it, an agent pane takes it as its next prompt. Returns once queued, not delivered or run; pass the returned `submissionToken` to a status read to check. Runs with the terminal's privileges.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Never captured into `lastAction`: replaying `action.repeatLast` would
    // re-inject the exact same text into the agent pane, which for a composed
    // submission (instruction plus the user's draft) is a silent duplicate send.
    nonRepeatable: true,
    // Reachable by user and agent (MCP) dispatch, but NOT by plugin
    // host.dispatch — sending text into an agent terminal is exactly the
    // injection the capability model gates. Plugins must declare `agent:input`
    // and use `host.sendToActiveAgent(...)` instead of routing around the
    // capability through this ungated `safe` action (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        // Bounded because it is echoed back in the result, and the result is
        // schema-advertised: past the response budget the transport drops
        // `structuredContent` and flags the call `isError`, which would lose
        // the token for a submission that went out. `agent.launch` accepts an
        // arbitrary `requestedId`, so an id long enough to do that is
        // reachable. Panel ids are short; this rejects only pathological ones,
        // and rejecting is clearer than a truncated success reported as a
        // failure.
        .max(512)
        .describe("Panel id from the terminal listing."),
      command: z
        .string()
        .min(1)
        .describe(
          "A shell command or the agent's next prompt. Multi-line text goes in atomically with one Enter."
        ),
      handback: HANDBACK_ARG_SCHEMA,
      generation: ASSISTANT_GENERATION_ARG_SCHEMA,
      notify: NOTIFY_ARG_SCHEMA,
      replyLines: NotifyReplyLinesSchema,
      waitForReply: WaitForReplySchema,
      waitSeconds: WaitSecondsSchema,
    }),
    resultSchema: TerminalSendCommandResultSchema,
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runTerminalQueryAction("terminal.sendCommand", args, ctx),
  }));

  // Registered here for manifest metadata only — schema, description, tier and
  // audit registration. Execution lives in the MCP CallTool handler
  // (electron/services/mcp-server/sessionServer.ts): the ownership ledger it
  // authorizes against is keyed by MCP session id, which the renderer cannot
  // see and must never be told. Main checks ownership, then delegates to
  // `terminal.sendCommand` above with only the id and the text, so the
  // submission path and its receipt are the ones already shipped (#12407).
  actions.set("terminal.sendCommandOwned", () => ({
    id: "terminal.sendCommandOwned",
    title: "Submit text to owned terminal",
    description:
      "Queue text as one submission to a terminal this connection created or was handed (right-click > Hand to orchestrator): a shell runs it, an agent pane takes it as its next prompt. Any other panel is refused. Returns once queued, not delivered or run; pass the returned `submissionToken` to a status read to check.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Same reason as `terminal.sendCommand`: a replay would submit the text twice.
    nonRepeatable: true,
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["submit", "prompt", "command", "owned"],
    palette: { mode: "hidden" },
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .max(512)
        .describe("Terminal `id` this session created or was handed."),
      command: z
        .string()
        .min(1)
        .describe("Text to submit. Multi-line text goes in atomically with one Enter."),
      handback: HANDBACK_ARG_SCHEMA,
      generation: ASSISTANT_GENERATION_ARG_SCHEMA,
      notify: NOTIFY_ARG_SCHEMA,
      replyLines: NotifyReplyLinesSchema,
      waitForReply: WaitForReplySchema,
      waitSeconds: WaitSecondsSchema,
    }),
    resultSchema: TerminalSendCommandResultSchema,
    mcpOutputSchema: true,
    run: async () => {
      throw new Error(
        "terminal.sendCommandOwned must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));
}
