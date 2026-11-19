import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import { AGENT_LAUNCH_ACTION_ID } from "../../../shared/utils/dispatchAgentLaunch.js";
import {
  conversationOf,
  helpConversationKey,
  relayConversationKey,
  type OwnedResourceDraft,
  type OwnedResourceKind,
  type OwnedResourceRecord,
  type OwnershipRecordObserver,
} from "./resourceOwnership.js";

/**
 * The panes an Assistant's conversation launched on this machine, kept on
 * disk so the conversation still owns them after an app restart (#16845).
 *
 * Only creation records, and only of this machine's own conversations: its
 * help sessions' and the in-process `host.call` relay's, whose conversation ids
 * the lane pointers keep. Another machine's assistant is held only for the
 * relay's in-memory retention, and adoptions, queued input and grants keep the
 * lifetimes they always had.
 *
 * A kept record comes back only for a pane the hydrate of the project it was
 * created in hands back to restore under the id it was launched with, while the
 * lane pointers loaded at startup still name its conversation, and never over a
 * record this run made. Every creation main sees under an id it keeps ends the
 * kept record, whoever made it: an MCP creation the ledger records or lets go,
 * a plugin's launch, and main never mints a short agent id it keeps. A pane put
 * in the trash ends it too. So the id is never someone else's pane by the time
 * it comes back. A creation whose caller chose its own id is never kept: a
 * restart can't tell that pane from a later one under the same id.
 */
export interface StoredAssistantPaneCreation {
  /** Whose conversation: a lane's help session, or this machine's own `host.call` relay. */
  readonly scope: "help" | "localRelay";
  /** The ownership id main gave the lane's conversation. */
  readonly conversationId: string;
  /** The project the creating dispatch landed in. */
  readonly projectId: string;
  /** When main last recorded the creation or gave it back after a restart. */
  readonly seenAt: number;
  /**
   * A relayed conversation's last call here, as far as main saw: an ended
   * relay caller's hold lasts a day from it, across a restart as within a run.
   */
  readonly lastCallAt?: number;
}

/** Where the records live between runs: the `assistantPaneCreations` store key in production. */
export interface AssistantPaneCreationPersistence {
  load(): unknown;
  save(records: Record<string, StoredAssistantPaneCreation>): void;
}

/** What a restored record is given back to: the MCP server's ownership ledger. */
export interface AssistantPaneCreationLedger {
  restoreIfUnclaimed(
    conversationKey: string,
    draft: OwnedResourceDraft,
    workspaceId: string
  ): boolean;
  supersede(drafts: readonly OwnedResourceDraft[]): void;
}

const TERMINAL: OwnedResourceKind = "terminal";

/** A kept record whose pane hasn't come back in this long is dropped. */
export const STORED_ASSISTANT_PANE_CREATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many kept records, the oldest dropped first. */
export const MAX_STORED_ASSISTANT_PANE_CREATIONS = 200;

/** How long an ended relay caller's hold outlasts its last call (`mcpRelayExecutor`). */
export const LOCAL_RELAY_CONVERSATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A relay call refreshes the kept time only once it has moved this far, to spare the disk. */
const LAST_CALL_WRITE_STEP_MS = 10 * 60 * 1000;

/** A loaded time this far past "now" is corrupt, not early. */
const FUTURE_SKEW_MS = 60_000;

const MAX_ID_LENGTH = 512;

let persistence: AssistantPaneCreationPersistence | null = null;
/** Keyed by terminal id. Mirrors what the ledger's conversations hold, plus what no restore has handed back yet. */
const stored = new Map<string, StoredAssistantPaneCreation>();
/** Terminal ids read from an earlier run's disk, not yet checked against the lane pointers that run left. */
const unchecked = new Set<string>();
let ledger: AssistantPaneCreationLedger | null = null;
/** Records a hydrate gave back before the ledger existed, handed over when it attaches. */
const waiting = new Map<string, StoredAssistantPaneCreation>();
let quitting = false;
let saveQueued = false;

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value <= now + FUTURE_SKEW_MS;
}

function readStoredRecord(
  terminalId: string,
  raw: unknown,
  now: number
): StoredAssistantPaneCreation | null {
  if (!isBoundedId(terminalId)) return null;
  if (raw === null || typeof raw !== "object") return null;
  const { scope, conversationId, projectId, seenAt, lastCallAt } = raw as Record<string, unknown>;
  if (scope !== "help" && scope !== "localRelay") return null;
  if (!isBoundedId(conversationId) || !isBoundedId(projectId)) return null;
  if (!isTime(seenAt, now) || seenAt < now - STORED_ASSISTANT_PANE_CREATION_TTL_MS) return null;
  if (scope === "localRelay") {
    if (!isTime(lastCallAt, now) || lastCallAt < now - LOCAL_RELAY_CONVERSATION_RETENTION_MS) {
      return null;
    }
    return { scope, conversationId, projectId, seenAt, lastCallAt };
  }
  return { scope, conversationId, projectId, seenAt };
}

