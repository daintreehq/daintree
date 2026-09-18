import type { TerminalStatusResult } from "@shared/types/terminalStatus";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { deliveryFromPhase, launchReadiness, type DeliveryState } from "./deliveryState";

const DELIVERY_POLL_MS = 250;
const DELIVERY_TIMEOUT_MS = 10_000;
const LAUNCH_POLL_MS = 500;
/** A first launch can sit behind a login or an update; give it a real chance. */
const LAUNCH_READY_TIMEOUT_MS = 3 * 60_000;
const UNKNOWN_READINESS_MS = 5_000;

export type AgentRequestDestination =
  | { kind: "terminal"; terminalId: string; title: string }
  | { kind: "launch"; agentId: string; title: string };

/** Everything the host can say about one request, published on every change. */
export interface AgentRequestDelivery {
  state: DeliveryState;
  /** The destination's own name, as the surface offered it. */
  title: string;
  terminalId: string | null;
  /**
   * The exact text handed to the agent, once built: what the agent was told is
   * what the user reviews, not a reconstruction.
   */
  request?: string;
}

export interface AgentRequestOptions {
  /**
   * Who the request belongs to. {@link cancelAgentRequests} matches on a prefix
   * of this, so an owner that composes several segments (a panel and a
   * worktree, say) can end a whole family of requests at once.
   */
  ownerKey: string;
  /**
   * A second `deliverAgentRequest` with a key already in flight joins that run
   * instead of starting another — a retried call or a remounted surface must not
   * submit twice. Freed as soon as the run settles, is cancelled or is
   * superseded, so a later send of the same words is a run of its own. The key
   * must cover everything the caller knows the prompt is built from: two calls
   * that would produce different prompts are different requests. It cannot
   * cover context the run fetches for itself, so a joined call gets the fetch
   * the in-flight run made rather than a fresh one. It says nothing about what the agent did with a
   * write that was already ambiguous: an unconfirmed delivery stays
   * unconfirmed, and repeating it is the user's call, never a retry of ours.
   */
  idempotencyKey?: string;
  destination: AgentRequestDestination;
  worktreeId: string | null;
  /** Whether the request may still go out at all: checked before every step. */
  stillOwned: () => boolean;
  /** Where delivery state goes. Called with the whole record, newest last. */
  onState: (delivery: AgentRequestDelivery) => void;
  buildPrompt: () => Promise<string>;
  /** A reason the request may no longer go out, checked before building and before submitting. */
  verify?: () => Promise<string | null>;
  /** A launch resolved to this terminal — the owner may want to point at it. */
  onDestination?: (terminalId: string) => void;
}

interface Run extends AgentRequestDelivery {
  ownerKey: string;
  onState: (delivery: AgentRequestDelivery) => void;
  /** The user told this run to go ahead without a readiness signal. */
  forced: boolean;
  /** The prompt has been handed to the terminal: cancelling can't take it back. */
  submitted: boolean;
  /** Frees this run's idempotency key, when it has one. */
  releaseKey?: () => void;
}

/** Newest request per owner; an older one still running stops reporting. */
const latestRun = new Map<string, Run>();
const inFlight = new Map<string, Promise<void>>();

