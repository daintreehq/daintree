import {
  cancelAgentRequest as cancelHostAgentRequest,
  cancelAgentRequests as cancelHostAgentRequests,
  deliverAgentRequest as deliverHostAgentRequest,
  forceAgentRequest as forceHostAgentRequest,
  type AgentRequestDelivery,
  type AgentRequestDestination,
} from "@/services/agentRequests";
import { useDevPreviewToolStore } from "@/store/devPreviewToolStore";
import { usePanelStore } from "@/store/panelStore";
import { BUILDER_TOOL_ID } from "../shared/protocol.js";
import {
  putComposerDelivery,
  readComposerMemory,
  removeComposerDelivery,
  updateComposerMemory,
  type ComposerDelivery,
  type ComposerPin,
} from "./composerMemory.js";

export type RequestDestination = AgentRequestDestination;

/** "Send now": deliver the composer's next request without a readiness signal. */
export function forceAgentRequest(memoryKey: string, id: string): void {
  forceHostAgentRequest(memoryKey, id);
}

/**
 * Take a waiting request out of the queue, and its row with it — when it really
 * was still waiting. One that had already started going in is cancelled too,
 * but its row stays: it now says the delivery is unconfirmed, which is the
 * warning, and removing it would take the warning away with the request.
 */
export function removeAgentRequest(memoryKey: string, id: string): void {
  if (cancelHostAgentRequest(memoryKey, id) !== "submitted") removeComposerDelivery(memoryKey, id);
}

/**
 * The session a queued request's "new session" turned into. A second request
 * made while the first is still starting Claude means that Claude, not another.
 */
const launchedSessions = new Map<string, { terminalId: string; at: number }>();

/**
 * End every request still waiting for this preview's agent: the builder was
 * switched off, the preview removed or moved, or the plugin disabled. A session
 * that becomes ready afterwards must not receive a request nobody is watching.
 * Every worktree the preview has been in, hence the prefix — the owner key is
 * the composer's, which carries the worktree after the panel id.
 */
export function cancelAgentRequests(previewPanelId: string): void {
  cancelHostAgentRequests(`${previewPanelId}\n`);
  for (const key of [...launchedSessions.keys()]) {
    if (key.startsWith(`${previewPanelId}\n`)) launchedSessions.delete(key);
  }
}

/** The request belongs to this preview, in this worktree, with the builder on. */
function stillOwned(previewPanelId: string, worktreeId: string | null): boolean {
  const panel = usePanelStore.getState().panelsById[previewPanelId];
  if (!panel || panel.location === "trash") return false;
  if ((panel.worktreeId ?? null) !== worktreeId) return false;
  return useDevPreviewToolStore.getState().activeByPanel[previewPanelId] === BUILDER_TOOL_ID;
}

function sameDelivery(a: ComposerDelivery | undefined, b: AgentRequestDelivery): boolean {
  return (
    a !== undefined &&
    a.request === b.request &&
    a.title === b.title &&
    a.terminalId === b.terminalId &&
    JSON.stringify(a.state) === JSON.stringify(b.state)
  );
}

function destinationKey(destination: AgentRequestDestination): string {
  return destination.kind === "terminal"
    ? `terminal:${destination.terminalId}`
    : `launch:${destination.agentId}`;
}

/**
 * Hand one request to the host's delivery service and keep the preview's
 * composer memory in step with it. Everything generic — the launch, readiness,
 * ownership, submission and receipt — is the host's; what stays here is the
 * builder's own state: which destination the composer points at, and the draft
 * it may now clear.
 */
