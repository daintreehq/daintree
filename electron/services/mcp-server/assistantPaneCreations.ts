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
  type ResourceOwnershipLedger,
} from "./resourceOwnership.js";
import type { TerminalAdoptionLedger } from "./terminalAdoption.js";

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
 * created in hands back to restore under the id it was launched with, still
 * stamped as launched the way that conversation launches (`spawnedBy`, which
 * main writes from the dispatching session, never the caller), while the lane
 * pointers loaded at startup name its conversation, and never over a record or
 * hand-over this run made. A pane main sees created under a kept id in a later
 * run ends the record: an MCP creation the ledger records or lets go, a
 * plugin's launch, and main never mints a short agent id it keeps. A pane put
 * in the trash ends it too. A creation whose caller chose its own id is never
 * kept: a restart can't tell that pane from a later one under the same id.
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
  supersedeRestored(drafts: readonly OwnedResourceDraft[], workspaceId?: string): void;
}

/** What a restored pane says launched it, by whose conversation kept it (`spawnSourceForMcpOrigin`). */
const SPAWNED_BY: Record<StoredAssistantPaneCreation["scope"], string> = {
  // Daintree's own assistant session.
  help: "assistant",
  // The relay admits this machine's own calls as `external` sessions.
  localRelay: "mcp",
};

const TERMINAL: OwnedResourceKind = "terminal";

/** A kept record whose pane hasn't come back in this long is dropped. */
export const STORED_ASSISTANT_PANE_CREATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many kept records, the oldest dropped first. */
export const MAX_STORED_ASSISTANT_PANE_CREATIONS = 200;

/** How long an ended relay caller's hold outlasts its last call (`mcpRelayExecutor`). */
export const LOCAL_RELAY_CONVERSATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A relay call reaches the disk only once its time has moved this far, to spare it; a quit writes the rest. */
const LAST_CALL_WRITE_STEP_MS = 10 * 60 * 1000;

/** Creations seen before the records load, remembered to apply to them. */
const MAX_PENDING_SUPERSEDES = 1024;

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
/** Terminal ids this run recorded itself, which a later creation main didn't record can't be newer than. */
const writtenThisRun = new Set<string>();
/** Each local relay conversation's last call here, exactly; the disk lags it by at most a write step. */
const relayLastCall = new Map<string, number>();
const relayLastWritten = new Map<string, number>();
/** Terminal id → what to drop once the records load: kept for one of these workspaces (null: any), or trashed. */
const pendingSupersedes = new Map<string, { workspaces: Set<string | null>; trashed: boolean }>();
/** Relay conversations remembered before the records load, the least recent going first past this. */
const MAX_EARLY_RELAY_CALLS = 256;
/** Each relay conversation's first call before the records load: whether it came back within its day. */
const relayEarlyFirst = new Map<string, number>();
let quitting = false;
let saveQueued = false;
/** The last write failed; the quit tries again. */
let saveFailed = false;

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
    return isTime(lastCallAt, now)
      ? { scope, conversationId, projectId, seenAt, lastCallAt }
      : null;
  }
  return { scope, conversationId, projectId, seenAt };
}

function relayDayRanOut(conversationId: string, now: number): boolean {
  return (relayLastCall.get(conversationId) ?? 0) < now - LOCAL_RELAY_CONVERSATION_RETENTION_MS;
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
  const records: Record<string, StoredAssistantPaneCreation> = {};
  const relayKept = new Set<string>();
  for (const [terminalId, record] of stored) {
    const lastCallAt =
      record.scope === "localRelay" ? relayLastCall.get(record.conversationId) : undefined;
    if (record.scope === "localRelay") relayKept.add(record.conversationId);
    records[terminalId] = lastCallAt !== undefined ? { ...record, lastCallAt } : record;
  }
  // A conversation with nothing kept needs no time held for it.
  for (const conversationId of [...relayLastCall.keys()]) {
    if (relayKept.has(conversationId)) continue;
    relayLastCall.delete(conversationId);
    relayLastWritten.delete(conversationId);
  }
  try {
    persistence.save(records);
  } catch (error) {
    saveFailed = true;
    console.warn("[assistantPaneCreations] Failed to save kept pane creations:", error);
    return;
  }
  saveFailed = false;
  for (const [conversationId, at] of relayLastCall) relayLastWritten.set(conversationId, at);
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
  writtenThisRun.delete(terminalId);
  return stored.delete(terminalId);
}

function rememberSupersede(terminalId: string, workspaceId: string | null, trashed: boolean): void {
  const earlier = pendingSupersedes.get(terminalId);
  pendingSupersedes.delete(terminalId);
  pendingSupersedes.set(terminalId, {
    workspaces: new Set([...(earlier?.workspaces ?? []), workspaceId]),
    trashed: trashed || earlier?.trashed === true,
  });
  if (pendingSupersedes.size <= MAX_PENDING_SUPERSEDES) return;
  // A trash outlasts a launch here: a launch's pane is told apart at hydrate by
  // who launched it, while a trashed pane brought back is the very pane.
  let oldest: string | undefined;
  for (const [id, entry] of pendingSupersedes) {
    if (!entry.trashed) {
      oldest = id;
      break;
    }
  }
  pendingSupersedes.delete(oldest ?? (pendingSupersedes.keys().next().value as string));
}

