import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import type {
  HostControlOutcomeCode,
  HostStatusArgs,
  HostStatusCoverage,
  HostStatusResult,
  HostStatusTargetResult,
  HostStatusTerminal,
} from "../../../shared/types/hostControl.js";
import {
  HOST_STATUS_DEFAULT_LINES,
  HOST_STATUS_TERMINALS_MAX,
} from "../../../shared/types/hostControl.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { boundTerminalStatusOutput } from "../../../shared/utils/terminalOutputBudget.js";
import type { HostControlLinkClient } from "./HostControlLinkClient.js";
import type {
  McpCallAnswer,
  ProjectStatusAnswer,
  ProjectStatusFailure,
  RelayRefusal,
  StatusAnswer,
  StatusOutput,
  StatusPayload,
  StatusProject,
} from "./linkMethods.js";
import {
  readProjectStatuses,
  STATUS_READ_TOOL,
  type ProjectStatusFailed,
} from "./projectStatusRead.js";

/** How long one host's read may take, all of it: the link, the reads and any fallback. */
export const HOST_STATUS_READ_MS = 5_000;
/** Least a project call relayed the old way may be given: the host refuses less. */
const RELAY_CALL_MIN_MS = 1_000;

export interface HostStatusToolDeps {
  /** The calling run's own project: this machine's other projects only, as with `host.call`. */
  callerProjectId: string;
  /** The caller is this machine's global Assistant (#14545), from its own lane. */
  global: boolean;
  /** Whether the global Assistant may read a project's status there; asked once per call. */
  mayRelay: boolean;
  tier: "core" | "full";
  /** The hosts this Shell knows, by id. */
  hostIds(): readonly HostId[];
  /** The person's "assistant control" switch for the host. */
  controlOn(hostId: HostId): boolean;
  /** This machine's own projects, read in process; absent, `local` is no host. */
  local?: { status?(payload: StatusPayload): Promise<ProjectStatusAnswer[]> };
  client():
    | (Pick<HostControlLinkClient, "relayCall"> &
        Partial<Pick<HostControlLinkClient, "status" | "agents">>)
    | null;
  /** Keeps the host's link held while it is read; the returned call lets it go. */
  holdHost?(hostId: HostId): () => void;
  newId(): string;
  now?: () => number;
}

interface TargetRead {
  outcome: HostControlOutcomeCode;
  detail: string | null;
  retryAfterMs: number | null;
  answer: Extract<ProjectStatusAnswer, { status: "done" }> | null;
}

interface HostRead {
  coverage: HostStatusCoverage;
  targets: Map<string, TargetRead>;
}

const NO_HOST_DETAIL = "This Shell has no host with that id. List the hosts it knows.";
const CONTROL_OFF_DETAIL =
  "Assistant control is turned off for this host in this Shell's host settings. Only the person can turn it on.";
const OWN_PROJECT_DETAIL =
  "That is this assistant's own project, so nothing was read there. Call terminal.getStatus directly; local reaches this machine's other projects.";
const WITHHELD_DETAIL = "This assistant can't read a project's status. Nothing was read.";
const NO_CLIENT_DETAIL = "This Shell can't reach its hosts right now. Nothing was read.";
const DISCONNECTED_DETAIL =
  "The host can't be reached right now, so nothing was read. Try again once it is back.";
const SENDER_REFUSED_DETAIL =
  "The host refused this Shell's identity on the current connection. Try again shortly.";
const RATE_LIMITED_DETAIL = "Too many calls in a short time. Retry after retryAfterMs.";
const HOST_REFUSED_DETAIL =
  "The host refuses reads for other machines' assistants: its own setting is off. Nothing was read.";
const NO_AGENTS_DETAIL = "It lists no agents.";

/** What one project's read came to, in fixed words: never anything a host said. */
const FAILURE_READS: Record<
  ProjectStatusFailure,
  { outcome: Exclude<HostControlOutcomeCode, "ok">; detail: string }
> = {
  unreadable: {
    outcome: "policy_rejected",
    detail:
      "The project answered with an error, or with nothing readable as a status, so nothing was read. host.call terminal.getStatus there shows its own words.",
  },
  "agents-unread": {
    outcome: "unsupported",
    detail:
      "Its agents couldn't be listed there, so nothing was read. Name terminalIds: host.list with includeAgents lists them.",
  },
  timeout: {
    outcome: "expired",
    detail: "It didn't answer in time, so nothing was read. Read it again.",
  },
  unreachable: { outcome: "disconnected", detail: DISCONNECTED_DETAIL },
  unsupported: {
    outcome: "unsupported",
    detail:
      "The host can't run tools for other machines' assistants; it may need a newer Daintree. Nothing was read.",
  },
};

