import type { z } from "zod";
import { isFullAgentDirectory, type AgentDirectory } from "../../../shared/types/agentDirectory.js";
import { TerminalStatusResultSchema } from "../../../shared/types/terminalStatusSchemas.js";
import { redactSecrets } from "../../services/redactSecrets.js";
import type {
  McpCallAnswer,
  ProjectStatusAnswer,
  ProjectStatusFailure,
  RelayRefusal,
  StatusOutput,
  StatusProject,
} from "./linkMethods.js";

export const STATUS_READ_TOOL = "terminal.getStatus";

type StatusResult = z.infer<typeof TerminalStatusResultSchema>;
type StatusEntry = StatusResult["terminals"][number];

/** A read that gave nothing for a reason the reader knows, never one it guessed. */
export interface ProjectStatusFailed {
  status: "failed";
  reason: ProjectStatusFailure;
}

/** A read the project's machine refused before anything ran. */
export interface ProjectStatusRefused {
  status: "refused";
  reason: RelayRefusal;
}

export interface ProjectStatusReadDeps {
  /**
   * `terminal.getStatus` in one project, in a session bound to it and admitted
   * as `host.call` would be there. A throw is a read that failed.
   */
  getStatus(
    projectId: string,
    args: Record<string, unknown>,
    runMs: number
  ): Promise<McpCallAnswer | ProjectStatusFailed>;
  /**
   * The agents the machine's own directory lists in one project, or why they
   * couldn't be read; absent, none can be listed. A throw is a list that failed.
   */
  readAgents?(
    projectId: string,
    runMs: number
  ): Promise<AgentDirectory | ProjectStatusFailed | ProjectStatusRefused>;
  /**
   * Whether the machine has the project, asked before its agents are listed,
   * so one it doesn't have never reads as one with none; absent, the status
   * read's own admission is the only check.
   */
  hasProject?(projectId: string): Promise<boolean>;
  now?: () => number;
}

function failed(projectId: string, reason: ProjectStatusFailure): ProjectStatusAnswer {
  return { status: "failed", projectId, reason };
}

/** Settles with `work`, or with `fallback` once `ms` pass; the timer never outlives it. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The live runs the directory names in this project, workers and its assistants, each once. */
function agentTerminalIds(directory: AgentDirectory, projectId: string): string[] {
  const ids = new Set<string>();
  for (const entry of directory.entries) {
    if (entry.state !== "live") continue;
    const { scope, terminalId } = entry.subject;
    if (scope.kind === "project" && scope.projectId === projectId) ids.add(terminalId);
  }
  return [...ids];
}

/**
 * One entry with its words run through `redactSecrets` (#16191): the tail, the
 * input box's text (#16189), the handback's message, the parsed check's and an
 * error, which a view's answer can fill from what failed. Everything else is a
 * state, a time or an id.
 */
export function redactStatusEntry<T extends StatusEntry>(entry: T): T {
  const redacted: T = { ...entry };
  if (typeof entry.error === "string") redacted.error = redactSecrets(entry.error);
  if (entry.inputLine) {
    redacted.inputLine = { ...entry.inputLine, text: redactSecrets(entry.inputLine.text) };
  }
  if (typeof entry.recentOutput === "string") {
    redacted.recentOutput = redactSecrets(entry.recentOutput);
  }
  if (entry.lastHandback && typeof entry.lastHandback.message === "string") {
    redacted.lastHandback = {
      ...entry.lastHandback,
      message: redactSecrets(entry.lastHandback.message),
    };
  }
  if (entry.lastCheckResult) {
    const { command, failureSummary } = entry.lastCheckResult;
    redacted.lastCheckResult = {
      ...entry.lastCheckResult,
      command: command === null ? null : redactSecrets(command),
      failureSummary: failureSummary === null ? null : redactSecrets(failureSummary),
    };
  }
  return redacted;
}

function redactStatus(result: StatusResult): StatusResult {
  return { ...result, terminals: result.terminals.map(redactStatusEntry) };
}

async function readProject(
  deps: ProjectStatusReadDeps,
  project: StatusProject,
  includeOutput: StatusOutput | null,
  deadline: number
): Promise<ProjectStatusAnswer> {
  const now = deps.now ?? Date.now;
  const { projectId } = project;
  let terminalIds = project.terminalIds;
  let complete = true;
  let omitted = 0;
  if (terminalIds === undefined) {
    const has = deps.hasProject;
    const known = has
      ? await Promise.resolve()
          .then(() => has(projectId))
          .catch(() => null)
      : true;
    if (known === null) return failed(projectId, "agents-unread");
    if (!known) return { status: "refused", projectId, reason: "no-project" };
    const read = deps.readAgents;
    if (!read) return failed(projectId, "agents-unsupported");
    const listed = await Promise.resolve()
      .then(() => read(projectId, deadline - now()))
      .catch(() => null);
    if (listed !== null && "status" in listed) {
      return listed.status === "refused"
        ? { status: "refused", projectId, reason: listed.reason }
        : failed(projectId, listed.reason);
    }
    const directory = listed;
    if (directory === null || directory.coverage === "unreachable") {
      return failed(projectId, "agents-unread");
    }
    if (directory.coverage === "unsupported") return failed(projectId, "agents-unsupported");
    // Only a whole, current directory says these are all of them.
    complete = isFullAgentDirectory(directory);
    omitted = directory.omitted;
    terminalIds = agentTerminalIds(directory, projectId);
    if (terminalIds.length === 0) {
      return { status: "done", projectId, result: null, complete, omitted };
    }
  }
  const args: Record<string, unknown> = {
    terminalIds,
    ...(includeOutput ? { includeOutput } : {}),
  };
  const answer = await Promise.resolve()
    .then(() => deps.getStatus(projectId, args, deadline - now()))
    .catch((): ProjectStatusFailed => ({ status: "failed", reason: "unreadable" }));
  switch (answer.status) {
    case "failed":
      return failed(projectId, answer.reason);
    case "refused":
      return { status: "refused", projectId, reason: answer.reason };
    case "unknown":
    case "conflict":
      return failed(projectId, "unreadable");
    case "done": {
      // An error, or a status cut to text to fit, is nothing to show as one.
      if (answer.result.isError) return failed(projectId, "tool-error");
      const parsed = TerminalStatusResultSchema.safeParse(answer.result.structured);
      if (!parsed.success) return failed(projectId, "unreadable");
      return {
        status: "done",
        projectId,
        result: redactStatus(parsed.data),
        complete,
        omitted,
      };
    }
  }
}

/**
 * `terminal.getStatus` in each of `projects`, all at once (#16191), as each
 * project answers it for the caller through its own gates. What a screen
 * showed is redacted here, on the machine that read it. A project that hasn't
 * answered within `runMs` is answered as timed out; its read is left to end
 * on its own, and nothing it brings back afterwards is kept.
 */
export async function readProjectStatuses(
  deps: ProjectStatusReadDeps,
  projects: readonly StatusProject[],
  includeOutput: StatusOutput | null,
  runMs: number
): Promise<ProjectStatusAnswer[]> {
  const now = deps.now ?? Date.now;
  const deadline = now() + runMs;
  return Promise.all(
    projects.map((project) =>
      within(
        readProject(deps, project, includeOutput, deadline).catch(() =>
          failed(project.projectId, "unreadable")
        ),
        runMs,
        failed(project.projectId, "timeout")
      )
    )
  );
}
