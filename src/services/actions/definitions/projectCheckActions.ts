import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import {
  PROJECT_CHECK_DEFAULT_TIMEOUT_MS,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
} from "@shared/types/projectCheck";

/**
 * Built-in `project.runCheck` action (#11548). Registered here purely for
 * manifest registration — schema, description, tier, and audit metadata.
 * Execution is short-circuited in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts) and runs in the main process,
 * because a check needs a real child process, an exit code, and a cancellable
 * wait longer than the 30s renderer-dispatch wall. `run()` throws if the
 * renderer ever invokes it directly. Same pattern as `skills.search`.
 */
export function registerProjectCheckActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("project.runCheck", () =>
    defineAction({
      id: "project.runCheck",
      title: "Run Project Check",
      description:
        "Run one of a project's detected runners (test, lint, build) as a real child process and return its authoritative exit code. Prefer this over reading a terminal: `terminal.getStatus` only parses scrollback, while this reports the real exit code. Args: `projectId` (from `project.getAll`), `runnerId` (an `id` from `project.detectRunners`), `cwd` (optional — the project root or one of its worktrees; defaults to the project root), `timeoutMs` (optional, default 10min, max 1h). Returns { projectId, cwd, runnerId, runnerName, passed, exitCode, signalName, durationMs, timedOut, aborted, output, outputTruncated }; `output` is the scrubbed tail of stdout+stderr. A failing check is a normal result with `passed: false` — it does NOT error. Errors only when nothing could run: unknown project or runner, a `cwd` outside the project, or a check already running there. Do NOT use for long-lived runners such as a dev server; those hold the call open until the timeout.",
      category: "project",
      kind: "command",
      danger: "safe",
      // Runs project-defined shell commands outside any visible PTY. That is
      // exactly the execution a plugin must declare a capability for rather
      // than reach through an ungated `safe` built-in — same reasoning as
      // `terminal.sendCommand` (#10558).
      denyPluginDispatch: true,
      scope: "renderer",
      argsSchema: z.object({
        projectId: z.string().min(1).describe("Project ID from `project.getAll`."),
        runnerId: z
          .string()
          .min(1)
          .describe("Runner `id` from `project.detectRunners`, e.g. `npm:test`."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Directory to run in. Must be the project root or one of its worktrees. Defaults to the project root."
          ),
        timeoutMs: z
          .number()
          .int()
          .min(PROJECT_CHECK_MIN_TIMEOUT_MS)
          .max(PROJECT_CHECK_MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Wall-clock ceiling in milliseconds (default ${PROJECT_CHECK_DEFAULT_TIMEOUT_MS}, max ${PROJECT_CHECK_MAX_TIMEOUT_MS}). The process tree is killed when it elapses.`
          ),
      }),
      resultSchema: z.object({
        projectId: z.string(),
        cwd: z.string(),
        runnerId: z.string(),
        runnerName: z.string(),
        passed: z.boolean(),
        exitCode: z.number().nullable(),
        signalName: z.string().nullable(),
        durationMs: z.number(),
        timedOut: z.boolean(),
        aborted: z.boolean(),
        output: z.string(),
        outputTruncated: z.boolean(),
      }),
      mcpOutputSchema: true,
      mcpAnnotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
      },
      run: async () => {
        throw new Error(
          "project.runCheck must be invoked through the MCP main-process path, not renderer dispatch."
        );
      },
    })
  );
}
