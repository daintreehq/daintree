import type { TerminalStatusResult } from "@shared/types/terminalStatus";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionService } from "@/services/ActionService";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";
import { BUILDER_TOOL_ID } from "../shared/protocol.js";
import { deliveryFromPhase, launchReadiness, type DeliveryState } from "./agentTask.js";
import { readComposerMemory, updateComposerMemory } from "./composerMemory.js";

const DELIVERY_POLL_MS = 250;
const DELIVERY_TIMEOUT_MS = 10_000;
const LAUNCH_POLL_MS = 500;
/** A first launch can sit behind a login or an update; give it a real chance. */
const LAUNCH_READY_TIMEOUT_MS = 3 * 60_000;

export type RequestDestination =
  | { kind: "terminal"; terminalId: string; title: string }
  | { kind: "launch"; agentId: string; title: string };

/** Newest request per composer; an older one still running stops reporting. */
const latestRun = new Map<string, number>();
let runCounter = 0;
/** Runs the user told to go ahead without a readiness signal. */
const forced = new Set<number>();
/** Runs whose prompt has been handed to the terminal: cancelling can't take it back. */
const submitted = new Set<number>();
const UNKNOWN_READINESS_MS = 5_000;

/** "Send anyway": deliver the composer's pending request without a readiness signal. */
export function forceAgentRequest(memoryKey: string): void {
  const run = latestRun.get(memoryKey);
  if (run !== undefined) forced.add(run);
}

const IN_FLIGHT = new Set<DeliveryState["status"]>([
  "sending",
  "starting",
  "needs-you",
  "unknown-readiness",
]);

/** Stop one request and say truthfully where it got to. */
function cancelRun(memoryKey: string): void {
  const run = latestRun.get(memoryKey);
  if (run === undefined) return;
  latestRun.delete(memoryKey);
  const delivery = readComposerMemory(memoryKey).delivery;
  if (!delivery || !IN_FLIGHT.has(delivery.state.status)) return;
  updateComposerMemory(memoryKey, {
    delivery: {
      ...delivery,
      state: submitted.has(run)
        ? { status: "unconfirmed" }
        : { status: "failed", message: "Stopped before the request was sent" },
    },
  });
}

/**
 * End every request still waiting for this preview's agent: the builder was
 * switched off, the preview removed or moved, or the plugin disabled. A session
 * that becomes ready afterwards must not receive a request nobody is watching.
 */
export function cancelAgentRequests(previewPanelId: string): void {
  for (const key of [...latestRun.keys()]) {
    if (key.startsWith(`${previewPanelId}\n`)) cancelRun(key);
  }
}

/** The request belongs to this preview, in this worktree, with the builder on. */
function stillOwned(previewPanelId: string, worktreeId: string | null): boolean {
  const panel = usePanelStore.getState().panelsById[previewPanelId];
  if (!panel || panel.location === "trash") return false;
  if ((panel.worktreeId ?? null) !== worktreeId) return false;
  return useDevPreviewToolStore.getState().activeByPanel[previewPanelId] === BUILDER_TOOL_ID;
}

/**
 * The agent terminal is still somewhere this request may go: not trashed, and
 * in the preview's worktree. A terminal the host hasn't listed yet (a session
 * that is just starting) isn't evidence against it.
 */
function destinationStillEligible(terminalId: string, worktreeId: string | null): boolean {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return true;
  return panel.location !== "trash" && (panel.worktreeId ?? null) === worktreeId;
}

function sameDelivery(
  a: { state: DeliveryState; title: string; terminalId: string | null } | null,
  b: { state: DeliveryState; title: string; terminalId: string | null }
): boolean {
  return (
    a !== null &&
    a.title === b.title &&
    a.terminalId === b.terminalId &&
    JSON.stringify(a.state) === JSON.stringify(b.state)
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver one request to an agent and report what the host can prove about it
 * into the preview's composer memory. Runs independently of any component: the
 * grid re-lays — and remounts the builder — the moment a new agent opens.
 */
export async function deliverAgentRequest({
  memoryKey,
  destination,
  worktreeId,
  buildPrompt,
  verify,
  sentDraft,
}: {
  memoryKey: string;
  destination: RequestDestination;
  worktreeId: string | null;
  buildPrompt: () => Promise<string>;
  /** A reason the request may no longer go out, checked before building and before submitting. */
  verify?: () => Promise<string | null>;
  /** The draft as sent; cleared only if nothing new was typed meanwhile. */
  sentDraft: string;
}): Promise<void> {
  const run = ++runCounter;
  const previousRun = latestRun.get(memoryKey);
  if (previousRun !== undefined) forced.delete(previousRun);
  latestRun.set(memoryKey, run);
  const previewPanelId = memoryKey.slice(0, memoryKey.indexOf("\n"));
  // A preview moved to another worktree, closed or switched off stops the run
  // here, whether or not any builder surface is mounted to notice.
  const current = () => {
    if (latestRun.get(memoryKey) !== run) return false;
    if (stillOwned(previewPanelId, worktreeId)) return true;
    cancelRun(memoryKey);
    return false;
  };
  const { title } = destination;
  const report = (state: DeliveryState, terminalId: string | null) => {
    if (!current()) return;
    const next = { state, title, terminalId };
    if (sameDelivery(readComposerMemory(memoryKey).delivery, next)) return;
    updateComposerMemory(memoryKey, { delivery: next });
  };
  try {
    await deliver();
  } finally {
    forced.delete(run);
    submitted.delete(run);
    if (latestRun.get(memoryKey) === run) latestRun.delete(memoryKey);
  }

  async function deliver(): Promise<void> {
    report({ status: "sending" }, destination.kind === "terminal" ? destination.terminalId : null);
    let prompt: string;
    try {
      const problem = verify ? await verify() : null;
      if (problem) {
        report({ status: "failed", message: problem }, null);
        return;
      }
      prompt = await buildPrompt();
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
      // Point the composer at the new session — unless the user has already
      // picked something else while this one was starting.
      if (readComposerMemory(memoryKey).chosen === `launch:${destination.agentId}`) {
        updateComposerMemory(memoryKey, { chosen: `terminal:${terminalId}` });
      }
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
      if (readiness === "ready" || forced.has(run)) ready = true;
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
    submitted.add(run);
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
    state ??= { status: "unconfirmed" };
    report(state, terminalId);
    // Only the words that went out are cleared: anything typed while sending is
    // a new request and keeps its pin.
    if (state.status === "sent" && readComposerMemory(memoryKey).draft === sentDraft) {
      updateComposerMemory(memoryKey, { draft: "", pinned: null });
    }
  }
}
