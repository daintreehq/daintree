import type { TerminalStatusEntry, TerminalStatusResult } from "@shared/types/terminalStatus";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { deliveryFromPhase, launchReadiness, type DeliveryState } from "./deliveryState";

const DELIVERY_POLL_MS = 250;
const DELIVERY_TIMEOUT_MS = 10_000;
const LAUNCH_POLL_MS = 500;
/** A first launch can sit behind a login or an update; give it a real chance. */
const LAUNCH_READY_TIMEOUT_MS = 3 * 60_000;
const QUEUE_POLL_MS = 250;
/** How long a request waits for its owner's subject to settle before it is judged as it stands. */
const SUBJECT_SETTLE_TIMEOUT_MS = 30_000;
/**
 * How long after one request went in the next may follow it without the agent
 * having been seen busy. A detector reads "waiting" for a beat after a prompt
 * is typed, and two requests typed back to back arrive as one.
 */
const AFTER_SEND_SETTLE_MS = 5_000;
/** How long a request's own preparation — its checks, its prompt, a launch — may take. */
const PREPARE_TIMEOUT_MS = 30_000;
/** How long a new session shows as starting before it is a request that is simply waiting. */
const STARTING_SHOWN_MS = 15_000;
/** How long a terminal's last send is remembered; well past any use of it. */
const LAST_SENT_KEPT_MS = 60_000;

export type AgentRequestDestination =
  | { kind: "terminal"; terminalId: string; title: string }
  | { kind: "launch"; agentId: string; title: string };

