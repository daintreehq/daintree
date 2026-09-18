import {
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
  readComposerMemory,
  updateComposerMemory,
  type ComposerDelivery,
} from "./composerMemory.js";

export type RequestDestination = AgentRequestDestination;

/** "Send anyway": deliver the composer's pending request without a readiness signal. */
export function forceAgentRequest(memoryKey: string): void {
  forceHostAgentRequest(memoryKey);
}

/**
 * End every request still waiting for this preview's agent: the builder was
 * switched off, the preview removed or moved, or the plugin disabled. A session
 * that becomes ready afterwards must not receive a request nobody is watching.
 * Every worktree the preview has been in, hence the prefix — the owner key is
 * the composer's, which carries the worktree after the panel id.
 */
export function cancelAgentRequests(previewPanelId: string): void {
  cancelHostAgentRequests(`${previewPanelId}\n`);
}

/** The request belongs to this preview, in this worktree, with the builder on. */
function stillOwned(previewPanelId: string, worktreeId: string | null): boolean {
  const panel = usePanelStore.getState().panelsById[previewPanelId];
  if (!panel || panel.location === "trash") return false;
  if ((panel.worktreeId ?? null) !== worktreeId) return false;
  return useDevPreviewToolStore.getState().activeByPanel[previewPanelId] === BUILDER_TOOL_ID;
}

function sameDelivery(a: ComposerDelivery | null, b: ComposerDelivery): boolean {
  return (
    a !== null &&
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
  sentDraft,
  subjectKey,
}: {
  memoryKey: string;
  destination: RequestDestination;
  worktreeId: string | null;
  buildPrompt: () => Promise<string>;
  /** A reason the request may no longer go out, checked before building and before submitting. */
  verify?: () => Promise<string | null>;
  /** The draft as sent; cleared only if nothing new was typed meanwhile. */
  sentDraft: string;
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
  const onState = (delivery: AgentRequestDelivery) => {
    // The dedupe keeps a waiting state from rewriting the record on every poll;
    // it must not swallow the draft clear, which answers the state itself
    // rather than the write.
    if (!sameDelivery(readComposerMemory(memoryKey).delivery, delivery)) {
      updateComposerMemory(memoryKey, { delivery });
    }
    // Only the words that went out are cleared: anything typed while sending is
    // a new request and keeps its pin.
    if (delivery.state.status === "sent" && readComposerMemory(memoryKey).draft === sentDraft) {
      updateComposerMemory(memoryKey, { draft: "", pinned: null });
    }
  };
  return deliverHostAgentRequest({
    ownerKey: memoryKey,
    // The same words, about the same subject, to the same place, from the same
    // composer: a remount that sends again while the first run is in flight
    // joins it rather than typing the request into the agent twice.
    idempotencyKey: `${memoryKey}\n${destinationKey(destination)}\n${subjectKey ?? ""}\n${sentDraft}`,
    destination,
    worktreeId,
    stillOwned: () => stillOwned(previewPanelId, worktreeId),
    onState,
    buildPrompt,
    ...(verify ? { verify } : {}),
    // Point the composer at the new session — unless the user has already
    // picked something else while this one was starting.
    onDestination: (terminalId) => {
      if (destination.kind !== "launch") return;
      if (readComposerMemory(memoryKey).chosen === `launch:${destination.agentId}`) {
        updateComposerMemory(memoryKey, { chosen: `terminal:${terminalId}` });
      }
    },
  });
}
