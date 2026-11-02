import {
  targetOf,
  type AgentResumeAdapter,
  type LocalStore,
  type QuestionOrigin,
  type TerminalTarget,
} from "@daintreehq/decisions-client";
import { getEffectiveAgentConfig, getEffectiveAgentIds } from "../../../shared/config/agentRegistry.js";
import type { NotifyTerminalInfo } from "../mcp-server/terminalNotify.js";
import type { AgentPromptWaitResult } from "../viewless/agentPromptWait.js";
import type {
  AgentSessionPaneRefusal,
  AgentSessionPaneRequest,
  AgentSessionPaneResult,
} from "../viewless/viewlessAgentResume.js";
import type { DecisionSinkPtyClient } from "./daintreeTerminalSink.js";
import {
  NO_WORKTREE,
  identityMismatch,
  incarnationOf,
  type DecisionIdentitySources,
} from "./decisionWake.js";

/**
 * The agents whose resume by session id is proven (#16019). Every other one
 * reports unsupported until its CLI's resume is proven the same way.
 */
export const RESUMABLE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

/** How long a resumed agent has to reach its prompt before the answer needs a person. */
export const RESUME_PROMPT_TIMEOUT_MS = 90_000;

/**
 * Why a resume didn't happen, recorded as the question's `error_code`.
 * Stable: the needs-attention list (#16020) names each one.
 */
export type ResumeFailure =
  | "resume_unsupported_agent"
  | "resume_other_host"
  | "resume_host_unreachable"
  | "resume_host_unreadable"
  | "resume_no_session"
  | "resume_no_worktree"
  | "resume_worktree_gone"
  | "resume_other_worktree"
  | "resume_unknown_project"
  | "resume_panel_limit"
  | "resume_missing_cli"
  | "resume_spawn_failed"
  | "resume_timeout"
  | "resume_exited"
  | "resume_closed"
  | "resume_no_bearer"
  | "resume_target_changed"
  | "resume_ended"
  | "resume_failed";

const LAUNCH_REFUSALS: Record<AgentSessionPaneRefusal, ResumeFailure> = {
  "no-session-id": "resume_no_session",
  "unknown-agent": "resume_unsupported_agent",
  "no-resume-support": "resume_unsupported_agent",
  "unknown-project": "resume_unknown_project",
  "history-unavailable": "resume_host_unreadable",
  "worktrees-unavailable": "resume_host_unreadable",
  "terminals-unavailable": "resume_host_unreadable",
  "worktree-gone": "resume_worktree_gone",
  "other-worktree": "resume_other_worktree",
  "panel-limit": "resume_panel_limit",
  "missing-cli": "resume_missing_cli",
  "spawn-failed": "resume_spawn_failed",
};

/**
 * The codes the library records when the run that asked is no longer there
 * and no resume brought it back. Only these are replaced by the resume's own
 * reason; every other attention code says something a resume didn't decide.
 */
const RESUMABLE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "relaunched",
  "pane_gone",
  "generation_mismatch",
  "session_mismatch",
]);

/** What resuming needs beyond the pane identity sources: the #16000 launch and its wait. */
export interface SessionResumeDeps {
  /** Reopens the session as a pane of its worktree (`resumeAgentSessionAsPane`). */
  resumeSession(request: AgentSessionPaneRequest): Promise<AgentSessionPaneResult>;
  /** Waits for the agent in the pane to reach its prompt (`waitForAgentAtPrompt`). */
  waitForPrompt(
    terminalId: string,
    options: { timeoutMs: number; signal: AbortSignal; promptOnly: true }
  ): Promise<AgentPromptWaitResult>;
  isDirectory(path: string): Promise<boolean>;
  timeoutMs?: number;
}

export interface DaintreeResumeDeps extends DecisionIdentitySources, SessionResumeDeps {
  getPtyClient(): DecisionSinkPtyClient | null;
  /** Aborted when delivery stops: a resume in progress then throws, so nothing is recorded for it. */
  signal: AbortSignal;
}

type Attempt = { target: TerminalTarget } | { failure: ResumeFailure };

/** A run of a pane as read off the pty host. */
interface RunRead {
  generation: number;
  principal: string | null;
  info: NotifyTerminalInfo;
}