/** Everything the host can say about one request, published on every change. */
export interface AgentRequestDelivery {
  /** This request, among the several an owner may have waiting. */
  id: string;
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
   * submit twice. Held while the request waits its turn, and freed as soon as
   * the run settles or is cancelled, so a later send of the same words is a run
   * of its own. The key
   * must cover everything the caller knows the prompt is built from: two calls
   * that would produce different prompts are different requests. It cannot
   * cover context the run fetches for itself, so a joined call gets the fetch
   * the in-flight run made rather than a fresh one. It says nothing about what the agent did with a
   * write that was already ambiguous: an unconfirmed delivery stays
   * unconfirmed, and repeating it is the user's call, never a retry of ours.
   */
  idempotencyKey?: string;
  destination: AgentRequestDestination;
  /**
   * Where the request goes, asked again when its turn comes. A request queued
   * behind one that is starting a new session means that session, not a second
   * one — which only the owner can know.
   */
  resolveDestination?: () => AgentRequestDestination;
  /**
   * Whether what the request is about has settled. An earlier request's edit
   * can leave the owner re-establishing its subject; `verify` is held off until
   * it has, for a bounded wait, rather than failing a request for being early.
   */
  settled?: () => boolean;
  worktreeId: string | null;
  /** Whether the request may still go out at all: checked before every step. */
  stillOwned: () => boolean;
  /** Where delivery state goes. Called with the whole record, newest last. */
  onState: (delivery: AgentRequestDelivery) => void;
  buildPrompt: () => Promise<string>;
  /**
   * A reason the request may no longer go out. Asked before the prompt is built
   * and again after, the second time with `"built"`: that one is about the
   * prompt that now exists, so an owner that resolves its subject late can
   * refuse a prompt built from something it no longer stands behind.
   */
  verify?: (after?: "built") => Promise<string | null>;
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

/**
 * Each owner's requests, oldest first. They go out one at a time, in order: a
 * second request sent while the agent is still working on the first waits for
 * it rather than replacing it.
 */
const queues = new Map<string, Run[]>();
const inFlight = new Map<string, Promise<void>>();
/** When a request last went into a terminal, and whether the agent has been seen busy since. */
const lastSent = new Map<string, { at: number; busySeen: boolean }>();
/**
 * The one request allowed past the last look and into a terminal at a time.
 * The queue orders an owner's requests; two owners — two previews — can still
 * aim at one agent, and both would otherwise read "waiting" and type.
 */
const writing = new Map<string, Run>();
let nextRunId = 0;

const IN_FLIGHT_STATES = new Set<DeliveryState["status"]>([
  "queued",
  "sending",
  "starting",
  "needs-you",
]);

/** States an agent is observed in while it is doing something, as opposed to unreadable. */
const BUSY_AGENT_STATES = new Set<string>(["working", "directing"]);

function isQueued(run: Run): boolean {
  return queues.get(run.ownerKey)?.includes(run) ?? false;
}

function dequeue(run: Run): void {
  const queue = queues.get(run.ownerKey);
  if (!queue) return;
  const at = queue.indexOf(run);
  if (at >= 0) queue.splice(at, 1);
  if (queue.length === 0) queues.delete(run.ownerKey);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Send now": deliver the owner's next request without a readiness signal. Only
 * the request at the head of the queue can be pushed on; naming one further
 * back does nothing, since order is what the queue is for.
 */
export function forceAgentRequest(ownerKey: string, id?: string): void {
  const head = queues.get(ownerKey)?.[0];
  if (head && (id === undefined || head.id === id)) head.forced = true;
}

/**
 * Take one waiting request out of its owner's queue, and say which it was:
 * `removed` before anything was typed; `submitted` when it was already going in
 * — cancelled all the same, with a record that says what can't be taken back;
 * `absent` when no such request is waiting here.
 */
export function cancelAgentRequest(
  ownerKey: string,
  id: string
): "removed" | "submitted" | "absent" {
  const run = queues.get(ownerKey)?.find((candidate) => candidate.id === id);
  if (!run) return "absent";
  const outcome = run.submitted ? "submitted" : "removed";
  cancelRun(run);
  return outcome;
}

/**
 * Part of `run` may be sitting in the agent's input. Anything typed after it
 * would be appended to that, so what is queued behind it stops here, with its
 * words kept, rather than going in on top.
 */
function stopFollowers(run: Run): void {
  const following = (queues.get(run.ownerKey) ?? []).filter((next) => next !== run);
  for (const next of following) {
    dequeue(next);
    next.releaseKey?.();
  }
  // Told only once every one of them is out: a sink that throws must not leave
  // the rest queued to go in.
  for (const next of following) {
    emit(next, {
      status: "failed",
      message: "Not sent — the request before it may not have gone in cleanly",
    });
  }
}

/** Stop one request and say truthfully where it got to. */
function cancelRun(run: Run): void {
  // Cancelling cannot take back what was typed, and the requests behind this
  // one must not find out by being typed after it.
  if (run.submitted && IN_FLIGHT_STATES.has(run.state.status)) stopFollowers(run);
  dequeue(run);
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
  for (const run of [...queues.values()].flat()) {
    if (run.ownerKey.startsWith(ownerKeyPrefix)) cancelRun(run);
  }
}

function emit(run: Run, state: DeliveryState, terminalId?: string | null): void {
  run.state = state;
  if (terminalId !== undefined) run.terminalId = terminalId;
  try {
    run.onState({
      id: run.id,
      state: run.state,
      title: run.title,
      terminalId: run.terminalId,
      ...(run.request === undefined ? {} : { request: run.request }),
    });
  } catch {
    // A surface that fails to draw a state must not decide what gets typed.
  }
}

/** `work`, or a refusal when it takes longer than a request's preparation may. */
function bounded<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took too long`)), PREPARE_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
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
 * Which agent session a request was accepted for.
 *
 * A terminal id is a slot, not a session. The slot survives a restart, an agent
 * exiting to leave a shell behind, and a different agent being launched into
 * it — so readiness proved about the thing that was there says nothing about
 * the thing that is there now, and the gap is real: the run awaits a source
 * re-verification between proving readiness and submitting.
 *
 * `agentId` is the terminal's detected agent, falling back to what it was
 * launched as — so a shell with no agent and no launch hint is `null` and
 * refused, while a shell an agent was launched into keeps naming it. `spawnedAt` is the
 * stamp the panel takes when a pty starts under it, and every restart path
 * re-stamps it (`panelRegistry/restart.ts`), so it is the pty generation for
 * every generation the panel was there to see start. It is the renderer's
 * account of the generation rather than the host's, and the two come apart in
 * both directions: a pty-host crash replays the pty under the same id without
 * the panel re-stamping, and reconnecting to a pty that never stopped stamps a
 * new panel time. A replayed pty also starts its own count again, so a run
 * that lived through one can find every field back where it bound them — which
 * is why a look that names a different session ends the run then and there
 * rather than being weighed again at the end. A slot holding no pty at all — a
 * recovery hold, which `addPanel.ts` deliberately leaves unstamped — has no
 * generation to name, and is refused rather than compared: two absent stamps
 * are equal to each other, and that equality would be the whole check passing
 * on nothing.
 *
 * `agentIncarnation` is what neither of those can be: the count of times the
 * pty-host has *seen* a new agent take over this pty after a prior one exited.
 * An agent that quits leaving its shell, and the `claude` a user then types
 * into that shell, share the slot, the pty and the launch id — and differ
 * here (#12535). It is an observation of the boundaries the detector caught,
 * not proof of process identity. A relaunch it never classified still moves
 * nothing — an agent the terminal was launched as holds its detected identity
 * through a disappearance that never looked like a prompt returning, and a
 * second one started under it is the same identity again, not a new one. The
 * window between this last look and the write is still a window, too. That residue is why the host goes on treating every submission as
 * text typed at whatever is listening rather than as a message delivered to a
 * known conversation.
 */
interface DestinationIdentity {
  agentId: string;
  spawnedAt: number;
  agentIncarnation: number;
}

/** The identity an entry supports, or `null` when it supports none. */
function identityOf(entry: TerminalStatusEntry | undefined): DestinationIdentity | null {
  if (entry === undefined || entry.error !== undefined) return null;
  // An exit code is the process being gone, not a slow prompt.
  if (entry.exitCode !== undefined && entry.exitCode !== null) return null;
  // Explicitly false is the pty-host saying this slot has nothing to write to;
  // absent is a surface that does not report the field, which is not the same.
  if (entry.hasPty === false) return null;
  // `exited` is the agent leaving its own pty behind — the shell that was
  // underneath it is now what reads stdin. The pty did not restart, so
  // `spawnedAt` is unchanged, and `agentId` falls back to what the terminal was
  // *launched* as, so both halves of the identity survive a demotion. This is
  // the only field that notices, and it is checked here rather than with
  // readiness because "send anyway" waives readiness and must not waive this.
  if (entry.agentState === "exited") return null;
  // Tested for a string rather than against `null`: a surface that could not
  // observe the field leaves it out, and "unobserved" is not "an agent".
  if (typeof entry.agentId !== "string" || entry.agentId === "") return null;
  // Same reading applied to the generation stamp: unobserved is not "a session
  // that started at no time", and it must not compare equal to the next one.
  if (typeof entry.spawnedAt !== "number") return null;
  // And to the session count. Zero is a reading — no relaunch seen in this pty
  // generation — so it is only absence that refuses here. A surface that cannot
  // observe it cannot tell this session from its successor, which is the one
  // thing this identity is for; two absent counts comparing equal is the shape
  // #12441 had to fix once already.
  const agentIncarnation = entry.agentIncarnation;
  if (agentIncarnation === undefined || !Number.isSafeInteger(agentIncarnation)) return null;
  if (agentIncarnation < 0) return null;
  return { agentId: entry.agentId, spawnedAt: entry.spawnedAt, agentIncarnation };
}

function sameSession(bound: DestinationIdentity, now: DestinationIdentity): boolean {
  return (
    bound.agentId === now.agentId &&
    bound.spawnedAt === now.spawnedAt &&
    bound.agentIncarnation === now.agentIncarnation
  );
}

/** One terminal's current status entry, or `undefined` when none is readable. */
async function observe(terminalId: string): Promise<TerminalStatusEntry | undefined> {
  const status = await actionService.dispatch<TerminalStatusResult>(
    "terminal.getStatus",
    { terminalIds: [terminalId] },
    { source: "user" }
  );
  if (!status.ok) return undefined;
  return status.result.terminals.find((terminal) => terminal.terminalId === terminalId);
}

/** Says which of the two ways the destination stopped being the one bound to. */
function sessionChanged(title: string, now: DestinationIdentity | null): string {
  return now === null
    ? `${title} isn't an agent session any more — the request wasn't sent`
    : `${title} restarted before the request went out — nothing was sent`;
}

/**
 * Why a destination could not be bound. Kept apart from {@link sessionChanged}
 * because this one is about never having had a session to bind to: a slot with
 * no readable status, one holding no process at all, or one holding a plain
 * shell. Reached when the user says "send anyway", which waives waiting, not
 * proof of where the words go.
 */
function unbindable(title: string, entry: TerminalStatusEntry | undefined): string {
  if (entry === undefined || entry.error !== undefined) {
    return `${title} isn't reporting a status — the request wasn't sent`;
  }
  // A pane restored without its process: named separately because "isn't an
  // agent session" reads as the wrong thing being there, and nothing is.
  if (entry.hasPty === false || typeof entry.spawnedAt !== "number") {
    return `${title} has no session running — the request wasn't sent`;
  }
  return `${title} isn't an agent session — the request wasn't sent`;
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
    id: `request-${++nextRunId}`,
    ownerKey: options.ownerKey,
    onState: options.onState,
    state: { status: "sending" },
    title: options.destination.title,
    terminalId: null,
    forced: false,
    submitted: false,
  };
  const queue = queues.get(run.ownerKey);
  if (queue) queue.push(run);
  else queues.set(run.ownerKey, [run]);
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
  const { worktreeId, stillOwned, verify, buildPrompt, onDestination, settled } = options;
  let destination = options.destination;
  const { title } = destination;
  // An owner that closed, moved or switched off stops the run here, whether or
  // not any surface is mounted to notice.
  const current = () => {
    if (!isQueued(run)) return false;
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
    if (writing.get(run.terminalId ?? "") === run) writing.delete(run.terminalId ?? "");
    const unclean =
      isQueued(run) &&
      (run.state.status === "unconfirmed" ||
        (run.state.status === "failed" && run.state.partial === true));
    if (unclean) stopFollowers(run);
    dequeue(run);
    // Freed here rather than off the promise: a caller resuming from `await`
    // runs before a `.then` on the same promise would, and it must not be able
    // to rejoin the run it has just finished awaiting.
    run.releaseKey?.();
  }

  async function send(): Promise<void> {
    const fixedTerminal = () => (destination.kind === "launch" ? null : destination.terminalId);
    const head = () => queues.get(run.ownerKey)?.[0] === run;
    report({ status: head() ? "sending" : "queued" }, fixedTerminal());
    while (!head()) {
      await wait(QUEUE_POLL_MS);
      if (!current()) return;
    }
    // Asked now rather than when it was queued: the request ahead of this one
    // may have started the very session this one was meant for.
    if (options.resolveDestination) destination = options.resolveDestination();
    try {
      // A quick refusal for a request that can already be seen not to stand —
      // unless its subject is still being re-established, which is not a
      // verdict. The check that counts is the one before it is typed in.
      const problem =
        verify && (settled?.() ?? true) ? await bounded(verify(), "Checking the source") : null;
      if (problem) {
        report({ status: "failed", message: problem }, null);
        return;
      }
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

    /** A "ready" reading that may only be the prompt before this one not yet picked up. */
    const justSentTo = (): boolean => {
      const sent = lastSent.get(terminalId);
      return sent !== undefined && !sent.busySeen && Date.now() - sent.at < AFTER_SEND_SETTLE_MS;
    };
    const launchedAt = Date.now();
    let readyBy = Date.now() + LAUNCH_READY_TIMEOUT_MS;
    let firstCheck = true;
    let bound: DestinationIdentity | null = null;
    let prompt = "";
    // Until it is typed, a request can always go back to waiting: an agent that
    // picked something else up between the readiness that was proved and the
    // last look is a reason to wait again, not to lose the request.
    for (;;) {
      // Every destination gets the same check, new session or old: a trust,
      // approval or error prompt is also "waiting", and typed input would answer it.
      let ready = false;
      while (!ready && Date.now() < readyBy) {
        if (!firstCheck || destination.kind === "launch") await wait(LAUNCH_POLL_MS);
        firstCheck = false;
        if (!current()) return;
        const entry = await observe(terminalId);
        if (!current()) return;
        if (entry?.error) {
          report({ status: "failed", message: `${title} isn't running any more` }, terminalId);
          return;
        }
        // No readable status is no evidence of readiness; neither is a terminal
        // the detector hasn't classified. Both keep waiting — and the user may
        // say "send now", because a detector can stay silent.
        let readiness =
          entry === undefined ? "not-yet" : launchReadiness(entry.agentState, entry.waitingReason);
        // Only an agent seen doing something counts as having picked the last
        // request up. An unreadable status is not that, and neither is a question.
        const busy =
          entry !== undefined &&
          typeof entry.agentState === "string" &&
          BUSY_AGENT_STATES.has(entry.agentState);
        const sent = lastSent.get(terminalId);
        if (sent && busy) sent.busySeen = true;
        if (readiness === "ready" && justSentTo()) readiness = "not-yet";
        // An agent seen working is an agent that will be back at its prompt:
        // the wait is the queue doing its job, however long the work takes.
        // The clock runs while it is not — unreadable, finished, or asking.
        if (busy) readyBy = Date.now() + LAUNCH_READY_TIMEOUT_MS;
        // Bound at the first look that can name a session, not at the one that
        // proves readiness, and never rebound after (#12535). A request waiting
        // out an agent's work is a request for the session it was asked of; if
        // that one ends and another starts in the same pty while the wait runs,
        // binding at the prompt would quietly adopt the replacement, and so
        // would re-reading the identity on a loop re-entry. Both are the thing
        // the final check exists to refuse. A launch destination simply has no
        // identity to bind to yet, so it binds on the first look that does.
        const seen = identityOf(entry);
        if (bound === null) bound = seen;
        // Latched, not sampled twice. Once a look has named a different session
        // the run is over, however the slot reads later: a pty replayed under
        // the same id after a host crash starts its count again, so a session
        // that has already been seen to change can climb back to the numbers
        // the run bound to and match them (#12535). Only a look that *named* a
        // session counts against it — an unreadable one is no evidence, and
        // waiting through it is what the readiness loop is for.
        else if (seen !== null && !sameSession(bound, seen)) {
          report({ status: "failed", message: sessionChanged(title, seen) }, terminalId);
          return;
        }
        if (readiness === "ready" || run.forced) {
          if (bound === null) {
            report({ status: "failed", message: unbindable(title, entry) }, terminalId);
            return;
          }
          ready = true;
        } else if (readiness === "needs-you") report({ status: "needs-you" }, terminalId);
        // A session that is slow to start is a request that is waiting, and a
        // waiting request can be pushed on or taken out.
        else if (run.state.status !== "starting" || Date.now() - launchedAt > STARTING_SHOWN_MS) {
          report({ status: "queued" }, terminalId);
        }
      }
      if (!ready) {
        report({ status: "failed", message: `${title} didn't reach its prompt` }, terminalId);
        return;
      }

      while (writing.has(terminalId) && writing.get(terminalId) !== run) {
        await wait(QUEUE_POLL_MS);
        if (!current()) return;
      }
      writing.set(terminalId, run);

      // The request ahead of this one has usually just edited what this one is
      // about. The owner gets a bounded moment to re-establish that before the
      // request is held to it.
      const settleBy = Date.now() + SUBJECT_SETTLE_TIMEOUT_MS;
      while (settled && !settled() && Date.now() < settleBy) {
        await wait(QUEUE_POLL_MS);
        if (!current()) return;
      }

      try {
        let problem = verify ? await bounded(verify(), "Checking the source") : null;
        if (!current()) return;
        if (!problem) {
          // Built now, not when it was queued: the locations it names are read
          // from the source as it stands when the request goes in.
          prompt = await bounded(buildPrompt(), "Preparing the request");
          if (!current()) return;
          run.request = prompt;
          // And checked once more, because building is itself an await: what
          // the prompt says must still be true of what it was built from.
          problem = verify ? await bounded(verify("built"), "Checking the source") : null;
          if (!current()) return;
        }
        if (problem) {
          report({ status: "failed", message: problem }, terminalId);
          return;
        }
      } catch (error) {
        report(
          { status: "failed", message: formatErrorMessage(error, "Couldn't prepare the request") },
          terminalId
        );
        return;
      }

      // Everything above is an await, and the readiness proved before it is
      // now history. One last observation, read for both things it can tell
      // us: that this is still the session the run bound to, and that it is
      // still at a prompt. "Send now" reaches here too — it waives a readiness
      // *signal*, which is not permission to write into a different process.
      const lastLook = await observe(terminalId);
      if (!current()) return;
      const identity = identityOf(lastLook);
      if (bound === null || identity === null || !sameSession(bound, identity)) {
        report({ status: "failed", message: sessionChanged(title, identity) }, terminalId);
        return;
      }
      // Checked here, under the last await rather than over it: a destination
      // moved to another worktree while the observation was in flight keeps
      // both its identity and its readiness, and `terminal.sendCommand` does
      // not enforce the worktree the request was prepared for.
      if (!destinationStillEligible(terminalId, worktreeId)) {
        report(
          { status: "failed", message: `${title} left this worktree — the request wasn't sent` },
          terminalId
        );
        return;
      }
      const lastReadiness = launchReadiness(lastLook?.agentState, lastLook?.waitingReason);
      if (run.forced || (lastReadiness === "ready" && !justSentTo())) break;
      // Not at its prompt after all, or another owner's request has only just
      // gone in: back to waiting, with the terminal handed on.
      writing.delete(terminalId);
      report({ status: lastReadiness === "needs-you" ? "needs-you" : "queued" }, terminalId);
      readyBy = Math.max(readyBy, Date.now() + LAUNCH_POLL_MS * 2);
    }
    // Published before the write: a run cancelled mid-submit keeps its last
    // record, and that record must carry what was typed.
    report({ status: "sending" }, terminalId);
    run.submitted = true;
    for (const [id, sent] of lastSent) {
      if (Date.now() - sent.at > LAST_SENT_KEPT_MS) lastSent.delete(id);
    }
    lastSent.set(terminalId, { at: Date.now(), busySeen: false });
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
      // The spacing is from when the prompt reached the terminal, not from when
      // it was handed over: a long prompt takes a while to be written.
      if (state?.status === "sent") {
        const sent = lastSent.get(terminalId);
        if (sent && !sent.busySeen) sent.at = Date.now();
      }
    }
    report(state ?? { status: "unconfirmed" }, terminalId);
  }
}

export function __resetAgentRequestsForTests(): void {
  queues.clear();
  lastSent.clear();
  writing.clear();
  inFlight.clear();
}