function conversationKeyOf(record: StoredAssistantPaneCreation): string {
  return record.scope === "help"
    ? helpConversationKey(record.conversationId)
    : relayConversationKey(LOCAL_HOST_ID, record.conversationId);
}

function scopeOf(
  holder: string
): Pick<StoredAssistantPaneCreation, "scope" | "conversationId"> | null {
  const conversation = conversationOf(holder);
  if (conversation === null) return null;
  if (conversation.kind === "help") {
    return { scope: "help", conversationId: conversation.conversationId };
  }
  return conversation.senderId === LOCAL_HOST_ID
    ? { scope: "localRelay", conversationId: conversation.conversationId }
    : null;
}

function persistNow(): void {
  saveQueued = false;
  if (persistence === null) return;
  try {
    persistence.save(Object.fromEntries(stored));
  } catch (error) {
    console.warn("[assistantPaneCreations] Failed to save kept pane creations:", error);
  }
}

/** One write for every change one synchronous ledger operation makes. */
function persist(): void {
  if (persistence === null || saveQueued) return;
  saveQueued = true;
  queueMicrotask(persistNow);
}

/** Drop the oldest records past the cap. Reports whether any went. */
function capStored(): boolean {
  if (stored.size <= MAX_STORED_ASSISTANT_PANE_CREATIONS) return false;
  const oldestFirst = [...stored].sort(([, a], [, b]) => a.seenAt - b.seenAt);
  for (const [terminalId] of oldestFirst.slice(
    0,
    stored.size - MAX_STORED_ASSISTANT_PANE_CREATIONS
  )) {
    forgetRow(terminalId);
  }
  return true;
}

function forgetRow(terminalId: string): boolean {
  waiting.delete(terminalId);
  unchecked.delete(terminalId);
  return stored.delete(terminalId);
}

function forgetConversationRows(holder: string): boolean {
  let changed = false;
  for (const [terminalId, record] of [...stored]) {
    if (conversationKeyOf(record) === holder) changed = forgetRow(terminalId) || changed;
  }
  return changed;
}

/**
 * The ledger's half (#16845): every creation, and each record a conversation of
 * this machine's comes to hold or stops holding, reaches the disk. While the
 * app quits, nothing is let go: the teardown ending sessions, relay holds and
 * bearers is no decision about what a conversation launched, and a creation
 * that lands meanwhile is still kept.
 */
export const assistantPaneCreationObserver: OwnershipRecordObserver = {
  created(kind: OwnedResourceKind, id: string): void {
    if (kind !== TERMINAL || persistence === null) return;
    if (forgetRow(id)) persist();
  },
  held(holder: string, record: OwnedResourceRecord, durable: boolean): void {
    if (record.kind !== TERMINAL || persistence === null) return;
    // Anything kept for the id went when it was created; this only adds.
    const scope = durable && record.workspaceId !== undefined ? scopeOf(holder) : null;
    if (scope === null) return;
    const now = Date.now();
    const previous = stored.get(record.id);
    forgetRow(record.id);
    stored.set(record.id, {
      ...scope,
      projectId: record.workspaceId!,
      seenAt: now,
      ...(scope.scope === "localRelay"
        ? { lastCallAt: Math.max(now, previous?.lastCallAt ?? 0) }
        : {}),
    });
    capStored();
    persist();
  },
  released(holder: string, record: OwnedResourceRecord): void {
    if (record.kind !== TERMINAL || persistence === null || quitting) return;
    const kept = stored.get(record.id);
    if (kept === undefined || conversationKeyOf(kept) !== holder) return;
    forgetRow(record.id);
    persist();
  },
  dropped(holder: string): void {
    if (persistence === null || quitting) return;
    if (forgetConversationRows(holder)) persist();
  },
};

/**
 * Keep the records on disk from here on, loading what an earlier run left. The
 * first caller wins: the MCP server's start and a hydrate that has records to
 * hand back attach the same store, in whichever order they run.
 */
export function attachAssistantPaneCreationPersistence(
  target: AssistantPaneCreationPersistence
): void {
  if (persistence !== null) return;
  persistence = target;
  let raw: unknown;
  try {
    raw = target.load();
  } catch (error) {
    console.warn("[assistantPaneCreations] Failed to load kept pane creations:", error);
    raw = undefined;
  }
  const entries = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const now = Date.now();
  let pruned = false;
  for (const [terminalId, value] of Object.entries(entries as Record<string, unknown>)) {
    const record = readStoredRecord(terminalId, value, now);
    if (record === null) {
      pruned = true;
      continue;
    }
    stored.set(terminalId, record);
    unchecked.add(terminalId);
  }
  if (capStored() || pruned) persist();
}

