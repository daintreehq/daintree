import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { projectCommandService } from "../ProjectCommandService.js";
import {
  PROJECT_COMMAND_MAX_LENGTH,
  PROJECT_COMMAND_MAX_OUTPUT_BYTES,
  PROJECT_COMMAND_MAX_TIMEOUT_MS,
  PROJECT_COMMAND_MIN_TIMEOUT_MS,
  type ProjectCommandRunResult,
} from "../../../shared/types/projectCommand.js";
import { truncateTextTail } from "./shared.js";

/**
 * Main-process execution for the built-in `project.runCommand` MCP tool
 * (#13495), short-circuited here for the same reasons as `project.runCheck`:
 * renderer dispatch is capped at 30s and the MCP `AbortSignal` cannot cross
 * IPC. Who may call it is checked by the caller of this function; this only
 * validates and runs.
 *
 * Raw arguments are validated here rather than trusted from the action's zod
 * schema: on this path nothing else parses them.
 */

const TOOL = "project.runCommand";

function asArgsObject(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) {
    throw new McpError(ErrorCode.InvalidParams, `${TOOL} requires an object argument.`);
  }
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new McpError(ErrorCode.InvalidParams, `${TOOL} arguments must be an object.`);
  }
  return rawArgs as Record<string, unknown>;
}

function requireProjectId(args: Record<string, unknown>): string {
  const value = args["projectId"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${TOOL} requires a non-empty \`projectId\` string.`
    );
  }
  return value.trim();
}

/**
 * The command is passed to the shell exactly as given — never trimmed or
 * rewritten — so what was audited is what ran.
 */
function requireCommand(args: Record<string, unknown>): string {
  const value = args["command"];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${TOOL} requires a non-empty \`command\` string.`);
  }
  if (value.length > PROJECT_COMMAND_MAX_LENGTH) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${TOOL} \`command\` must be at most ${PROJECT_COMMAND_MAX_LENGTH} characters.`
    );
  }
  if (value.includes("\0")) {
    throw new McpError(ErrorCode.InvalidParams, `${TOOL} \`command\` must not contain NUL.`);
  }
  return value;
}

function optionalCwd(args: Record<string, unknown>): string | undefined {
  const value = args["cwd"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${TOOL} \`cwd\` must be a non-empty string when provided.`
    );
  }
  return value.trim();
}

function optionalTimeout(args: Record<string, unknown>): number | undefined {
  const value = args["timeoutMs"];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < PROJECT_COMMAND_MIN_TIMEOUT_MS ||
    value > PROJECT_COMMAND_MAX_TIMEOUT_MS
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${TOOL} \`timeoutMs\` must be an integer between ${PROJECT_COMMAND_MIN_TIMEOUT_MS} and ${PROJECT_COMMAND_MAX_TIMEOUT_MS}.`
    );
  }
  return value;
}

export async function handleProjectRunCommand(
  rawArgs: unknown,
  signal?: AbortSignal,
  authorize?: () => void
): Promise<ProjectCommandRunResult> {
  const args = asArgsObject(rawArgs);

  const result = await projectCommandService.run(
    {
      projectId: requireProjectId(args),
      command: requireCommand(args),
      cwd: optionalCwd(args),
      timeoutMs: optionalTimeout(args),
    },
    authorize ? { signal, authorize } : { signal }
  );

  // A second cap behind the service's own, keeping the newest end as it does.
  const cappedOutput = truncateTextTail(result.output, PROJECT_COMMAND_MAX_OUTPUT_BYTES);

  // Built field by field: `resultSchema` on the action is documentation, never
  // runtime validation, so this projection is what reaches the wire.
  return {
    projectId: result.projectId,
    cwd: result.cwd,
    exitCode: result.exitCode,
    signalName: result.signalName,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
    output: cappedOutput,
    outputTruncated: result.outputTruncated || cappedOutput !== result.output,
  };
}