/**
 * A pane no one recorded was created under `terminalId`: a record an earlier
 * run kept for it, in that workspace when known, is of the pane it replaced.
 * One this run recorded is of a pane at least as new, and stays.
 */
function supersedeRow(terminalId: string, workspaceId: string | null | undefined): void {
  // A pane whose workspace isn't known could be anywhere: the hydrate tells it
  // apart by who launched it instead.
  if (!isBoundedId(terminalId) || workspaceId == null) return;
  if (persistence === null) {
    rememberSupersede(terminalId, workspaceId, false);
    return;
  }
  const record = stored.get(terminalId);
  if (record === undefined || writtenThisRun.has(terminalId)) return;
  if (record.projectId !== workspaceId) return;
  forgetRow(terminalId);
  persist();
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
    forgetRow(record.id);
    if (scope.scope === "localRelay") {
      // The relay call that made it is the conversation's latest.
      relayLastCall.set(
        scope.conversationId,
        Math.max(now, relayLastCall.get(scope.conversationId) ?? 0)
      );
    }
    stored.set(record.id, {
      ...scope,
      projectId: record.workspaceId!,
      seenAt: now,
      ...(scope.scope === "localRelay" ? { lastCallAt: now } : {}),
    });
    writtenThisRun.add(record.id);
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
  superseded(kind: OwnedResourceKind, id: string, workspaceId: string | undefined): void {
    if (kind === TERMINAL) supersedeRow(id, workspaceId);
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
    if (record.lastCallAt !== undefined) {
      // One time per conversation: the latest any of its records carries.
      relayLastWritten.set(
        record.conversationId,
        Math.max(record.lastCallAt, relayLastWritten.get(record.conversationId) ?? 0)
      );
    }
  }
  // A conversation's day is judged when it came back, as the relay judges a
  // resume: a call this run made before the load counts only if the first of
  // them came within the day of the last call on disk.
  const earlyLast = new Map(relayLastCall);
  relayLastCall.clear();
  for (const [conversationId, onDisk] of relayLastWritten) {
    const firstBack = relayEarlyFirst.get(conversationId);
    const cameBackInTime =
      firstBack !== undefined
        ? firstBack <= onDisk + LOCAL_RELAY_CONVERSATION_RETENTION_MS
        : onDisk >= now - LOCAL_RELAY_CONVERSATION_RETENTION_MS;
    const last = Math.max(onDisk, earlyLast.get(conversationId) ?? 0);
    if (cameBackInTime && last >= now - LOCAL_RELAY_CONVERSATION_RETENTION_MS) {
      relayLastCall.set(conversationId, last);
    }
  }
  relayEarlyFirst.clear();
  let relayAhead = false;
  for (const [terminalId, record] of [...stored]) {
    if (record.scope !== "localRelay") continue;
    const last = relayLastCall.get(record.conversationId);
    if (last === undefined) {
      forgetRow(terminalId);
      pruned = true;
    } else if (
      last - (relayLastWritten.get(record.conversationId) ?? 0) >=
      LAST_CALL_WRITE_STEP_MS
    ) {
      relayAhead = true;
    }
  }
  // What was created, or trashed, before this load still applies to what it read.
  for (const [terminalId, { workspaces, trashed }] of pendingSupersedes) {
    const record = stored.get(terminalId);
    if (record === undefined) continue;
    if (trashed || workspaces.has(null) || workspaces.has(record.projectId)) {
      forgetRow(terminalId);
      pruned = true;
    }
  }
  pendingSupersedes.clear();
  if (capStored() || pruned || relayAhead) persist();
}

/**
 * The MCP server's ledger as restores reach it: never over a terminal the
 * person handed to a pane, which would give it two drivers (#12490).
 */
