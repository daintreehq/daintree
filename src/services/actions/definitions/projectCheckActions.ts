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
        "Run one of a project's detected commands as a child process and report its exit code and output. A command that fails is reported as a failed check rather than as an error, so read the result rather than relying on the call succeeding. Detection finds every runnable script, not just checks — verify what a command actually is before running an unfamiliar one. Never use this for long-lived servers: they block until the timeout expires.",
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
        projectId: z
          .string()
          .min(1)
          .describe(
            "Identifies the project whose runner should be executed, using an id from the project-listing capability."
          ),
        runnerId: z
          .string()
          .min(1)
          .describe(
            "Identifies which detected command to run, using an id from runner detection. Detection surfaces every runnable script, not only checks, so confirm what an unfamiliar id actually runs first."
          ),
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