function refusalRead(
  reason: RelayRefusal,
  local: boolean
): { outcome: Exclude<HostControlOutcomeCode, "ok">; detail: string } {
  const where = local ? "This machine" : "The host";
  switch (reason) {
    case "control-off":
      return { outcome: "policy_rejected", detail: HOST_REFUSED_DETAIL };
    case "no-project":
      return {
        outcome: "not_found",
        detail: `${where} has no project with that id. Nothing was read. The host list names its projects.`,
      };
    case "server-off":
      return {
        outcome: "unsupported",
        detail: `${where}'s Daintree MCP server is off, so nothing was read.`,
      };
  }
}

function settled(
  outcome: Exclude<HostControlOutcomeCode, "ok">,
  detail: string,
  retryAfterMs: number | null = null
): TargetRead {
  return { outcome, detail, retryAfterMs, answer: null };
}

function readOf(answer: ProjectStatusAnswer, local: boolean): TargetRead {
  switch (answer.status) {
    case "done":
      return {
        outcome: "ok",
        detail: answer.result === null && answer.complete ? NO_AGENTS_DETAIL : null,
        retryAfterMs: null,
        answer,
      };
    case "refused": {
      const { outcome, detail } = refusalRead(answer.reason, local);
      return settled(outcome, detail);
    }
    case "failed": {
      const { outcome, detail } = FAILURE_READS[answer.reason];
      return settled(outcome, detail);
    }
  }
}