export function assistantPaneCreationLedgerFor(
  ownership: Pick<ResourceOwnershipLedger, "restoreIfUnclaimed" | "supersedeRestored">,
  handOvers: Pick<TerminalAdoptionLedger, "holderOf">,
  liveProjectOf: (terminalId: string) => string | null = () => null
): AssistantPaneCreationLedger {
  return {
    // Nor while the id runs in another project, which makes restore give this
    // pane a new id: that run's own pane, not this record's.
    restoreIfUnclaimed: (conversationKey, draft, workspaceId) => {
      const live = liveProjectOf(draft.id);
      return (
        handOvers.holderOf(draft.id) === undefined &&
        (live === null || live === workspaceId) &&
        ownership.restoreIfUnclaimed(conversationKey, draft, workspaceId)
      );
    },
    supersedeRestored: (drafts, workspaceId) => ownership.supersedeRestored(drafts, workspaceId),
  };
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
  panes: ReadonlyArray<{ id: string; spawnedBy?: unknown }>,
  resumable: ReadonlySet<string>
): void {
  if (persistence === null || quitting) return;
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
  for (const { id: terminalId, spawnedBy } of panes) {
    const record = stored.get(terminalId);
    if (record === undefined || record.projectId !== projectId) {
      // Another surface's pane under an id given back in this project, though
      // no longer kept on disk: what was given back goes.
      if (spawnedBy !== SPAWNED_BY.help && spawnedBy !== SPAWNED_BY.localRelay) {
        ledger?.supersedeRestored([{ kind: TERMINAL, id: terminalId }], projectId);
      }
      continue;
    }
    // One this run recorded is newer than any snapshot of the id.
    if (writtenThisRun.has(terminalId)) continue;
    // Another surface's pane under the id, or a relay conversation whose day
    // ran out. Whatever was given back for it goes too.
    if (
      spawnedBy !== SPAWNED_BY[record.scope] ||
      (record.scope === "localRelay" && relayDayRanOut(record.conversationId, now))
    ) {
      forgetRow(terminalId);
      ledger?.supersedeRestored([{ kind: TERMINAL, id: terminalId }], projectId);
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
 * A pane main didn't record took `terminalId` (a plugin's launch), in
 * `workspaceId` when known: a record an earlier run kept for the id there, kept
 * or given back, is of the pane it replaced.
 */
export function supersedeAssistantPane(terminalId: string, workspaceId?: string | null): void {
  if (!isBoundedId(terminalId)) return;
  // Where the pane runs isn't known: whatever was given back for the id goes,
  // and the hydrate tells a pane kept on disk apart by who launched it.
  if (workspaceId == null) {
    ledger?.supersedeRestored([{ kind: TERMINAL, id: terminalId }]);
    return;
  }
  if (ledger !== null) {
    ledger.supersedeRestored([{ kind: TERMINAL, id: terminalId }], workspaceId ?? undefined);
  } else {
    supersedeRow(terminalId, workspaceId);
  }
}

/** A plugin's `agent.launch` started a pane in `workspaceId`, under an id it chose or not (#16845). */
export function supersedeByPluginLaunch(
  actionId: string,
  result: ActionDispatchResult,
  workspaceId?: string | null
): void {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || !result.ok) return;
  const launched = result.result as { terminalId?: unknown } | null;
  const terminalId = launched?.terminalId;
  if (typeof terminalId === "string") supersedeAssistantPane(terminalId, workspaceId);
}

/** The person put the pane in the trash: no restart gives it back to anyone. */
export function forgetTrashedAssistantPane(terminalId: string): void {
  if (quitting || !isBoundedId(terminalId)) return;
  if (persistence === null) {
    rememberSupersede(terminalId, null, true);
    return;
  }
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
  const kept = new Set<string>();
  for (const record of stored.values()) {
    if (record.scope === "localRelay") kept.add(record.conversationId);
  }
  return [...kept].map((conversationId) => ({
    conversationId,
    usedAt: relayLastCall.get(conversationId) ?? 0,
  }));
}

/**
 * The local relay ran, or finished, a call for `conversationId`: what it
 * launched keeps its day from `at`. Held exactly here; written once it has
 * moved a step since the last write, and by the quit.
 */
export function noteLocalRelayCall(conversationId: string, at: number = Date.now()): void {
  if (at <= (relayLastCall.get(conversationId) ?? 0)) return;
  if (persistence === null) {
    // Before the load: held so the load counts it, the least recent going first.
    relayLastCall.delete(conversationId);
    relayLastCall.set(conversationId, at);
    if (!relayEarlyFirst.has(conversationId)) relayEarlyFirst.set(conversationId, at);
    if (relayLastCall.size > MAX_EARLY_RELAY_CALLS) {
      const dropped = relayLastCall.keys().next().value as string;
      relayLastCall.delete(dropped);
      relayEarlyFirst.delete(dropped);
    }
    return;
  }
  let kept = false;
  for (const record of stored.values()) {
    if (record.scope === "localRelay" && record.conversationId === conversationId) {
      kept = true;
      break;
    }
  }
  if (!kept) return;
  relayLastCall.set(conversationId, at);
  // A quit writes at once: nothing after it would.
  if (quitting) persistNow();
  else if (at - (relayLastWritten.get(conversationId) ?? 0) >= LAST_CALL_WRITE_STEP_MS) persist();
}

/**
 * The app is quitting (#16845): from here on nothing kept is let go, so the
 * teardown's ending of sessions, relay holds and bearers leaves the records
 * for the next run. What is waiting to be written goes now.
 */
export function beginAssistantPaneCreationQuit(): void {
  quitting = true;
  const relayBehind = [...relayLastCall].some(
    ([conversationId, at]) => at > (relayLastWritten.get(conversationId) ?? 0)
  );
  if (saveQueued || saveFailed || (relayBehind && stored.size > 0)) persistNow();
}

export function _resetAssistantPaneCreationsForTests(): void {
  persistence = null;
  stored.clear();
  unchecked.clear();
  waiting.clear();
  writtenThisRun.clear();
  relayLastCall.clear();
  relayLastWritten.clear();
  relayEarlyFirst.clear();
  pendingSupersedes.clear();
  ledger = null;
  quitting = false;
  saveQueued = false;
  saveFailed = false;
}