/** The asking run, as a key: every identity field of the origin, plus where it ran. */
function originKey(o: QuestionOrigin): string {
  return JSON.stringify([
    o.host_id,
    o.pane_id,
    o.terminal_generation,
    o.ownership_principal,
    o.agent_incarnation,
    o.agent_session_id,
    o.agent_kind,
    o.project_id,
    o.worktree_id,
    o.worktree_root,
  ]);
}

const probeKey = (kind: string, hostId: string) => JSON.stringify([kind, hostId]);

function abortError(): Error {
  const error = new Error("Delivery stopped while a session was being resumed");
  error.name = "AbortError";
  return error;
}

/** The session id an origin names, when it's one an agent can reopen exactly. */
function sessionOf(origin: QuestionOrigin): string | null {
  const id = origin.agent_session_id?.trim() ?? "";
  return id === "" ? null : id;
}

/**
 * Resumes a Claude or Codex session to deliver an answer whose pane is gone
 * (#16019), as the library's `AgentResumeAdapter` for each agent.
 *
 * A resume runs only for a question asked on this machine, whose worktree's
 * directory is still there, from an agent whose resume is proven and with a
 * session id the origin recorded. A session found only in the history
 * journal is never used: a pane's earlier run can't be told apart there from
 * the run that asked, which may never have recorded one.
 *
 * It reopens the session through #16000's launch, which hands back a live
 * pane already holding the session instead of starting a second agent on
 * its transcript. A pane it launched is waited for until the agent is at its
 * prompt, for a bounded time; a pane that was already running is taken as it
 * is, and the answer waits for its prompt like any other. Either way the run
 * is read before and after, and taken only if it is still the session in
 * the origin's worktree. The library then records it as the question's
 * destination and delivers through the usual gate.
 *
 * The library records only a generic code (`pane_gone`) when a resume
 * doesn't happen, so this keeps each refusal's own reason, and
 * `withResumeReasons` writes it in that code's place.
 *
 * Questions from one run share one resume in a delivery pass (`endPass`
 * forgets it), so a timeout is waited out once. A run this resumed into that
 * then goes away isn't resumed again in the same lifetime: whoever closed it
 * would only see it come back.
 */
export class DaintreeResume {
  readonly adapters: AgentResumeAdapter[];
  private readonly attempts = new Map<string, Promise<Attempt>>();
  private readonly refusals = new Map<string, ResumeFailure>();
  private readonly probeRefusals = new Map<string, ResumeFailure>();
  /** Panes a resume handed an answer to, this lifetime. */
  private readonly resumedInto = new Set<string>();

  constructor(private readonly deps: DaintreeResumeDeps) {
    const kinds = new Set([...RESUMABLE_AGENTS, ...getEffectiveAgentIds()]);
    this.adapters = [...kinds].map((kind) =>
      RESUMABLE_AGENTS.has(kind) ? this.adapter(kind) : this.unsupported(kind)
    );
  }

  /**
   * Why the run that asked couldn't be resumed this pass, or null when
   * nothing here refused it. An agent with no adapter at all is unsupported.
   */
  reasonFor(origin: QuestionOrigin): ResumeFailure | null {
    const refused =
      this.refusals.get(originKey(origin)) ??
      this.probeRefusals.get(probeKey(origin.agent_kind, origin.host_id));
    if (refused !== undefined) return refused;
    return this.adapters.some((adapter) => adapter.kind === origin.agent_kind)
      ? null
      : "resume_unsupported_agent";
  }

  /** Forgets this pass's resumes and reasons, so the next pass (or "Try resume") starts afresh. */
  endPass(): void {
    this.attempts.clear();
    this.refusals.clear();
    this.probeRefusals.clear();
  }

  private unsupported(kind: string): AgentResumeAdapter {
    return {
      kind,
      probe: async (hostId) => {
        this.probeRefusals.set(probeKey(kind, hostId), "resume_unsupported_agent");
        return {
          supported: false,
          reason: `resuming ${kind} sessions isn't proven yet, so its answers wait for a person`,
        };
      },
      canResume: async () => false,
      resume: async () => {
        throw new Error(`resume is not supported for "${kind}"`);
      },
    };
  }