/** Hand restored records to the ledger from now on, with any a hydrate already gave back. */
export function attachAssistantPaneCreationLedger(target: AssistantPaneCreationLedger): void {
  ledger = target;
  for (const [terminalId, record] of [...waiting]) {
    target.restoreIfUnclaimed(
      conversationKeyOf(record),
      { kind: "terminal", id: terminalId },
      record.projectId
    );
  }
  waiting.clear();
}

/**
 * Give back the kept records of the panes a hydrate of `projectId` hands to
 * restore under the ids they were launched with (#16845). `resumable` is the
 * conversations the lane pointers named when this run loaded them: a record
 * read from disk whose conversation none named can never be reached again, and
 * goes. A record made in this run is the ledger's already, so giving it back
 * changes nothing; one the ledger let go is gone from here too.
 */
export function admitRestoredAssistantPanes(
  projectId: string,
  paneIds: readonly string[],
  resumable: ReadonlySet<string>
): void {
  if (persistence === null || stored.size === 0 || quitting) return;
  let changed = false;
  for (const terminalId of [...unchecked]) {
    const record = stored.get(terminalId);
    if (record !== undefined && !resumable.has(record.conversationId)) {
      forgetRow(terminalId);
      changed = true;
    }
  }
  unchecked.clear();
  const now = Date.now();
  for (const terminalId of paneIds) {
    const record = stored.get(terminalId);
    if (record === undefined || record.projectId !== projectId) continue;
    if (
      record.scope === "localRelay" &&
      (record.lastCallAt ?? 0) < now - LOCAL_RELAY_CONVERSATION_RETENTION_MS
    ) {
      forgetRow(terminalId);
      changed = true;
      continue;
    }
    const seen = { ...record, seenAt: now };
    stored.set(terminalId, seen);
    changed = true;
    if (ledger === null) waiting.set(terminalId, seen);
    else {
      ledger.restoreIfUnclaimed(
        conversationKeyOf(seen),
        { kind: "terminal", id: terminalId },
        projectId
      );
    }
  }
  if (changed) persist();
}

/**
 * A pane main didn't record as an MCP creation took `terminalId` (a plugin's
 * launch): any record for the id, kept or given back, is about another pane.
 */
export function supersedeAssistantPane(terminalId: string): void {
  if (!isBoundedId(terminalId)) return;
  if (forgetRow(terminalId)) persist();
  ledger?.supersede([{ kind: "terminal", id: terminalId }]);
}

/**
 * A plugin's `agent.launch` started a pane, under an id it chose or not: no
 * record of an Assistant's names it any more (#16845).
 */
export function supersedeByPluginLaunch(actionId: string, result: ActionDispatchResult): void {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || !result.ok) return;
  const launched = result.result as { terminalId?: unknown } | null;
  const terminalId = launched?.terminalId;
  if (typeof terminalId === "string") supersedeAssistantPane(terminalId);
}

/** The person put the pane in the trash: no restart gives it back to anyone. */
export function forgetTrashedAssistantPane(terminalId: string): void {
  if (quitting) return;
  if (forgetRow(terminalId)) persist();
}

/** Whether a record is kept for `terminalId`, so main mints no new pane under it. */
export function isKeptAssistantPane(terminalId: string): boolean {
  return stored.has(terminalId);
}

/**
 * The local relay's conversations a restart kept panes for, each with its last
 * call here, for the relay to hold as an ended caller's until its day runs out.
 * Null until the records are loaded.
 */
export function keptLocalRelayConversations(): Array<{
  conversationId: string;
  usedAt: number;
}> | null {
  if (persistence === null) return null;
  const lastCall = new Map<string, number>();
  for (const record of stored.values()) {
    if (record.scope !== "localRelay") continue;
    const at = record.lastCallAt ?? record.seenAt;
    lastCall.set(record.conversationId, Math.max(at, lastCall.get(record.conversationId) ?? 0));
  }
  return [...lastCall].map(([conversationId, usedAt]) => ({ conversationId, usedAt }));
}

/** The local relay ran a call for `conversationId`: what it launched keeps its day from now. */
export function noteLocalRelayCall(conversationId: string, at: number = Date.now()): void {
  if (persistence === null || quitting) return;
  let changed = false;
  for (const [terminalId, record] of stored) {
    if (record.scope !== "localRelay" || record.conversationId !== conversationId) continue;
    if (at - (record.lastCallAt ?? 0) < LAST_CALL_WRITE_STEP_MS) continue;
    stored.set(terminalId, { ...record, lastCallAt: at });
    changed = true;
  }
  if (changed) persist();
}

/**
 * The app is quitting (#16845): from here on nothing kept is let go, so the
 * teardown's ending of sessions, relay holds and bearers leaves the records
 * for the next run. What is waiting to be written goes now.
 */
export function beginAssistantPaneCreationQuit(): void {
  quitting = true;
  if (saveQueued) persistNow();
}

export function _resetAssistantPaneCreationsForTests(): void {
  persistence = null;
  stored.clear();
  unchecked.clear();
  waiting.clear();
  ledger = null;
  quitting = false;
  saveQueued = false;
}
