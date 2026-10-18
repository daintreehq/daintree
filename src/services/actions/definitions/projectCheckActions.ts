import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import {
  PROJECT_CHECK_DEFAULT_TIMEOUT_MS,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
} from "@shared/types/projectCheck";
import {
  PROJECT_COMMAND_DEFAULT_TIMEOUT_MS,
  PROJECT_COMMAND_MAX_LENGTH,
  PROJECT_COMMAND_MAX_TIMEOUT_MS,
  PROJECT_COMMAND_MIN_TIMEOUT_MS,
} from "@shared/types/projectCommand";

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

  // Manifest-only, like `project.runCheck`, and executed in main (#13495). It
  // is the shell a hub assistant lacks on a host it reaches over a relay, so
  // main answers it only for Daintree's own full-tier assistants, whatever
  // tier or grant another caller holds. `safe` rather than `confirm` because
  // the same callers already reach a shell through `terminal.new` and
  // `terminal.sendCommand`; a dialog per `git status` would only make the
  // verify step unusable, not the capability any narrower.
  actions.set("project.runCommand", () =>
    defineAction({
      id: "project.runCommand",
      title: "Run command",
      description:
        "Run one non-interactive shell command on this host and return its exit code, output and timing. cwd is where it starts, not a sandbox: it runs as the host's user. A non-zero exit is a result, not an error. Never for servers or prompts.",
      category: "project",
      kind: "command",
      danger: "safe",
      denyPluginDispatch: true,
      scope: "renderer",
      palette: { mode: "hidden" },
      argsSchema: z.object({
        projectId: z.string().min(1).describe("Project id from the project listing."),
        command: z
          .string()
          .min(1)
          .max(PROJECT_COMMAND_MAX_LENGTH)
          .describe("Shell command line, run as given, with no stdin or TTY."),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe("Project root or one of its worktrees (default: root)."),
        timeoutMs: z
          .number()
          .int()
          .min(PROJECT_COMMAND_MIN_TIMEOUT_MS)
          .max(PROJECT_COMMAND_MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Ms before the process tree is killed (default ${PROJECT_COMMAND_DEFAULT_TIMEOUT_MS}).`
          ),
      }),
      resultSchema: z.object({
        projectId: z.string(),
        cwd: z.string(),
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
        destructiveHint: true,
      },
      run: async () => {
        throw new Error(
          "project.runCommand must be invoked through the MCP main-process path, not renderer dispatch."
        );
      },
    })
  );
}
