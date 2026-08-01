import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { TerminalSummarySchema, TerminalStatusEntrySchema } from "./schemas";
import { tailCapturedOutput } from "@shared/utils/artifactParser";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalClient } from "@/clients";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { TerminalCheckResult } from "@shared/types/checkResult";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_BATCH_TERMINALS,
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  WAIT_UNTIL_IDLE_BATCH_DESCRIPTION,
  WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
} from "@shared/types/terminalWaitUntilIdle";
import { isEphemeralPanel } from "@/store/slices/panelRegistry/panelCount";
export function registerTerminalQueryActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.list", () => ({
    id: "terminal.list",
    title: "List Terminals",
    description:
      "Enumerate the open terminals and panels, with just enough metadata to pick one to act on. Start here to discover terminal ids, then read status or output for the ones that matter — this is a cheap inventory, not a polling path, and the status snapshot carries richer agent state for a whole fleet in one call. Ephemeral and internal panels are left out, and an empty result means no terminals are open rather than a failure.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z
      .object({
        worktreeId: z.string().optional(),
        location: z.enum(["grid", "dock", "trash", "background"]).optional(),
      })
      .optional(),
    resultSchema: z.object({ terminals: z.array(TerminalSummarySchema) }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { worktreeId, location } = (args ?? {}) as {
        worktreeId?: string;
        location?: "grid" | "dock" | "trash" | "background";
      };
      const state = usePanelStore.getState();
      // Ephemeral panels (e.g. the Daintree Assistant's own dock terminal)
      // are tooling-internal and must not appear in the MCP-visible list,
      // or the assistant ends up enumerating itself and acting on its own
      // process during bulk operations.
      let terminals = state.panelIds
        .map((id) => state.panelsById[id])
        .filter((t): t is PanelInstance => t !== undefined && !isEphemeralPanel(t));

      // Filter by worktree if specified
      if (worktreeId) {
        terminals = terminals.filter((t) => t.worktreeId === worktreeId);
      }

      // Filter by location if specified
      if (location) {
        terminals = terminals.filter((t) => t.location === location);
      } else {
        // By default, exclude trashed and backgrounded terminals
        terminals = terminals.filter((t) => t.location !== "trash" && t.location !== "background");
      }

      // Return essential metadata only (avoid returning full PTY buffers)
      const result = terminals.map((t) => ({
        id: t.id,
        kind: t.kind,
        type: undefined,
        worktreeId: t.worktreeId ?? null,
        title: t.title ?? null,
        location: t.location ?? "grid",
        agentId: isPtyPanel(t) ? (t.detectedAgentId ?? t.launchAgentId ?? null) : null,
        agentState: isPtyPanel(t) ? (t.agentState ?? null) : null,
        isInputLocked: isPtyPanel(t) ? (t.isInputLocked ?? false) : false,
        isFocused: t.id === state.focusedId,
      }));

      return { terminals: result };
    },
  }));

  actions.set("terminal.getOutput", () => ({
    id: "terminal.getOutput",
    title: "Get Terminal Output",
    description:
      "Read the trailing scrollback of one terminal, for inspecting what an agent or command actually printed. Use the terminal status snapshot instead when watching several terminals — it fetches output tails for a whole fleet in one call, and reading them one at a time is the common mistake here. Output is returned verbatim and may be truncated to the requested tail; a terminal that no longer exists comes back as an error field in the result rather than failing the call.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe(
          "Identifies the terminal to act on, using a panel id from the terminal-listing capability. An id no longer tracked resolves as idle rather than failing."
        ),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Maximum lines to return (default: 100, max: 1000)"),
      stripAnsi: z
        .boolean()
        .default(true)
        .describe("Remove ANSI escape codes from output (default: true)"),
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
      truncated: z.boolean(),
      error: z.string().optional(),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const {
        terminalId,
        maxLines = 100,
        stripAnsi = true,
      } = args as {
        terminalId: string;
        maxLines?: number;
        stripAnsi?: boolean;
      };

      // Validate maxLines bounds
      const effectiveMaxLines = Math.min(Math.max(maxLines, 1), 1000);

      // Get serialized terminal state via existing IPC method
      const serializedState = await window.electron.terminal.getSerializedState(terminalId);

      if (serializedState === null) {
        return {
          terminalId,
          content: null,
          lineCount: 0,
          truncated: false,
          error: "Terminal not found or has no output",
        };
      }

      // Collapse blank padding BEFORE tailing so the last N lines are real
      // content, not the blank region bottom-padding TUIs (e.g. Codex) leave
      // below their composer (#10763). truncated/lineCount track normalized
      // content, so trailing padding never reads as "output omitted".
      const { content, lineCount, truncated } = tailCapturedOutput(
        serializedState.data,
        effectiveMaxLines,
        stripAnsi
      );

      return {
        terminalId,
        content,
        lineCount,
        truncated,
      };
    },
  }));

  actions.set("terminal.getStatus", () => ({
    id: "terminal.getStatus",
    title: "Get Terminal Status",
    description:
      "Take a point-in-time snapshot of agent and process state across many terminals at once, optionally with recent output tails. This is the batched polling path: prefer it over listing terminals for agent state or reading each terminal's output in turn. It never blocks and never fails as a whole — a terminal that cannot be read carries its own error while the rest stay valid — so use the blocking wait instead when the goal is to proceed the moment an agent finishes.",
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
            "Explicit terminal IDs to query (1-256). When set, `worktreeId`/`location` filters are ignored. Unknown IDs return per-entry `error` rather than aborting the call."
          ),
        worktreeId: z
          .string()
          .optional()
          .describe("Filter by worktree (ignored when `terminalIds` is provided)."),
        location: z
          .enum(["grid", "dock", "trash", "background"])
          .optional()
          .describe(
            "Filter by panel location (ignored when `terminalIds` is provided). Defaults to all locations except trash and background."
          ),
        includeOutput: z
          .object({
            lines: z
              .number()
              .int()
              .min(1)
              .max(50)
              .default(20)
              .describe(
                "Number of trailing scrollback lines to include per terminal (max 50, default 20)."
              ),
            stripAnsi: z
              .boolean()
              .default(true)
              .describe("Remove ANSI escape codes from `recentOutput` (default: true)."),
          })
          .optional()
          .describe(
            "Opt-in. When set, each entry includes `recentOutput` with the last N lines of scrollback. Off by default to keep responses small."
          ),
      })
      .optional(),
    resultSchema: z.object({ terminals: z.array(TerminalStatusEntrySchema) }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { terminalIds, worktreeId, location, includeOutput } = (args ?? {}) as {
        terminalIds?: string[];
        worktreeId?: string;
        location?: "grid" | "dock" | "trash" | "background";
        includeOutput?: { lines?: number; stripAnsi?: boolean };
      };

      const state = usePanelStore.getState();
      const panelsById = state.panelsById;
      // Fresh point-in-time snapshot of the fleet arming set for this call.
      const armedIds = useFleetArmingStore.getState().armedIds;

      type StatusEntry = {
        terminalId: string;
        agentId: string | null;
        agentState: AgentState | null;
        waitingReason?: WaitingReason;
        lastTransitionAt?: number;
        exitCode?: number | null;
        spawnedAt?: number;
        lastCheckResult?: TerminalCheckResult;
        recentOutput?: string | null;
        armed?: boolean;
        error?: string;
      };

      const resolved: Array<{ id: string; terminal: PanelInstance | undefined }> = [];

      // An explicitly passed `terminalIds` (even empty) selects the targeted
      // path — never silently fall back to the fleet path, which would surprise
      // a caller asking for a specific subset.
      if (terminalIds !== undefined) {
        for (const id of terminalIds) {
          const t = getNarrowPanel(panelsById, id);
          // Treat tooling-internal panels as not found — they must never expose
          // state to MCP callers (mirrors terminal.list).
          if (!t || isEphemeralPanel(t)) {
            resolved.push({ id, terminal: undefined });
          } else {
            resolved.push({ id, terminal: t });
          }
        }
      } else {
        let terminals = state.panelIds
          .map((id) => panelsById[id])
          .filter((t): t is PanelInstance => t !== undefined && !isEphemeralPanel(t));

        if (worktreeId) {
          terminals = terminals.filter((t) => t.worktreeId === worktreeId);
        }
        if (location) {
          terminals = terminals.filter((t) => t.location === location);
        } else {
          terminals = terminals.filter(
            (t) => t.location !== "trash" && t.location !== "background"
          );
        }

        for (const t of terminals) {
          resolved.push({ id: t.id, terminal: t });
        }
      }

      // Optional output fetch — single batched IPC for all terminals at once.
      const linesArg = includeOutput?.lines;
      const effectiveLines =
        typeof linesArg === "number" ? Math.min(Math.max(Math.floor(linesArg), 1), 50) : 20;
      const stripAnsi = includeOutput?.stripAnsi ?? true;

      let outputs: Record<string, SerializedTerminalSnapshot | null> | null = null;
      let outputError: string | undefined;
      if (includeOutput) {
        const idsToFetch = resolved.filter((r) => r.terminal !== undefined).map((r) => r.id);
        if (idsToFetch.length > 0) {
          try {
            outputs = await window.electron.terminal.getSerializedStates(idsToFetch);
          } catch (err) {
            outputError = formatErrorMessage(err, "Failed to fetch terminal output");
          }
        } else {
          outputs = {};
        }
      }

      const entries: StatusEntry[] = resolved.map(({ id, terminal }) => {
        if (!terminal) {
          return {
            terminalId: id,
            agentId: null,
            agentState: null,
            error: "Terminal not found",
          };
        }

        const entry: StatusEntry = {
          terminalId: terminal.id,
          agentId: isPtyPanel(terminal)
            ? (terminal.detectedAgentId ?? terminal.launchAgentId ?? null)
            : null,
          agentState: isPtyPanel(terminal) ? (terminal.agentState ?? null) : null,
          lastTransitionAt: isPtyPanel(terminal) ? terminal.lastStateChange : undefined,
          // exitCode is set on the panel once the PTY exits (undefined while
          // running); spawnedAt comes from the panel's creation timestamp.
          exitCode: isPtyPanel(terminal) ? (terminal.exitCode ?? null) : undefined,
          spawnedAt: isPtyPanel(terminal) ? terminal.startedAt : undefined,
          // Parsed test/lint/check result (issue #10682). Best-effort, not
          // authoritative — see TerminalCheckResult / the schema doc above.
          lastCheckResult: isPtyPanel(terminal) ? terminal.lastCheckResult : undefined,
          // Whether this terminal is in the fleet arming/broadcast set (#10695).
          armed: armedIds.has(terminal.id),
        };

        if (
          isPtyPanel(terminal) &&
          terminal.agentState === "waiting" &&
          terminal.waitingReason !== undefined
        ) {
          entry.waitingReason = terminal.waitingReason;
        }

        if (includeOutput) {
          if (outputError !== undefined) {
            // The IPC failed for the whole batch (transport-level failure),
            // so every successfully-resolved entry gets the same error.
            // Status fields are kept intact so the caller still has something
            // useful to act on — recentOutput is the only thing we lost.
            entry.error = outputError;
            entry.recentOutput = null;
          } else if (outputs !== null) {
            const serialized = outputs[terminal.id] ?? null;
            if (serialized === null) {
              entry.recentOutput = null;
            } else {
              // Normalize before tailing (#10763) — see terminal.getOutput.
              // Without this, a bottom-padding TUI's blank rows fill the small
              // last-N window and recentOutput reads as empty even when idle.
              entry.recentOutput = tailCapturedOutput(
                serialized.data,
                effectiveLines,
                stripAnsi
              ).content;
            }
          }
        }

        return entry;
      });

      return { terminals: entries };
    },
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
      terminalId: z
        .string()
        .min(1)
        .describe(
          "Identifies the terminal to act on, using a panel id from the terminal-listing capability. An id no longer tracked resolves as idle rather than failing."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS)
        .optional()
        .describe(
          "Pass 0 for an immediate non-blocking snapshot — the recommended mode. Otherwise, the maximum time to long-poll in milliseconds; defaults to 60s. Interactive sessions are capped at 60s server-side; headless sessions may block up to 2 hours."
        ),
    }),
    rawOutputSchema: WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
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
          "Identifies the terminals to watch, using panel ids from the terminal-listing capability. Ids no longer tracked count as already finished rather than failing the batch."
        ),
      mode: z
        .enum(["first", "all"])
        .optional()
        .describe(
          "Whether to return as soon as any one terminal stops working (the default, for dispatching follow-up work as each agent frees up) or only once every terminal has stopped (a join barrier)."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS)
        .optional()
        .describe(
          "Pass 0 for an immediate non-blocking snapshot. Otherwise the maximum time to long-poll in milliseconds; defaults to 60s. Interactive sessions are capped at 60s server-side; headless sessions may block up to 2 hours."
        ),
    }),
    rawOutputSchema: WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
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

  actions.set("terminal.sendCommand", () => ({
    id: "terminal.sendCommand",
    title: "Submit text to terminal",
    description:
      "Submit text to a terminal: a shell terminal runs it as a command, an agent pane receives it as the next prompt. Multi-line text is safe — the whole body is delivered atomically and submitted once, so embedded newlines insert line breaks instead of firing off a partial message. This returns as soon as the text is sent and does not wait for a result, so poll the status snapshot or block on the idle wait to see what happened. Anything submitted here runs with the terminal's own privileges.",
    category: "terminal",
    kind: "command",
    danger: "safe",
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
        .describe(
          "Identifies the terminal to submit to, using a panel id from the terminal-listing capability."
        ),
      command: z
        .string()
        .min(1)
        .describe(
          "Text to submit. Runs as a shell command in a plain terminal, or is submitted as the next prompt/turn in an agent pane. Multi-line is delivered atomically and submitted with a single Enter, so interior newlines never prematurely submit."
        ),
    }),
    run: async (args: unknown) => {
      const { terminalId, command } = args as { terminalId: string; command: string };

      // Verify terminal exists and is valid for command execution
      const terminal = usePanelStore.getState().panelsById[terminalId];

      if (!terminal) {
        throw new Error("Terminal not found");
      }

      // Check if terminal is trashed
      if (terminal.location === "trash") {
        throw new Error("Cannot send commands to trashed terminals");
      }

      // Check if terminal kind supports PTY (must have a shell to send commands to)
      const kind = terminal.kind ?? "terminal";
      if (!panelKindHasPty(kind)) {
        throw new Error(`Terminal kind "${kind}" does not support command execution`);
      }

      // Check if terminal has PTY capability
      if (isPtyPanel(terminal) && terminal.hasPty === false) {
        throw new Error("Terminal does not have PTY capability");
      }

      // Send command via submit (handles bracketed paste)
      await terminalClient.submit(terminalId, command);

      // Return a clear message so the AI model knows not to repeat this action
      return {
        sent: true,
        terminalId,
        command,
        message: `Command sent to terminal. Do not send this command again to the same terminal.`,
      };
    },
  }));
}
