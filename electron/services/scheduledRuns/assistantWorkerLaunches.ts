// Import-free on purpose: the MCP server, host control and the run history
// share it, and it must tie none of them to another in the main bundle.

/**
 * The tools whose answer names an agent it launched, in a `terminalId`. A
 * shell, a recipe's terminals or a worktree are no worker.
 */
const WORKER_LAUNCH_TOOLS = new Set(["agent.launch", "workflow.startWorkOnIssue"]);

/** What an assistant's call was answered with, on this machine or a host. */
export interface AssistantToolAnswer {
  readonly helpSessionId: string;
  readonly tool: string;
  readonly args: unknown;
  /** The tool's result as answered; nothing is read from anything but it and the call. */
  readonly result: unknown;
  /** The host it ran on; null for this machine. */
  readonly hostId: string | null;
  readonly hostName: string | null;
  /** The project it ran in, as the call was routed. */
  readonly projectId: string | undefined;
  /** A host project's name, when its listing gave one; this machine's are read here. */
  readonly projectName?: string | null;
  /** When the call was made: a run settled before then isn't the call's. */
  readonly askedAt: number;
  /**
   * The schedule's run the session was started for, read when the call was
   * answered, for an answer recorded later; absent, it's read on recording.
   */
  readonly runId?: string;
}

/** The agent terminals an answered call says it launched, with the agent it asked for. */
export function workerLaunchesIn(
  tool: string,
  args: unknown,
  result: unknown
): { terminalIds: string[]; agentId: string | null } {
  if (!WORKER_LAUNCH_TOOLS.has(tool)) return { terminalIds: [], agentId: null };
  const answered =
    typeof result === "object" && result !== null && !Array.isArray(result) ? result : null;
  // `launched: false` comes with no terminal; the flag is read too, as the ownership ledger does.
  const terminalId =
    answered !== null && Reflect.get(answered, "launched") !== false
      ? Reflect.get(answered, "terminalId")
      : undefined;
  const terminalIds = typeof terminalId === "string" && terminalId !== "" ? [terminalId] : [];
  const asked =
    typeof args === "object" && args !== null ? Reflect.get(args, "agentId") : undefined;
  return { terminalIds, agentId: typeof asked === "string" && asked !== "" ? asked : null };
}

type ScheduledRunOfSession = (helpSessionId: string) => { readonly runId: string } | null;
let runOfSession: ScheduledRunOfSession = () => null;

/**
 * Set by the help sessions' service, so the run history can read which run
 * started a session without importing that service: an import from the run
 * history would pull the service's whole graph into the lazily initialised
 * part of the main bundle.
 */
export function setScheduledRunOfSession(lookup: ScheduledRunOfSession): void {
  runOfSession = lookup;
}

/** The schedule's run that started a help session, or null; null before any session exists. */
export function scheduledRunOfSession(helpSessionId: string): { readonly runId: string } | null {
  return runOfSession(helpSessionId);
}

type AssistantWorkerSink = (answer: AssistantToolAnswer) => void;
let sink: AssistantWorkerSink | null = null;

/**
 * Set by the run history once it's open (#16169). Until then no run can be
 * open, so there's nothing to record a worker on, and an assistant's calls
 * cost nothing more than this check.
 */
export function setAssistantWorkerSink(next: AssistantWorkerSink | null): void {
  sink = next;
}

/**
 * An assistant's call was answered. A worker it names is recorded on the
 * schedule's run that started that assistant, while the run is open; any
 * other call, or any other assistant's, records nothing.
 */
export function noteAssistantToolAnswer(answer: AssistantToolAnswer): void {
  if (sink === null || !WORKER_LAUNCH_TOOLS.has(answer.tool)) return;
  try {
    sink(answer);
  } catch (error) {
    console.warn("[ScheduledRuns] Couldn't record an assistant's worker:", error);
  }
}
