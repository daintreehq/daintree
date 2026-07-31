import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { projectCheckService } from "../ProjectCheckService.js";
import {
  PROJECT_CHECK_MAX_OUTPUT_BYTES,
  PROJECT_CHECK_MAX_TIMEOUT_MS,
  PROJECT_CHECK_MIN_TIMEOUT_MS,
  type ProjectCheckRunResult,
} from "../../../shared/types/projectCheck.js";
import { truncateText } from "./shared.js";

/**
 * Main-process execution for the built-in `project.runCheck` MCP tool (#11548).
 * The manifest entry (schema, tier, audit metadata) is registered in the
 * renderer as an ordinary action, but execution is short-circuited here —
 * mirrors `skills.ts` and `waitUntilIdle.ts`. Two reasons it cannot round-trip
 * to a renderer: `MCP_DISPATCH_TIMEOUT_MS` caps renderer dispatch at 30s, well
 * under a real test suite, and the MCP `AbortSignal` does not cross IPC, so a
 * renderer-hosted run could never be cancelled.
 *
 * Raw arguments are validated here rather than trusted from the action's zod
 * schema: on this path nothing else parses them, since `ActionService` is never
 * involved.
 */

function asArgsObject(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) {
    throw new McpError(ErrorCode.InvalidParams, "project.runCheck requires an object argument.");
  }
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new McpError(ErrorCode.InvalidParams, "project.runCheck arguments must be an object.");
  }
  return rawArgs as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `project.runCheck requires a non-empty \`${key}\` string.`
    );
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `project.runCheck \`${key}\` must be a non-empty string when provided.`
    );
  }
  return value.trim();
}

function optionalTimeout(args: Record<string, unknown>): number | undefined {
  const value = args["timeoutMs"];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < PROJECT_CHECK_MIN_TIMEOUT_MS ||
    value > PROJECT_CHECK_MAX_TIMEOUT_MS
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `project.runCheck \`timeoutMs\` must be a number between ${PROJECT_CHECK_MIN_TIMEOUT_MS} and ${PROJECT_CHECK_MAX_TIMEOUT_MS}.`
    );
  }
  return value;
}

export async function handleProjectRunCheck(
  rawArgs: unknown,
  signal?: AbortSignal
): Promise<ProjectCheckRunResult> {
  const args = asArgsObject(rawArgs);

  const result = await projectCheckService.runCheck(
    {
      projectId: requireString(args, "projectId"),
      runnerId: requireString(args, "runnerId"),
      cwd: optionalString(args, "cwd"),
      timeoutMs: optionalTimeout(args),
    },
    { signal }
  );

  // Built field by field rather than spread: `resultSchema` on the action is
  // manifest documentation, never runtime validation, so this projection is the
  // only thing standing between the service's internals and the wire (#10870).
  // `truncateText` is a belt-and-braces second cap — the service already tails
  // to the same limit, but nothing downstream would catch a regression there.
  return {
    projectId: result.projectId,
    cwd: result.cwd,
    runnerId: result.runnerId,
    runnerName: result.runnerName,
    passed: result.passed,
    exitCode: result.exitCode,
    signalName: result.signalName,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    output: truncateText(result.output, PROJECT_CHECK_MAX_OUTPUT_BYTES),
    outputTruncated: result.outputTruncated,
  };
}
