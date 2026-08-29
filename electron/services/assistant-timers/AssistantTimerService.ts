import { DaemonUnavailableError, daemonCall } from "./DaemonTimerClient.js";
import type {
  AssistantTimerRow,
  AssistantTimerOutcomeRow,
} from "../../../shared/types/ipc/assistantHost.js";
import type {
  DaemonTimerCancelResult,
  ProjectTimersResult,
} from "../../../shared/types/ipc/assistantTimers.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * Answers "what is this project's assistant still going to do" when no engine is
 * running to ask.
 *
 * While a session is armed the panel asks the engine directly over its own protocol,
 * which is both cheaper and more current. This service is the OTHER case — Daintree
 * restarted, the project view was evicted, or the assistant was never opened in this
 * process — and it exists because a durable timer's whole point is to outlive the
 * session that made it. Without it the app has no answer at exactly the moment a
 * scheduled agent spawn is closest to happening.
 *
 * It never opens the engine's database. The daemon holds the project lease and is the
 * only writer; going around it would duplicate a schema across a process boundary and
 * race the writes it is making.
 */

/** Where a project's daemon listens, as the engine itself reported it. */
export interface ProjectControlEndpoint {
  socketPath: string;
  stateDir: string;
}

interface DaemonTimersReply {
  timers: DaemonTimerView[];
  outcomes: DaemonOutcome[];
  takenAtMs: number;
}

/** The daemon's own view shape (internal/timers.View), before it is normalised. */
interface DaemonTimerView {
  id: string;
  title: string;
  nextFireAt: number;
  createdAt: number;
  payloadKind: "reminder" | "tool_call" | "legacy";
  toolName?: string;
  runCount: number;
  repeat?: { everyMs: number; maxRuns?: number; untilAt?: number };
  target?: { worktreeId?: string; terminalId?: string };
  liveGrants: number;
  grantsUnknown: boolean;
}

interface DaemonOutcome {
  eventId: string;
  timerId: string;
  severity: string;
  title: string;
  summary: string;
  createdAtMs: number;
  updatedAtMs: number;
  count: number;
}

/**
 * Normalises the daemon's view onto the SAME row the host protocol serves.
 *
 * One shape reaches the renderer whichever transport answered, so the manager has no
 * idea which one it is looking at — and cannot grow two rendering paths that drift.
 */
function toRow(view: DaemonTimerView): AssistantTimerRow {
  return {
    id: view.id,
    label: view.title,
    dueAt: view.nextFireAt,
    createdAt: view.createdAt,
    payloadKind: view.payloadKind,
    toolName: view.toolName ?? "",
    runCount: view.runCount,
    // Flattened to the fixed shape the wire uses, where 0 means "not set" — the
    // daemon omits these instead, and a renderer must not have to tell the two
    // conventions apart.
    repeatEveryMs: view.repeat?.everyMs ?? 0,
    repeatMaxRuns: view.repeat?.maxRuns ?? 0,
    repeatUntilAt: view.repeat?.untilAt ?? 0,
    targetWorktreeId: view.target?.worktreeId ?? "",
    targetTerminalId: view.target?.terminalId ?? "",
    liveGrants: view.liveGrants,
    grantsUnknown: view.grantsUnknown,
  };
}

function toOutcome(row: DaemonOutcome): AssistantTimerOutcomeRow {
  return {
    eventId: row.eventId,
    timerId: row.timerId,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    createdAt: row.createdAtMs,
    updatedAt: row.updatedAtMs,
    count: row.count,
  };
}

export class AssistantTimerService {
  /**
   * Where each project's daemon listens, learned from `host:ready`.
   *
   * LEARNED, never derived. Working the path out means reimplementing two hashes —
   * project id to a slug-plus-SHA-256 state dir, then the absolute state dir to a
   * short socket name — and a second implementation of a path that has to agree
   * exactly would fail silently the day it drifted, because a socket that is not
   * there is indistinguishable from a daemon that is not running.
   *
   * In memory, so it survives a panel closing but not an app restart. That is the
   * honest limit of this phase and it is stated rather than hidden: a project the
   * user has not opened the assistant for since launch has no endpoint here, and the
   * caller renders that as "not available" rather than as "no timers".
   */
  private readonly endpoints = new Map<string, ProjectControlEndpoint>();

  /** Records where a project's daemon listens, from an engine that just booted. */
  rememberEndpoint(projectId: string, endpoint: Partial<ProjectControlEndpoint>): void {
    if (!projectId || !endpoint.socketPath) return;
    this.endpoints.set(projectId, {
      socketPath: endpoint.socketPath,
      stateDir: endpoint.stateDir ?? "",
    });
  }

  endpointFor(projectId: string): ProjectControlEndpoint | undefined {
    return this.endpoints.get(projectId);
  }

  /**
   * Reads a project's timers over its daemon socket.
   *
   * Never throws for the ordinary cases. No endpoint, no daemon, or a daemon that has
   * yielded the lease to an attached session are all answers rather than faults, and
   * each of them has to be distinguishable from "nothing is scheduled".
   */
  async list(projectId: string): Promise<ProjectTimersResult> {
    const empty = { timers: [], outcomes: [], takenAt: 0 };
    const endpoint = this.endpoints.get(projectId);
    if (!endpoint) {
      return {
        ...empty,
        available: false,
        reason: "Daintree has not seen this project's assistant since it started.",
      };
    }
    try {
      const reply = await daemonCall<DaemonTimersReply>(endpoint.socketPath, "timers");
      return {
        available: true,
        timers: (reply.timers ?? []).map(toRow),
        outcomes: (reply.outcomes ?? []).map(toOutcome),
        takenAt: reply.takenAtMs,
      };
    } catch (error) {
      return {
        ...empty,
        available: false,
        // A transport failure is reported in the user's terms, not the socket's:
        // ENOENT on a path they have never heard of is not an explanation. Anything
        // else is the daemon's OWN words — most often "not holding the project",
        // which is the caller's cue to route to the attached session instead.
        reason:
          error instanceof DaemonUnavailableError
            ? "No background supervisor is running for this project."
            : formatErrorMessage(error, "The background supervisor refused the request."),
      };
    }
  }

  /**
   * Retires one timer over the daemon socket.
   *
   * The CALLER confirms first — this is a D1 mutation and the socket carries no
   * confirmation channel. Unlike {@link list} this DOES throw, because a cancel that
   * did not happen must never settle as though it had.
   */
  async cancel(projectId: string, timerId: string): Promise<DaemonTimerCancelResult> {
    const endpoint = this.endpoints.get(projectId);
    if (!endpoint) {
      throw new DaemonUnavailableError(
        "Daintree has not seen this project's assistant since it started, so it cannot reach its timers."
      );
    }
    return daemonCall<DaemonTimerCancelResult>(endpoint.socketPath, "timer_cancel", { timerId });
  }
}
