import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { TerminalSummarySchema, TerminalStatusEntrySchema } from "./schemas";
import { stripAnsiCodes } from "@shared/utils/artifactParser";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
} from "@shared/types/terminalWaitUntilIdle";
export function registerTerminalQueryActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.list", () => ({
    id: "terminal.list",
    title: "List Terminals",
    description:
      "List terminals/panels with lightweight metadata. Args (all optional): `worktreeId` filters to one worktree; `location` filters by 'grid'|'dock'|'trash'|'background' (default excludes trash and background). Returns { terminals } — each with id, kind, worktreeId, title, location, agentId, agentState, isInputLocked, isFocused. Ephemeral/internal panels are excluded. Never errors. Do NOT use this to poll agent state across a fleet or read output — use `terminal.getStatus`.",
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
        .filter(
          (t): t is PanelInstance =>
            t !== undefined && (!isPtyPanel(t) || t.excludeFromPersistence !== true)
        );

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
      "Read the trailing scrollback of a single terminal. Args: `terminalId` (required) — panel UUID from `terminal.list` (the `id` field); `maxLines` (1-1000, default 100); `stripAnsi` (default true). Returns { terminalId, content, lineCount, truncated }, or { ..., error } as data when the terminal is not found (not a thrown error). Do NOT use this to poll many terminals — `terminal.getStatus` with `includeOutput` fetches tails for N terminals in one call.",
    category: "terminal",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      terminalId: z
        .string()
        .min(1)
        .describe("Panel UUID returned by `terminal.list` (the `id` field)."),
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

      // Split into lines and extract last N
      const allLines = serializedState.split("\n");
      const totalLines = allLines.length;
      const truncated = totalLines > effectiveMaxLines;
      const selectedLines = allLines.slice(-effectiveMaxLines);

      // Optionally strip ANSI codes
      let content = selectedLines.join("\n");
      if (stripAnsi) {
        content = stripAnsiCodes(content);
      }

      return {
        terminalId,
        content,
        lineCount: selectedLines.length,
        truncated,
      };
    },
  }));

  actions.set("terminal.getStatus", () => ({
    id: "terminal.getStatus",
    title: "Get Terminal Status",
    description:
      "Poll agent/terminal state across many terminals in one call. Args (all optional): `terminalIds` (1-256 explicit ids from `terminal.list`; when set, worktreeId/location are ignored and unknown ids return a per-entry `error`); `worktreeId`/`location` filters; `includeOutput:{ lines, stripAnsi }` to also return recent scrollback tails. Returns { terminals } — each with terminalId, agentId, agentState, waitingReason, lastTransitionAt, exitCode (number|null — set once the PTY has exited, null while running; read with agentState to tell a clean finish from a failure), spawnedAt, optional recentOutput, optional per-entry error. Never throws. Do NOT use `terminal.getOutput` for fleet polling, or `terminal.list` for agent state — this is the batched path.",
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

      type StatusEntry = {
        terminalId: string;
        agentId: string | null;
        agentState: AgentState | null;
        waitingReason?: WaitingReason;
        lastTransitionAt?: number;
        exitCode?: number | null;
        spawnedAt?: number;
        recentOutput?: string | null;
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
          if (!t || (isPtyPanel(t) && t.excludeFromPersistence === true)) {
            resolved.push({ id, terminal: undefined });
          } else {
            resolved.push({ id, terminal: t });
          }
        }
      } else {
        let terminals = state.panelIds
          .map((id) => panelsById[id])
          .filter(
            (t): t is PanelInstance =>
              t !== undefined && (!isPtyPanel(t) || t.excludeFromPersistence !== true)
          );

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

      let outputs: Record<string, string | null> | null = null;
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
              const lines = serialized.split("\n").slice(-effectiveLines);
              let content = lines.join("\n");
              if (stripAnsi) content = stripAnsiCodes(content);
              entry.recentOutput = content;
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
        .describe("Panel UUID returned by `terminal.list` (the `id` field)."),
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

  actions.set("terminal.sendCommand", () => ({
    id: "terminal.sendCommand",
    title: "Send Command to Terminal",
    description: "Send a shell command to a terminal for execution",
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
      terminalId: z.string().min(1).describe("Terminal instance ID from terminal.list"),
      command: z.string().min(1).describe("The command to execute"),
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