const IN_FLIGHT_STATES = new Set<DeliveryState["status"]>([
  "sending",
  "starting",
  "needs-you",
  "unknown-readiness",
]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "Send anyway": deliver the owner's pending request without a readiness signal. */
export function forceAgentRequest(ownerKey: string): void {
  const run = latestRun.get(ownerKey);
  if (run) run.forced = true;
}

/** Stop one request and say truthfully where it got to. */
function cancelRun(run: Run): void {
  latestRun.delete(run.ownerKey);
  // A cancelled run is nobody's answer any more: holding its key would make the
  // next send of the same words join a run that will never submit.
  run.releaseKey?.();
  if (!IN_FLIGHT_STATES.has(run.state.status)) return;
  emit(
    run,
    run.submitted
      ? { status: "unconfirmed" }
      : { status: "failed", message: "Stopped before the request was sent" }
  );
}

/**
 * End every request an owner still has waiting, by owner-key prefix: the
 * surface was switched off, removed or moved, or its plugin disabled. A session
 * that becomes ready afterwards must not receive a request nobody is watching.
 */
export function cancelAgentRequests(ownerKeyPrefix: string): void {
  for (const run of [...latestRun.values()]) {
    if (run.ownerKey.startsWith(ownerKeyPrefix)) cancelRun(run);
  }
}

function emit(run: Run, state: DeliveryState, terminalId?: string | null): void {
  run.state = state;
  if (terminalId !== undefined) run.terminalId = terminalId;
  run.onState({
    state: run.state,
    title: run.title,
    terminalId: run.terminalId,
    ...(run.request === undefined ? {} : { request: run.request }),
  });
}

/**
 * The agent terminal is still somewhere this request may go: not trashed, and
 * in the owner's worktree. A terminal the host hasn't listed yet (a session
 * that is just starting) isn't evidence against it.
 */
function destinationStillEligible(terminalId: string, worktreeId: string | null): boolean {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return true;
  return panel.location !== "trash" && (panel.worktreeId ?? null) === worktreeId;
}

/**
 * Deliver one request to an agent and report what the host can prove about it.
 * Runs independently of any component: the surface that asked for it is free to
 * unmount — the grid re-lays the moment a new agent opens — and the run keeps
 * going, checking ownership rather than assuming anything is mounted to watch.
 *
 * Every dispatch here carries `source: "user"`, because every run starts from a
 * user's click on a host surface. Nothing in this module may be reached from
 * plugin worker code, or from a timer or automation acting on its own: that
 * would launder unattended intent through a user-sourced dispatch and past the
 * policy `denyPluginDispatch` exists to apply.
 */
export function deliverAgentRequest(options: AgentRequestOptions): Promise<void> {
  const { idempotencyKey } = options;
  if (idempotencyKey !== undefined) {
    const existing = inFlight.get(idempotencyKey);
    if (existing) return existing;
  }
  const run: Run = {
    ownerKey: options.ownerKey,
    onState: options.onState,
    state: { status: "sending" },
    title: options.destination.title,
    terminalId: null,
    forced: false,
    submitted: false,
  };
  const previous = latestRun.get(run.ownerKey);
  if (previous) {
    previous.forced = false;
    // Superseded: it will notice at its next checkpoint and stop reporting, and
    // it is nobody's answer in the meantime, so its key goes back now. Holding
    // it would make a retry of that older request join a run that is already
    // dead.
    previous.releaseKey?.();
  }
  latestRun.set(run.ownerKey, run);
  if (idempotencyKey === undefined) return deliver(run, options);
  // Claimed before the run starts, not after: the run's own first steps can
  // call back into an owner that asks again, and a key registered afterwards
  // would overwrite that second claim with this one. The stand-in settles with
  // the run, so a caller that joins gets the same outcome.
  let settleWith!: (outcome: Promise<void>) => void;
  const claim = new Promise<void>((resolve, reject) => {
    settleWith = (outcome) => outcome.then(resolve, reject);
  });
  inFlight.set(idempotencyKey, claim);
  run.releaseKey = () => {
    if (inFlight.get(idempotencyKey) === claim) inFlight.delete(idempotencyKey);
  };
  claim.then(run.releaseKey, run.releaseKey);
  const promise = deliver(run, options);
  settleWith(promise);
  return promise;
}

async function deliver(run: Run, options: AgentRequestOptions): Promise<void> {
  const { destination, worktreeId, stillOwned, verify, buildPrompt, onDestination } = options;
  const { title } = destination;
  // An owner that closed, moved or switched off stops the run here, whether or
  // not any surface is mounted to notice.
  const current = () => {
    if (latestRun.get(run.ownerKey) !== run) return false;
    if (stillOwned()) return true;
    cancelRun(run);
    return false;
  };
  const report = (state: DeliveryState, terminalId: string | null) => {
    if (!current()) return;
    emit(run, state, terminalId);
  };
  try {
    await send();
  } finally {
    if (latestRun.get(run.ownerKey) === run) latestRun.delete(run.ownerKey);
    // Freed here rather than off the promise: a caller resuming from `await`
    // runs before a `.then` on the same promise would, and it must not be able
    // to rejoin the run it has just finished awaiting.
    run.releaseKey?.();
  }

  async function send(): Promise<void> {
    report({ status: "sending" }, destination.kind === "launch" ? null : destination.terminalId);
    let prompt: string;
    try {
      const problem = verify ? await verify() : null;
      if (problem) {
        report({ status: "failed", message: problem }, null);
        return;
      }
      prompt = await buildPrompt();
      run.request = prompt;
      // Republished now, not at the next state change: a run cancelled
      // mid-submit keeps its last record, and that record must carry what was
      // typed.
      report(run.state, destination.kind === "launch" ? null : destination.terminalId);
    } catch (error) {
      report(
        { status: "failed", message: formatErrorMessage(error, "Couldn't prepare the request") },
        null
      );
      return;
    }
    if (!current()) return;

    let terminalId: string;
    if (destination.kind === "launch") {
      // Started without the request: a launch prompt goes through the shell as
      // one argument and loses its line breaks, fenced source included. The
      // request is typed in once the agent is at its prompt.
      const launched = await actionService.dispatch<{
        launched: boolean;
        terminalId: string | null;
      }>(
        "agent.launch",
        { agentId: destination.agentId, ...(worktreeId ? { worktreeId } : {}), location: "grid" },
        { source: "user" }
      );
      if (!current()) return;
      if (!launched.ok || !launched.result.launched || !launched.result.terminalId) {
        report(
          {
            status: "failed",
            message: launched.ok ? `${title} couldn't start here` : launched.error.message,
          },
          null
        );
        return;
      }
      terminalId = launched.result.terminalId;
      onDestination?.(terminalId);
      report({ status: "starting" }, terminalId);
    } else {
      terminalId = destination.terminalId;
    }

    // Every destination gets the same check, new session or old: a trust,
    // approval or error prompt is also "waiting", and typed input would answer it.
    const readyBy = Date.now() + LAUNCH_READY_TIMEOUT_MS;
    const waitingSince = Date.now();
    let ready = false;
    let firstCheck = true;
    while (!ready && Date.now() < readyBy) {
      if (!firstCheck || destination.kind === "launch") await wait(LAUNCH_POLL_MS);
      firstCheck = false;
      if (!current()) return;
      const status = await actionService.dispatch<TerminalStatusResult>(
        "terminal.getStatus",
        { terminalIds: [terminalId] },
        { source: "user" }
      );
      if (!current()) return;
      const entry = status.ok
        ? status.result.terminals.find((terminal) => terminal.terminalId === terminalId)
        : undefined;
      if (entry?.error) {
        report({ status: "failed", message: `${title} isn't running any more` }, terminalId);
        return;
      }
      // No readable status is no evidence of readiness; neither is a terminal the
      // detector hasn't classified. Both keep waiting — and after a few seconds
      // the user may say "send anyway", because a detector can stay silent.
      const readiness =
        entry === undefined ? "not-yet" : launchReadiness(entry.agentState, entry.waitingReason);
      if (readiness === "ready" || run.forced) ready = true;
      else if (readiness === "needs-you") report({ status: "needs-you" }, terminalId);
      else if (Date.now() - waitingSince > UNKNOWN_READINESS_MS) {
        report({ status: "unknown-readiness" }, terminalId);
      }
    }
    if (!ready) {
      report({ status: "failed", message: `${title} didn't reach its prompt` }, terminalId);
      return;
    }

    const problem = verify ? await verify() : null;
    // Checked after the last await, so nothing can move the agent in between.
    if (!current()) return;
    if (problem) {
      report({ status: "failed", message: problem }, terminalId);
      return;
    }
    if (!destinationStillEligible(terminalId, worktreeId)) {
      report(
        { status: "failed", message: `${title} left this worktree — the request wasn't sent` },
        terminalId
      );
      return;
    }
    run.submitted = true;
    const result = await actionService.dispatch<{ submissionToken: string }>(
      "terminal.sendCommand",
      { terminalId, command: prompt },
      { source: "user" }
    );
    if (!current()) return;
    if (!result.ok) {
      report({ status: "failed", message: result.error.message, partial: true }, terminalId);
      return;
    }

    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    let state: DeliveryState | null = null;
    while (state === null && Date.now() < deadline) {
      await wait(DELIVERY_POLL_MS);
      if (!current()) return;
      const status = await actionService.dispatch<TerminalStatusResult>(
        "terminal.getStatus",
        { terminalIds: [terminalId], submissionToken: result.result.submissionToken },
        { source: "user" }
      );
      if (!current()) return;
      const phase = status.ok ? (status.result.terminals[0]?.submission?.phase ?? null) : null;
      state = deliveryFromPhase(phase);
    }
    report(state ?? { status: "unconfirmed" }, terminalId);
  }
}

export function __resetAgentRequestsForTests(): void {
  latestRun.clear();
  inFlight.clear();
}