  private adapter(kind: string): AgentResumeAdapter {
    return {
      kind,
      probe: async (hostId) => {
        const refused = this.hostRefusal(hostId);
        const key = probeKey(kind, hostId);
        if (refused === null) {
          this.probeRefusals.delete(key);
          return { supported: true };
        }
        this.probeRefusals.set(key, refused);
        return { supported: false, reason: refused };
      },
      canResume: async (origin) => {
        const refused = await this.eligibility(origin);
        if (refused === null) return true;
        this.refusals.set(originKey(origin), refused);
        return false;
      },
      resume: (origin) => this.resume(origin),
    };
  }

  private hostRefusal(hostId: string): ResumeFailure | null {
    if (this.deps.hostId() !== hostId) return "resume_other_host";
    if (this.deps.getPtyClient() === null) return "resume_host_unreachable";
    return null;
  }

  private async eligibility(origin: QuestionOrigin): Promise<ResumeFailure | null> {
    const host = this.hostRefusal(origin.host_id);
    if (host !== null) return host;
    if (this.resumedInto.has(origin.pane_id)) return "resume_ended";
    const resumeKind = getEffectiveAgentConfig(origin.agent_kind)?.resume?.kind;
    if (resumeKind !== "session-id" && resumeKind !== "named-target") {
      return "resume_unsupported_agent";
    }
    if (sessionOf(origin) === null) return "resume_no_session";
    if (
      origin.project_id === "" ||
      origin.worktree_id === NO_WORKTREE ||
      origin.worktree_root.trim() === ""
    ) {
      return "resume_no_worktree";
    }
    const there = await this.deps.isDirectory(origin.worktree_root).catch(() => false);
    this.throwIfStopped();
    return there ? null : "resume_worktree_gone";
  }

  private async resume(origin: QuestionOrigin): Promise<{ target: TerminalTarget; ready: boolean }> {
    this.throwIfStopped();
    const key = originKey(origin);
    let attempt = this.attempts.get(key);
    if (attempt === undefined) {
      attempt = this.attempt(origin);
      this.attempts.set(key, attempt);
    }
    const result = await attempt;
    this.throwIfStopped();
    if ("failure" in result) {
      this.refusals.set(key, result.failure);
      return { target: targetOf(origin), ready: false };
    }
    this.refusals.delete(key);
    this.resumedInto.add(result.target.paneId);
    return { target: result.target, ready: true };
  }

  private async attempt(origin: QuestionOrigin): Promise<Attempt> {
    try {
      return await this.reopen(origin);
    } catch (error) {
      if (this.deps.signal.aborted) throw abortError();
      console.warn(
        "[Decisions] Resuming a session for an answer failed:",
        error instanceof Error ? error.name : typeof error
      );
      return { failure: "resume_failed" };
    }
  }

  private async reopen(origin: QuestionOrigin): Promise<Attempt> {
    const sessionId = sessionOf(origin);
    if (sessionId === null) return { failure: "resume_no_session" };
    const launched = await this.deps.resumeSession({
      projectId: origin.project_id,
      worktreeId: origin.worktree_id,
      agentId: origin.agent_kind,
      sessionId,
      cwd: origin.worktree_root,
    });
    this.throwIfStopped();
    if (launched.status === "refused") return { failure: LAUNCH_REFUSALS[launched.reason] };
    if (launched.worktreeId !== origin.worktree_id || launched.projectId !== origin.project_id) {
      return { failure: "resume_other_worktree" };
    }
    const { terminalId } = launched;

    const before = await this.read(terminalId);
    this.throwIfStopped();
    if (before === null) return { failure: "resume_host_unreadable" };
    const first = this.targetFrom(origin, sessionId, terminalId, before);
    if ("failure" in first) return first;
    // A pane that was already running is the session as it is: the answer
    // waits for its prompt like any other, however long its turn takes.
    if (launched.status === "existing") return first;

    const waited = await this.deps.waitForPrompt(terminalId, {
      timeoutMs: this.deps.timeoutMs ?? RESUME_PROMPT_TIMEOUT_MS,
      signal: this.deps.signal,
      promptOnly: true,
    });
    this.throwIfStopped();
    switch (waited.outcome) {
      case "settled":
        break;
      case "timeout":
        return { failure: "resume_timeout" };
      case "exited":
        return { failure: "resume_exited" };
      case "closed":
        return { failure: "resume_closed" };
      case "aborted":
        throw abortError();
    }

    const after = await this.read(terminalId);
    this.throwIfStopped();
    if (after === null) return { failure: "resume_closed" };
    const settled = this.targetFrom(origin, sessionId, terminalId, after);
    if ("failure" in settled) return settled;
    // The same run as at launch: a restart in the pane meanwhile is another.
    const same =
      settled.target.terminalGeneration === first.target.terminalGeneration &&
      settled.target.ownershipPrincipal === first.target.ownershipPrincipal &&
      settled.target.agentIncarnation === first.target.agentIncarnation;
    return same ? settled : { failure: "resume_target_changed" };
  }