function everyTarget(
  projects: readonly StatusProject[],
  read: TargetRead
): Map<string, TargetRead> {
  return new Map(projects.map(({ projectId }) => [projectId, read]));
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Settles with `work`, or with `fallback` once `ms` pass; the timer never outlives it. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const TIMED_OUT = Symbol("timed-out");

function linkFailureRead(error: unknown): TargetRead {
  switch (codeOf(error)) {
    case "PERMISSION":
      return settled("policy_rejected", SENDER_REFUSED_DETAIL);
    case "RATE_LIMITED":
      return settled("rate_limited", RATE_LIMITED_DETAIL, 1_000);
    default:
      return settled("disconnected", DISCONNECTED_DETAIL);
  }
}

/**
 * An older host, read project by project with the calls `host.call` makes
 * there (#16191), within what is left of the host's time. What comes back is
 * redacted here, since that host sends its screens as they are.
 */
function readProjectByProject(
  deps: HostStatusToolDeps,
  client: NonNullable<ReturnType<HostStatusToolDeps["client"]>>,
  hostId: HostId,
  base: Omit<StatusPayload, "runMs">,
  leftMs: number
): Promise<ProjectStatusAnswer[]> {
  const agents = client.agents;
  return readProjectStatuses(
    {
      getStatus: async (projectId, args, runMs): Promise<McpCallAnswer | ProjectStatusFailed> => {
        if (runMs < RELAY_CALL_MIN_MS) return { status: "failed", reason: "timeout" };
        try {
          return await client.relayCall(
            hostId,
            {
              helpSessionId: base.helpSessionId,
              projectId,
              tier: base.tier,
              callId: deps.newId(),
              resend: false,
              tool: STATUS_READ_TOOL,
              args,
              runMs: Math.floor(runMs),
              ...(base.global === true ? { global: true as const } : {}),
            },
            runMs
          );
        } catch (error) {
          return {
            status: "failed",
            reason: codeOf(error) === "UNSUPPORTED" ? "unsupported" : "unreachable",
          };
        }
      },
      ...(agents
        ? {
            readAgents: async (projectId, runMs) => {
              const answer = await agents.call(client, hostId, { projectId }, runMs);
              if (answer.status !== "done") throw new Error("The host didn't list its agents");
              return answer.directory;
            },
          }
        : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    base.projects,
    base.includeOutput,
    leftMs
  );
}

function coverageOf(answers: readonly ProjectStatusAnswer[]): HostStatusCoverage {
  const failures = answers.map((answer) => (answer.status === "failed" ? answer.reason : null));
  if (failures.every((reason) => reason === "unsupported")) return "unsupported";
  if (failures.every((reason) => reason === "unreachable" || reason === "timeout")) {
    return "unreachable";
  }
  return "ok";
}

async function readRemoteHost(
  deps: HostStatusToolDeps,
  hostId: HostId,
  base: Omit<StatusPayload, "runMs">
): Promise<HostRead> {
  const { projects } = base;
  const unreached = (read: TargetRead): HostRead => ({
    coverage: "unreachable",
    targets: everyTarget(projects, read),
  });
  if (!deps.hostIds().includes(hostId)) {
    return unreached(settled("not_found", NO_HOST_DETAIL));
  }
  if (!deps.controlOn(hostId)) return unreached(settled("opted_out", CONTROL_OFF_DETAIL));
  const client = deps.client();
  if (!client) return unreached(settled("disconnected", NO_CLIENT_DETAIL));
  const now = deps.now ?? Date.now;
  const deadline = now() + HOST_STATUS_READ_MS;
  const release = deps.holdHost?.(hostId) ?? (() => {});
  try {
    const status = client.status;
    let answers: ProjectStatusAnswer[] | null = null;
    let unsupported = status === undefined;
    if (status !== undefined) {
      const read = await within<{ answer: StatusAnswer } | { error: unknown } | typeof TIMED_OUT>(
        Promise.resolve()
          .then(() => status.call(client, hostId, base, HOST_STATUS_READ_MS))
          .then(
            (answer) => ({ answer }),
            (error: unknown) => ({ error })
          ),
        HOST_STATUS_READ_MS,
        TIMED_OUT
      );
      if (read === TIMED_OUT) return unreached(settled("expired", FAILURE_READS.timeout.detail));
      if ("error" in read) {
        if (codeOf(read.error) !== "UNSUPPORTED") return unreached(linkFailureRead(read.error));
        unsupported = true;
      } else if (read.answer.status === "refused") {
        return unreached(settled("policy_rejected", HOST_REFUSED_DETAIL));
      } else {
        answers = read.answer.projects;
      }
    }
    if (unsupported) {
      const leftMs = deadline - now();
      answers = await within(
        readProjectByProject(deps, client, hostId, base, leftMs),
        leftMs,
        projects.map(({ projectId }): ProjectStatusAnswer => ({
          status: "failed",
          projectId,
          reason: "timeout",
        }))
      );
    }
    // Control switched off while it was read: nothing read is shown.
    if (!deps.controlOn(hostId)) return unreached(settled("opted_out", CONTROL_OFF_DETAIL));
    const byProject = new Map((answers ?? []).map((answer) => [answer.projectId, answer]));
    const ordered = projects.map(
      ({ projectId }): ProjectStatusAnswer =>
        byProject.get(projectId) ?? { status: "failed", projectId, reason: "unreadable" }
    );
    return {
      coverage: unsupported ? coverageOf(ordered) : "ok",
      targets: new Map(ordered.map((answer) => [answer.projectId, readOf(answer, false)])),
    };
  } finally {
    release();
  }
}

async function readLocalHost(
  deps: HostStatusToolDeps,
  base: Omit<StatusPayload, "runMs">
): Promise<HostRead> {
  const local = deps.local;
  if (!local) {
    return {
      coverage: "unreachable",
      targets: everyTarget(base.projects, settled("not_found", NO_HOST_DETAIL)),
    };
  }
  const targets = new Map<string, TargetRead>();
  // Its own project it reads directly, never through here.
  const reachable = base.projects.filter((project) => {
    if (project.projectId !== deps.callerProjectId) return true;
    targets.set(project.projectId, settled("policy_rejected", OWN_PROJECT_DETAIL));
    return false;
  });
  const status = local.status;
  if (!status) {
    for (const { projectId } of reachable) {
      targets.set(projectId, settled("unsupported", FAILURE_READS.unsupported.detail));
    }
    return { coverage: "unsupported", targets };
  }
  if (reachable.length > 0) {
    const timedOut = reachable.map(({ projectId }): ProjectStatusAnswer => ({
      status: "failed",
      projectId,
      reason: "timeout",
    }));
    const answers = await within(
      Promise.resolve()
        .then(() =>
          status.call(local, { ...base, projects: reachable, runMs: HOST_STATUS_READ_MS })
        )
        .catch(() =>
          reachable.map(({ projectId }) => ({
            status: "failed" as const,
            projectId,
            reason: "unreadable" as const,
          }))
        ),
      HOST_STATUS_READ_MS,
      timedOut
    );
    const byProject = new Map(answers.map((answer) => [answer.projectId, answer]));
    for (const { projectId } of reachable) {
      const answer = byProject.get(projectId) ?? {
        status: "failed" as const,
        projectId,
        reason: "unreadable" as const,
      };
      targets.set(projectId, readOf(answer, true));
    }
  }
  return { coverage: "ok", targets };
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * The answer held to the MCP result's cap (#16191): tails share what the
 * states leave, fairly across every terminal in it, whichever host they are
 * on. Only when the states alone overrun are whole terminals left out, from
 * the end, each counted in its target's `omitted`; a tail is never kept at a
 * state's expense.
 */
export function fitHostStatus(result: HostStatusResult, maxBytes: number): HostStatusResult {
  const targetOf = new Map(
    result.targets.map((target, index) => [`${target.hostId}\u0000${target.projectId}`, index])
  );
  const keyOf = (entry: HostStatusTerminal) => `${entry.hostId}\u0000${entry.projectId}`;
  let terminals = result.terminals;
  const dropped = new Map<number, number>();
  const drop = (entries: readonly HostStatusTerminal[]) => {
    for (const entry of entries) {
      const index = targetOf.get(keyOf(entry));
      if (index !== undefined) dropped.set(index, (dropped.get(index) ?? 0) + 1);
    }
  };
  if (terminals.length > HOST_STATUS_TERMINALS_MAX) {
    drop(terminals.slice(HOST_STATUS_TERMINALS_MAX));
    terminals = terminals.slice(0, HOST_STATUS_TERMINALS_MAX);
  }
  // Measured with every count at the most it can reach, so a count that gains
  // digits never carries the answer past the cap.
  const worstTargets = result.targets.map((target, index) => ({
    ...target,
    complete: false,
    omitted:
      target.omitted +
      (dropped.get(index) ?? 0) +
      terminals.filter((entry) => targetOf.get(keyOf(entry)) === index).length,
  }));
  let used = utf8Bytes({ ...result, targets: worstTargets, terminals: [] });
  let kept = 0;
  for (const entry of terminals) {
    const stateOnly =
      typeof entry.recentOutput === "string"
        ? { ...entry, recentOutput: "", recentOutputTruncated: true }
        : entry;
    used += utf8Bytes(stateOnly) + (kept > 0 ? 1 : 0);
    if (used > maxBytes) break;
    kept += 1;
  }
  if (kept < terminals.length) {
    drop(terminals.slice(kept));
    terminals = terminals.slice(0, kept);
  }
  const targets: HostStatusTargetResult[] = result.targets.map((target, index) => {
    const lost = dropped.get(index) ?? 0;
    return lost === 0 ? target : { ...target, complete: false, omitted: target.omitted + lost };
  });
  return boundTerminalStatusOutput({ ...result, targets, terminals }, maxBytes);
}

function outputOf(includeOutput: HostStatusArgs["includeOutput"]): StatusOutput | null {
  if (includeOutput === undefined || includeOutput === false) return null;
  if (includeOutput === true) return { lines: HOST_STATUS_DEFAULT_LINES, stripAnsi: true };
  return { lines: includeOutput.lines, stripAnsi: includeOutput.stripAnsi };
}

/**
 * `host.status` for one of this machine's assistants (#16191): every host
 * named is read at once, each in one exchange where it can, and the answer is
 * one `terminal.getStatus` reading per project, every terminal in one list.
 */
export async function runHostStatus(
  deps: HostStatusToolDeps,
  helpSessionId: string,
  args: HostStatusArgs
): Promise<HostStatusResult> {
  const includeOutput = outputOf(args.includeOutput);
  const groups = new Map<HostId, StatusProject[]>();
  for (const target of args.targets) {
    const projects = groups.get(target.hostId) ?? [];
    projects.push({
      projectId: target.projectId,
      ...(target.terminalIds ? { terminalIds: target.terminalIds } : {}),
    });
    groups.set(target.hostId, projects);
  }
  const reads = await Promise.all(
    [...groups].map(async ([hostId, projects]): Promise<[HostId, HostRead]> => {
      if (!deps.mayRelay) {
        return [
          hostId,
          {
            coverage: "unreachable",
            targets: everyTarget(projects, settled("policy_rejected", WITHHELD_DETAIL)),
          },
        ];
      }
      const base: Omit<StatusPayload, "runMs"> = {
        helpSessionId,
        tier: deps.tier,
        ...(deps.global ? { global: true as const } : {}),
        projects,
        includeOutput,
      };
      try {
        return [
          hostId,
          hostId === LOCAL_HOST_ID
            ? await readLocalHost(deps, base)
            : await readRemoteHost(deps, hostId, base),
        ];
      } catch {
        return [
          hostId,
          {
            coverage: "unreachable",
            targets: everyTarget(projects, settled("disconnected", DISCONNECTED_DETAIL)),
          },
        ];
      }
    })
  );
  const byHost = new Map(reads);
  const targets: HostStatusTargetResult[] = [];
  const terminals: HostStatusTerminal[] = [];
  for (const { hostId, projectId } of args.targets) {
    const read =
      byHost.get(hostId)?.targets.get(projectId) ?? settled("disconnected", DISCONNECTED_DETAIL);
    const result = read.answer?.result ?? null;
    targets.push({
      hostId,
      projectId,
      outcome: read.outcome,
      detail: read.detail,
      retryAfterMs: read.retryAfterMs,
      source: result?.source ?? null,
      unavailableFields: result?.unavailableFields ?? null,
      complete: read.answer?.complete ?? false,
      omitted: read.answer?.omitted ?? 0,
    });
    for (const entry of result?.terminals ?? []) terminals.push({ ...entry, hostId, projectId });
  }
  return fitHostStatus(
    {
      hosts: reads.map(([hostId, read]) => ({ hostId, coverage: read.coverage })),
      targets,
      terminals,
    },
    MCP_RESPONSE_TEXT_MAX_BYTES
  );
}
