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
      title: "Run project check",
      description:
        "Run one detected project command and report its exit code and output. A failing command is a failed check, not an error, so read the result. Detection lists every script, not just checks: verify an unfamiliar one first. Never for long-lived servers; they block until timeout.",
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
        projectId: z.string().min(1).describe("Project id from the project listing."),
        runnerId: z
          .string()
          .min(1)
          .describe("Runner id from detection; confirm what an unfamiliar id runs first."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("The project root or one of its worktrees (default: project root)."),
        timeoutMs: z
          .number()
          .int()
          .min(PROJECT_CHECK_MIN_TIMEOUT_MS)
          .max(PROJECT_CHECK_MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Wall-clock ceiling in ms (default ${PROJECT_CHECK_DEFAULT_TIMEOUT_MS}, min ${PROJECT_CHECK_MIN_TIMEOUT_MS}, max ${PROJECT_CHECK_MAX_TIMEOUT_MS}); the process tree is killed at expiry.`
          ),
      }),
      resultSchema: z.object({
        projectId: z.string(),
        cwd: z.string(),
        runnerId: z.string(),
        runnerName: z.string(),
        command: z.string(),
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