export function deliverAgentRequest({
  memoryKey,
  destination,
  worktreeId,
  buildPrompt,
  verify,
  settled,
  sentDraft,
  subject,
  subjectKey,
}: {
  memoryKey: string;
  destination: RequestDestination;
  worktreeId: string | null;
  buildPrompt: () => Promise<string>;
  /** A reason the request may no longer go out, checked before building and before submitting. */
  verify?: (after?: "built") => Promise<string | null>;
  /** Whether the subject has settled after an earlier request's edit; see the host's option. */
  settled?: () => boolean;
  /** The draft as sent; cleared only if nothing new was typed meanwhile. */
  sentDraft: string;
  /** What the request is about, kept on its row so it can be sent again. */
  subject?: ComposerPin;
  /**
   * Everything besides the words that decides what the prompt says — the
   * subject, the scope, the revisions it is held to. Part of the idempotency
   * key, so the same sentence about a different element is a different request.
   * The page's own place (route, versions) is read inside the run and so isn't
   * in the key: a call that joins a run in flight carries that run's reading,
   * which is seconds old at most.
   */
  subjectKey?: string;
}): Promise<void> {
  const previewPanelId = memoryKey.slice(0, memoryKey.indexOf("\n"));
  const launchKey = destination.kind === "launch" ? `${memoryKey}\n${destination.agentId}` : null;
  const madeAt = Date.now();
  let accepted = false;
  const onState = (delivery: AgentRequestDelivery) => {
    // The dedupe keeps a waiting state from rewriting the record on every poll.
    const known = readComposerMemory(memoryKey).deliveries.find((e) => e.id === delivery.id);
    if (!sameDelivery(known, delivery)) {
      putComposerDelivery(memoryKey, {
        ...delivery,
        instruction: sentDraft,
        subject: subject ?? null,
      });
    }
    // Accepted into the queue is what frees the composer for the next request:
    // waiting for "sent" would hold the words hostage to an agent that is busy,
    // which is exactly when the next request gets written. Only the words that
    // were sent are cleared; anything typed since is a new request and keeps
    // its pin. A request that fails keeps its words on its own row.
    if (!accepted) {
      accepted = true;
      if (readComposerMemory(memoryKey).draft === sentDraft) {
        updateComposerMemory(memoryKey, { draft: "", pinned: null });
      }
    }
  };
  const delivering = deliverHostAgentRequest({
    ownerKey: memoryKey,
    // The same words, about the same subject, to the same place, from the same
    // composer: a remount that sends again while the first run is in flight
    // joins it rather than typing the request into the agent twice. Without a
    // subject key the words alone cannot say the prompts would match, so no
    // key — a run of its own beats joining one about something else.
    ...(subjectKey === undefined
      ? {}
      : {
          idempotencyKey: `${memoryKey}\n${destinationKey(destination)}\n${subjectKey}\n${sentDraft}`,
        }),
    destination,
    // A request queued behind one that is starting this agent goes to the
    // session that one started, while it is still there to go to.
    resolveDestination: () => {
      const started = launchKey === null ? undefined : launchedSessions.get(launchKey);
      // Only a session started since this request was made: asking for a new
      // session after one exists is asking for another.
      if (!started || started.at < madeAt) return destination;
      const panel = usePanelStore.getState().panelsById[started.terminalId];
      if (!panel || panel.location === "trash") return destination;
      return { kind: "terminal", terminalId: started.terminalId, title: destination.title };
    },
    ...(settled ? { settled } : {}),
    worktreeId,
    stillOwned: () => stillOwned(previewPanelId, worktreeId),
    onState,
    buildPrompt,
    ...(verify ? { verify } : {}),
    // Point the composer at the new session — unless the user has already
    // picked something else while this one was starting.
    onDestination: (terminalId) => {
      if (destination.kind !== "launch") return;
      if (launchKey !== null) launchedSessions.set(launchKey, { terminalId, at: Date.now() });
      if (readComposerMemory(memoryKey).chosen === `launch:${destination.agentId}`) {
        updateComposerMemory(memoryKey, { chosen: `terminal:${terminalId}` });
      }
    },
  });
  // A call that joined a request already waiting gets no state of its own, and
  // the words it was made with are that request's words: the field is freed
  // for it all the same, or Send looks like it did nothing.
  if (!accepted && readComposerMemory(memoryKey).draft === sentDraft) {
    updateComposerMemory(memoryKey, { draft: "", pinned: null });
  }
  return delivering;
}