  /** The pane's run as the pty host has it, or null when it couldn't be read. */
  private async read(terminalId: string): Promise<RunRead | null> {
    const client = this.deps.getPtyClient();
    if (client === null) return null;
    const generation = client.getLiveGeneration(terminalId);
    if (generation === null || !client.isLiveGeneration(terminalId, generation)) return null;
    const principal = this.deps.principalFor(terminalId);
    let info: NotifyTerminalInfo | null;
    try {
      info = await client.getTerminalAsync(terminalId, undefined, { strict: true });
    } catch {
      return null;
    }
    return info === null ? null : { generation, principal, info };
  }

  /**
   * The run as a delivery target, only if every part of its identity was
   * observed and it is the session in the origin's worktree and project.
   */
  private targetFrom(
    origin: QuestionOrigin,
    sessionId: string,
    terminalId: string,
    run: RunRead
  ): { target: TerminalTarget } | { failure: ResumeFailure } {
    const { info, generation, principal } = run;
    if (info.isExited === true || info.hasPty === false || info.isTrashed === true) {
      return { failure: "resume_closed" };
    }
    if (principal === null) return { failure: "resume_no_bearer" };
    const incarnation = incarnationOf(info);
    const agent = info.detectedAgentId ?? info.launchAgentId;
    if (
      incarnation === null ||
      info.agentSessionId !== sessionId ||
      agent !== origin.agent_kind ||
      (info.projectId !== undefined && info.projectId !== origin.project_id) ||
      (info.launchGeneration !== undefined && info.launchGeneration !== generation)
    ) {
      return { failure: "resume_target_changed" };
    }
    if ((info.worktreeId ?? NO_WORKTREE) !== origin.worktree_id) {
      return { failure: "resume_other_worktree" };
    }
    const hostId = this.deps.hostId();
    if (hostId === null || hostId !== origin.host_id) return { failure: "resume_other_host" };
    const target: TerminalTarget = {
      hostId,
      paneId: terminalId,
      terminalGeneration: generation,
      ownershipPrincipal: principal,
      agentIncarnation: incarnation,
      agentSessionId: sessionId,
      worktreeId: origin.worktree_id,
    };
    // The same check the sink makes before typing, so a target it would refuse is never adopted.
    return identityMismatch(this.deps, target, info) === null
      ? { target }
      : { failure: "resume_target_changed" };
  }

  private throwIfStopped(): void {
    if (this.deps.signal.aborted) throw abortError();
  }
}

/**
 * The store as the delivery engine writes to it, with a resume's own reason
 * in place of the library's generic code when a question goes to
 * needs-attention because its run couldn't be resumed. The question is read
 * again so the reason is the one recorded for its own origin. The report to
 * the relay and the library's audit keep the generic code.
 */
export function withResumeReasons<T extends LocalStore>(store: T, resume: DaintreeResume): T {
  const updateQuestion: LocalStore["updateQuestion"] = async (questionId, patch) => {
    if (
      patch.delivery_status === "needs-attention" &&
      typeof patch.error_code === "string" &&
      RESUMABLE_UNAVAILABLE_CODES.has(patch.error_code)
    ) {
      const row = await store.getQuestion(questionId);
      const reason = row ? resume.reasonFor(row.origin) : null;
      if (reason !== null) return store.updateQuestion(questionId, { ...patch, error_code: reason });
    }
    return store.updateQuestion(questionId, patch);
  };
  return new Proxy(store, {
    get(object, property) {
      if (property === "updateQuestion") return updateQuestion;
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}
