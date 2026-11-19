import { parsePartialSuccessMessage } from "../../../shared/utils/partialSuccess.js";

/** The code `ActionService` stamps for a thrown `PartialSuccessError`. */
const PARTIAL_SUCCESS_ERROR_CODE = "PARTIAL_SUCCESS";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";

/**
 * Server-authoritative record of which MCP session created which resource
 * (#11909).
 *
 * The problem it solves: `terminal.close` and `worktree.delete` take a
 * caller-supplied id, and `terminal.list` hands an external client every panel
 * in the view — the user's own shells and other sessions' agents included. So
 * "close the ones you opened" was not an invariant Daintree had, and the two
 * cleanup actions stayed off the external allowlist for want of one. This
 * ledger is that invariant: `terminal.closeOwned` and `worktree.deleteOwned`
 * act only on ids recorded here against the calling session.
 *
 * Three properties make it an authorization boundary rather than bookkeeping:
 *
 * 1. **Only trusted results write to it.** Entries come from the dispatch
 *    envelope a completed action returned, never from `spawnedBy`, tool
 *    arguments, or a later scan of the panel list. A caller cannot name a
 *    resource into its own ledger.
 * 2. **The most recent authoritative creation owns the id.** Resource ids are
 *    reusable: `agent.launch` accepts a `requestedId` that `addPanel` honours
 *    without a collision check, and worktree ids are filesystem paths that come
 *    back after a delete. So an older record for a live id is the stale one,
 *    and keeping it would be the dangerous choice — session A holding a record
 *    for a panel the user closed could otherwise close B's replacement panel
 *    under the same id. Re-recording moves the record instead. This is not a
 *    way to claim someone else's resource: the only way to reach it is to
 *    successfully create a resource under that id, which replaces whatever the
 *    id named before, so the authority always follows what actually exists.
 * 3. **It dies with the credential that earned it.** A session authenticated
 *    by an api key holds its records itself, and they are cleared by every
 *    teardown path in lockstep with the routing maps — see
 *    `SessionStore.clearSessionBinding` and `drain`. A session authenticated
 *    by a per-pane bearer (#12487) or a help-session bearer (#12993) is bound
 *    at handshake to that bearer's principal, and its records are held by the
 *    principal instead: a reconnect, an idle reap or a server restart replaces
 *    the session but not the bearer, so the pane or help session keeps
 *    authority over what it launched. The principal's
 *    records go when the bearer is revoked ({@link revokePrincipal}), never
 *    before. An Assistant's creations are the exception (#17919): main binds
 *    its principal to its conversation, which holds them for the bearer of
 *    the same conversation resumed, while the revoked bearer holds nothing.
 *    Clearing authority is not cleanup: the terminals and worktrees
 *    themselves stay exactly where they are, because a disconnect is not a
 *    decision to destroy the user's work.
 *
 * Recorded for every tier, not just `external`. "Owned" means *this session
 * created it*, which is a fact about the session rather than about its
 * privileges — tying the record to a tier would silently open a gap the day an
 * owned-cleanup tool is offered to another tier.
 */
export type OwnedResourceKind = "terminal" | "worktree";

const TERMINAL_KIND: OwnedResourceKind = "terminal";

export interface OwnedResourceDraft {
  kind: OwnedResourceKind;
  id: string;
}

export interface OwnedResourceRecord {
  kind: OwnedResourceKind;
  id: string;
  /**
   * The workspace the creating dispatch actually landed on, when the renderer
   * could resolve it (#11536). Advisory: panel ids are
   * `${kind}-${crypto.randomUUID()}` and worktree ids are absolute paths, so
   * cross-workspace collision is not a live risk and the ownership check does
   * not depend on this field. It backs a defence-in-depth mismatch check that
   * fails *open* when either side is unknown, so an unresolved workspace can
   * never strand a caller's own cleanup.
   */
  workspaceId?: string;
}

/**
 * A terminal an owner closed (#15728), recorded from the close's trusted
 * result. What lets the owner wait for its process to exit, and end its trash
 * grace early, after `terminal.closeOwned` released the creation record.
 */
export interface ClosedTerminalRecord {
  terminalId: string;
  /** The incarnation that was closed, when main knew it. */
  launchGeneration: number | undefined;
  /**
   * The workspace the close ran in, when known. One principal can hold
   * sessions bound to several projects, so ending the grace asks this
   * project's drive rule, not the asking session's.
   */
  workspaceId?: string;
  closedAt: number;
}

/** Long enough to wait out the trash grace and then some; a wait never extends it. */
export const CLOSED_TERMINAL_TTL_MS = 10 * 60 * 1000;
const CLOSED_TERMINALS_PER_OWNER = 256;

function resourceKey(kind: OwnedResourceKind, id: string): string {
  return `${kind}\u0000${id}`;
}

// NUL-led like `resourceKey`, so no session id — a server-minted UUID — can
// spell a principal's owner key and read or write its records.
const PRINCIPAL_OWNER_PREFIX = "principal\u0000";

/**
 * The owner key a principal's authority is held under. Exported so the
 * terminal adoption record (#12490) matches callers by the same value
 * {@link ResourceOwnershipLedger.ownerOf} resolves.
 */
export function principalOwnerKey(principalId: string): string {
  return `${PRINCIPAL_OWNER_PREFIX}${principalId}`;
}

/**
 * The principal a help-session bearer's resource ownership is held under
 * (#12993). Derived from the help-session id minted fresh at every provision,
 * so it is stable across the session's reconnects and never shared with a
 * successor. Namespaced so it can never spell a pane bearer's principal.
 */
export function helpOwnershipPrincipal(helpSessionId: string): string {
  return `help\u0000${helpSessionId}`;
}

/**
 * The principal a Shell's assistant holds what it makes here through
 * `host.call` under (#13493): the sender its Shell proved and that
 * assistant's own help session, so a dropped link or a new session keeps it.
 * Namespaced apart from this machine's own help and pane principals.
 */
export function relayOwnershipPrincipal(senderId: string, helpSessionId: string): string {
  return `relay\u0000${senderId}\u0000${helpSessionId}`;
}

function isPrincipalOwner(owner: string): boolean {
  return owner.startsWith(PRINCIPAL_OWNER_PREFIX);
}

// NUL-led like the principal prefix, and never bound to a session: no caller
// can present one, only main can bind a principal to it.
const CONVERSATION_OWNER_PREFIX = "conversation\u0000";

/**
 * Where a local Assistant's creations are held (#17919): its conversation, as
 * the ownership id main minted for its lane, so a resumed conversation's next
 * bearer holds what the last one made.
 */
export function helpConversationKey(conversationId: string): string {
  return `${CONVERSATION_OWNER_PREFIX}help\u0000${conversationId}`;
}

/**
 * Where a relayed assistant's creations are held (#17919): its conversation,
 * under the sender that proved it, so no other Shell can name its way in.
 */
export function relayConversationKey(senderId: string, conversationId: string): string {
  return `${CONVERSATION_OWNER_PREFIX}relay\u0000${senderId}\u0000${conversationId}`;
}

function isConversationOwner(owner: string): boolean {
  return owner.startsWith(CONVERSATION_OWNER_PREFIX);
}

/** The conversation a conversation key names, read back from a key main minted. */
export type OwnershipConversation =
  | { kind: "help"; conversationId: string }
  | { kind: "relay"; senderId: string; conversationId: string };

/** The conversation `owner` is the key of, or null for any other owner. */
export function conversationOf(owner: string): OwnershipConversation | null {
  if (!isConversationOwner(owner)) return null;
  const parts = owner.slice(CONVERSATION_OWNER_PREFIX.length).split("\u0000");
  if (parts[0] === "help" && parts.length === 2 && parts[1]) {
    return { kind: "help", conversationId: parts[1] };
  }
  if (parts[0] === "relay" && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: "relay", senderId: parts[1], conversationId: parts[2] };
  }
  return null;
}

/**
 * Told how creation records come and go (#16845), so what a conversation holds
 * can outlive the app. Every call is synchronous with the ledger write it
 * reports, and a throw is the observer's own: the ledger never depends on it.
 */
export interface OwnershipRecordObserver {
  /** A creation recorded `id` anew: nothing kept for it from before speaks for it now. */
  created(kind: OwnedResourceKind, id: string): void;
  /**
   * `holder` holds `record` now, newly recorded or moved there. Not `durable`
   * when its creation named its own id, which a restart can't tell apart from
   * a later pane under the same id.
   */
  held(holder: string, record: OwnedResourceRecord, durable: boolean): void;
  /** `holder` no longer holds `record`: released, evicted or replaced. */
  released(holder: string, record: OwnedResourceRecord): void;
  /** Whatever `holder` held is gone, including anything kept for it that is not loaded. */
  dropped(holder: string): void;
  /**
   * A pane no one records was created under `id`, in `workspaceId` when known:
   * whatever an earlier run kept for the id there no longer speaks for it.
   */
  superseded(kind: OwnedResourceKind, id: string, workspaceId: string | undefined): void;
}

/** A Daintree Assistant's principal, read back from the owner key its authority is held under. */
export type AssistantOwnershipPrincipal =
  | { kind: "help"; helpSessionId: string }
  | { kind: "relay"; senderId: string; helpSessionId: string };

/**
 * The assistant an owner key names, or null for anything else: a pane bearer,
 * an api-key session. Read only from keys main minted, so no caller can spell one.
 */
export function assistantPrincipalOf(owner: string): AssistantOwnershipPrincipal | null {
  if (!isPrincipalOwner(owner)) return null;
  const parts = owner.slice(PRINCIPAL_OWNER_PREFIX.length).split("\u0000");
  if (parts[0] === "help" && parts.length === 2 && parts[1]) {
    return { kind: "help", helpSessionId: parts[1] };
  }
  if (parts[0] === "relay" && parts.length === 3 && parts[1] && parts[2]) {
    return { kind: "relay", senderId: parts[1], helpSessionId: parts[2] };
  }
  return null;
}

/**
 * Records are held by an *owner*: a session's own id, or the principal a
 * per-pane bearer session was bound to at handshake. Callers resolve one with
 * {@link ResourceOwnershipLedger.ownerOf} and pass it to every read and write,
 * so a session that was never bound is its own owner and behaves exactly as
 * the session-scoped ledger always did.
 */
export class ResourceOwnershipLedger {
  /** owner → resourceKey → record. */
  private readonly byOwner = new Map<string, Map<string, OwnedResourceRecord>>();
  /** resourceKey → owner. The index that makes newest-creator-wins eviction O(1). */
  private readonly ownerByResource = new Map<string, string>();
  /** sessionId → principal owner key, for sessions a pane or help bearer authenticated. */
  private readonly principalBySession = new Map<string, string>();
  /**
   * Principal owner keys whose bearer has not been revoked. A principal id is
   * minted per bearer, and the handshake resolves it only from a live token, so
   * nothing binds a principal again once it has left this set.
   */
  private readonly livePrincipals = new Set<string>();
  /** owner → terminalId → what it closed, oldest first. */
  private readonly closedByOwner = new Map<string, Map<string, ClosedTerminalRecord>>();
  /**
   * Live principal owner key → the conversation its creations are held under
   * (#17919). Only creation records go there; what it closed, its hand-overs,
   * notices and grants stay its own. Dropped when the principal is revoked.
   */
  private readonly conversationByPrincipal = new Map<string, string>();
  /** Records whose creation named its own id (#16845): never kept past the app. */
  private readonly callerNamed = new WeakSet<OwnedResourceRecord>();
  /** Records an earlier run kept and this one gave back (#16845). */
  private readonly restored = new WeakSet<OwnedResourceRecord>();

  constructor(private readonly observer?: OwnershipRecordObserver) {}

  private notify(report: (observer: OwnershipRecordObserver) => void): void {
    if (this.observer === undefined) return;
    try {
      report(this.observer);
    } catch (err) {
      console.warn("[ResourceOwnership] An ownership observer failed:", err);
    }
  }

  /**
   * Bind a session to the principal its bearer resolved to at handshake
   * (#12487). Every session presenting the same bearer shares one set of
   * records, and each ledger operation is synchronous, so two of them cannot
   * interleave into disagreeing copies.
   */
  bindPrincipal(sessionId: string, principalId: string): void {
    const owner = principalOwnerKey(principalId);
    this.principalBySession.set(sessionId, owner);
    this.livePrincipals.add(owner);
  }

  /**
   * The owner a session's records are held under: its principal when a per-pane
   * bearer bound it, otherwise the session itself.
   *
   * Captured once when a call is admitted and used for the whole call, so a
   * creation that completes after the transport dropped still lands with the
   * principal the call was authorized under.
   */
  ownerOf(sessionId: string): string {
    return this.principalBySession.get(sessionId) ?? sessionId;
  }

  /** Whether `owner` is a bearer principal, whose records outlive any one session. */
  isPrincipalOwner(owner: string): boolean {
    return isPrincipalOwner(owner);
  }

  /**
   * Hold a live principal's creations under its conversation (#17919), as main
   * bound it: a help bearer to its lane's conversation, a relay principal to
   * the conversation its sender named. Every live principal bound to one
   * conversation holds its records, so a resumed conversation's bearer gets
   * back what the last one launched, and a revoked one reads nothing, since
   * revoking unbinds it. Anything the principal recorded before it was bound
   * moves with it. A revoked principal binds nothing.
   *
   * One conversation per principal: a bearer that goes on to run another (a
   * help session relaunched fresh onto a new PTY) holds what it makes from
   * then on itself, so neither conversation gets the other's work, nor a call
   * of the first that lands late.
   */
  attachConversation(principalId: string, conversationKey: string): void {
    const owner = principalOwnerKey(principalId);
    if (!this.livePrincipals.has(owner) || !isConversationOwner(conversationKey)) return;
    const current = this.conversationByPrincipal.get(owner);
    if (current === conversationKey || current === owner) return;
    if (current !== undefined) {
      // Pinned to itself: `holderOf` reads the principal's own key from now on.
      this.conversationByPrincipal.set(owner, owner);
      return;
    }
    this.moveRecords(owner, conversationKey);
    this.conversationByPrincipal.set(owner, conversationKey);
  }

  /**
   * Forget a conversation's creations (#17919): its lane started another or
   * was cleared, so nothing can resume it. Any principal still bound to it
   * holds what it records next under itself.
   */
  forgetConversation(conversationKey: string): void {
    if (!isConversationOwner(conversationKey)) return;
    for (const [owner, conversation] of [...this.conversationByPrincipal]) {
      if (conversation === conversationKey) this.conversationByPrincipal.delete(owner);
    }
    this.dropOwner(conversationKey);
  }

  /** Where `owner`'s creation records live: its conversation while bound to one, else itself. */
  private holderOf(owner: string): string {
    return this.conversationByPrincipal.get(owner) ?? owner;
  }

  private moveRecords(from: string, to: string): void {
    const owned = this.byOwner.get(from);
    if (owned === undefined) return;
    let target = this.byOwner.get(to);
    if (target === undefined) {
      target = new Map();
      this.byOwner.set(to, target);
    }
    for (const [key, record] of owned) {
      target.set(key, record);
      this.ownerByResource.set(key, to);
    }
    this.byOwner.delete(from);
    for (const record of owned.values()) {
      this.notify((observer) => observer.held(to, record, !this.callerNamed.has(record)));
    }
  }

  private isConversationBound(conversationKey: string): boolean {
    for (const conversation of this.conversationByPrincipal.values()) {
      if (conversation === conversationKey) return true;
    }
    return false;
  }

  /**
   * Attribute freshly created resources to an owner.
   *
   * A previous holder of the same id loses its record, because the id now names
   * something new — see the class note on why the newest creation wins. A
   * revoked principal records nothing: a creation admitted before its bearer was
   * revoked must not resurrect authority the revocation just took away. Returns
   * the records added.
   *
   * `callerNamedId` marks a creation whose caller chose the id (#16845): it
   * holds in this run as any other, but nothing keeps it past a restart.
   */
  record(
    owner: string,
    drafts: readonly OwnedResourceDraft[],
    workspaceId?: string,
    options?: { callerNamedId?: boolean }
  ): OwnedResourceRecord[] {
    if (drafts.length === 0) return [];
    if (isPrincipalOwner(owner) && !this.livePrincipals.has(owner)) {
      this.supersede(drafts);
      return [];
    }
    const holder = this.holderOf(owner);
    const added: OwnedResourceRecord[] = [];
    for (const draft of drafts) {
      if (draft.id.length === 0) continue;
      const key = resourceKey(draft.kind, draft.id);
      this.notify((observer) => observer.created(draft.kind, draft.id));
      const replaced =
        this.ownerByResource.get(key) === holder ? this.byOwner.get(holder)?.get(key) : undefined;
      if (replaced === undefined) this.evict(key);
      else this.notify((observer) => observer.released(holder, replaced));
      let owned = this.byOwner.get(holder);
      if (owned === undefined) {
        owned = new Map();
        this.byOwner.set(holder, owned);
      }
      const record: OwnedResourceRecord = {
        kind: draft.kind,
        id: draft.id,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      };
      if (options?.callerNamedId === true) this.callerNamed.add(record);
      owned.set(key, record);
      this.ownerByResource.set(key, holder);
      added.push(record);
      this.notify((observer) => observer.held(holder, record, options?.callerNamedId !== true));
    }
    return added;
  }

  /** A revoked bearer's creation: nothing for it, but the ids name something new. */
  private supersede(drafts: readonly OwnedResourceDraft[]): void {
    for (const draft of drafts) {
      if (draft.id.length === 0) continue;
      this.notify((observer) => observer.created(draft.kind, draft.id));
      this.evict(resourceKey(draft.kind, draft.id));
    }
  }

  /**
   * Panes were created under these ids with no one to record them for: one
   * whose session was gone when it landed, or a plugin's launch (#16845). A
   * record this run made stays, being of a pane at least as new; a record an
   * earlier run kept, given back or not, is of the pane the new one replaced,
   * so it goes. With `workspaceId`, only one kept for that workspace.
   */
  supersedeRestored(drafts: readonly OwnedResourceDraft[], workspaceId?: string): void {
    for (const draft of drafts) {
      if (draft.kind !== TERMINAL_KIND || draft.id.length === 0) continue;
      this.notify((observer) => observer.superseded(draft.kind, draft.id, workspaceId));
      const key = resourceKey(draft.kind, draft.id);
      const holder = this.ownerByResource.get(key);
      const record = holder === undefined ? undefined : this.byOwner.get(holder)?.get(key);
      if (
        record !== undefined &&
        this.restored.has(record) &&
        (workspaceId === undefined || record.workspaceId === workspaceId)
      ) {
        this.evict(key);
      }
    }
  }

  /**
   * Give a conversation back a creation record a restart kept (#16845), only
   * while nothing in this run holds a record for the id: any creation made
   * since is newer, and the newest creation wins. A fresh record, so nothing
   * compared by identity with an earlier run's can match it. Reports whether
   * it was given.
   */
  restoreIfUnclaimed(
    conversationKey: string,
    draft: OwnedResourceDraft,
    workspaceId: string
  ): boolean {
    if (conversationOf(conversationKey) === null || draft.id.length === 0) return false;
    const key = resourceKey(draft.kind, draft.id);
    if (this.ownerByResource.has(key)) return false;
    let owned = this.byOwner.get(conversationKey);
    if (owned === undefined) {
      owned = new Map();
      this.byOwner.set(conversationKey, owned);
    }
    const record: OwnedResourceRecord = { kind: draft.kind, id: draft.id, workspaceId };
    this.restored.add(record);
    owned.set(key, record);
    this.ownerByResource.set(key, conversationKey);
    return true;
  }

  /** Drop whatever record holds `key`, wherever it is held. */
  private evict(key: string): void {
    const holder = this.ownerByResource.get(key);
    if (holder === undefined) return;
    const owned = this.byOwner.get(holder);
    const record = owned?.get(key);
    owned?.delete(key);
    if (owned?.size === 0) this.byOwner.delete(holder);
    this.ownerByResource.delete(key);
    if (record !== undefined) this.notify((observer) => observer.released(holder, record));
  }

  /**
   * Note terminals this owner just closed, from the close's own result. A
   * revoked principal notes nothing, as it records nothing. Bounded per owner
   * and by age; the newest close of an id replaces an older one.
   */
  noteClosed(
    owner: string,
    closed: ReadonlyArray<{ terminalId: string; launchGeneration: number | undefined }>,
    workspaceId?: string,
    now: number = Date.now()
  ): void {
    if (closed.length === 0) return;
    if (isPrincipalOwner(owner) && !this.livePrincipals.has(owner)) return;
    let records = this.closedByOwner.get(owner);
    if (records === undefined) {
      records = new Map();
      this.closedByOwner.set(owner, records);
    }
    for (const { terminalId, launchGeneration } of closed) {
      if (terminalId.length === 0) continue;
      records.delete(terminalId);
      records.set(terminalId, {
        terminalId,
        launchGeneration,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        closedAt: now,
      });
    }
    this.pruneClosed(owner, now);
  }

  /** What this owner closed under `terminalId`, while the record lasts. */
  closedRecord(
    owner: string,
    terminalId: string,
    now: number = Date.now()
  ): ClosedTerminalRecord | undefined {
    this.pruneClosed(owner, now);
    return this.closedByOwner.get(owner)?.get(terminalId);
  }

  private pruneClosed(owner: string, now: number): void {
    const records = this.closedByOwner.get(owner);
    if (records === undefined) return;
    for (const [terminalId, record] of records) {
      if (
        now - record.closedAt < CLOSED_TERMINAL_TTL_MS &&
        records.size <= CLOSED_TERMINALS_PER_OWNER
      ) {
        break;
      }
      records.delete(terminalId);
    }
    if (records.size === 0) this.closedByOwner.delete(owner);
  }

  /**
   * The record this owner holds for a resource, or `undefined`.
   *
   * Fails closed on an unknown owner for the same reason
   * `SessionStore.getOrigin` defaults to `external`: a session that never
   * handshook, or one already half torn down, owns nothing.
   */
  get(owner: string, kind: OwnedResourceKind, id: string): OwnedResourceRecord | undefined {
    return this.byOwner.get(this.holderOf(owner))?.get(resourceKey(kind, id));
  }

  owns(owner: string, kind: OwnedResourceKind, id: string): boolean {
    return this.get(owner, kind, id) !== undefined;
  }

  /**
   * Whoever holds the record for a resource, if anyone. Read by the terminal
   * hand-over (#12490), which refuses to give a second pane a terminal another
   * one launched and can already drive.
   */
  creatorOf(kind: OwnedResourceKind, id: string): string | undefined {
    return this.ownerByResource.get(resourceKey(kind, id));
  }

  /** The record held for a resource, whoever holds it. Compared by identity with what a creation noted. */
  recordOf(kind: OwnedResourceKind, id: string): OwnedResourceRecord | undefined {
    const key = resourceKey(kind, id);
    const holder = this.ownerByResource.get(key);
    return holder === undefined ? undefined : this.byOwner.get(holder)?.get(key);
  }

  /**
   * The owner holding authority over a resource's record now: its holder, or
   * for a conversation's record the principal bound to it most recently, and
   * undefined while no live principal is (#17919). Display only.
   */
  controllerOf(kind: OwnedResourceKind, id: string): string | undefined {
    const holder = this.ownerByResource.get(resourceKey(kind, id));
    if (holder === undefined || !isConversationOwner(holder)) return holder;
    let controller: string | undefined;
    for (const [owner, conversation] of this.conversationByPrincipal) {
      if (conversation === holder) controller = owner;
    }
    return controller;
  }

  /**
   * Drop one record after its resource is gone.
   *
   * Called on a successful cleanup so a long-lived owner's ledger tracks what
   * still exists instead of growing for the life of the connection. Nothing
   * else prunes it: a terminal the *user* closed leaves a stale entry, which
   * costs two short strings and fails honestly at the delegated action ("no
   * panel with id …") rather than pretending to close something.
   *
   * With `expected`, only that record is dropped. Every creation writes a new
   * record, so a cleanup that finishes after the id was recorded again — by
   * another session on the same bearer — leaves the newer resource's record
   * alone. That very record goes wherever it is held, so a cleanup whose
   * bearer was revoked before it finished still takes it out of the
   * conversation that holds it (#17919).
   */
  release(
    owner: string,
    kind: OwnedResourceKind,
    id: string,
    expected?: OwnedResourceRecord
  ): void {
    const key = resourceKey(kind, id);
    const current = this.ownerByResource.get(key);
    const holder =
      expected !== undefined &&
      current !== undefined &&
      this.byOwner.get(current)?.get(key) === expected
        ? current
        : this.holderOf(owner);
    const owned = this.byOwner.get(holder);
    if (owned === undefined) return;
    const record = owned.get(key);
    if (record === undefined || (expected !== undefined && record !== expected)) return;
    owned.delete(key);
    if (owned.size === 0) this.byOwner.delete(holder);
    if (this.ownerByResource.get(key) === holder) this.ownerByResource.delete(key);
    this.notify((observer) => observer.released(holder, record));
  }

  /** Every resource this owner still holds authority over. */
  list(owner: string): OwnedResourceRecord[] {
    const owned = this.byOwner.get(this.holderOf(owner));
    return owned === undefined ? [] : [...owned.values()];
  }

  /**
   * End a session. Its own records go; a principal it was bound to keeps
   * everything, because the bearer that earned that authority is still live
   * and the next session to present it is the same pane. The resources
   * themselves are untouched — see the "clearing authority is not cleanup" note
   * on this class.
   */
  clearSession(sessionId: string): void {
    this.principalBySession.delete(sessionId);
    this.dropOwner(sessionId);
  }

  /**
   * Revoke a bearer's authority, in the same step as the bearer itself
   * (#12487). Sessions still bound to it stay bound to a principal that now
   * owns nothing and records nothing, so they fail closed until they end.
   *
   * A conversation it was bound to keeps its records for the conversation's
   * next bearer (#17919), unless `dropUnboundConversation` says this was its
   * last hold: a relay principal whose hold aged out or was crowded out, so
   * its conversation's records last no longer than the relay's own retention.
   */
  revokePrincipal(principalId: string, options?: { dropUnboundConversation?: boolean }): void {
    const owner = principalOwnerKey(principalId);
    this.livePrincipals.delete(owner);
    const conversation = this.conversationByPrincipal.get(owner);
    this.conversationByPrincipal.delete(owner);
    this.dropOwner(owner);
    if (
      conversation !== undefined &&
      conversation !== owner &&
      options?.dropUnboundConversation === true &&
      !this.isConversationBound(conversation)
    ) {
      this.dropOwner(conversation);
    }
  }

  /**
   * End every session at once, for `SessionStore.drain`. Principals keep their
   * records: stopping the server revokes no pane bearer, so a pane that
   * reconnects to the restarted server is still the pane that launched them.
   * Conversations keep theirs for the same reason.
   */
  clearAllSessions(): void {
    this.principalBySession.clear();
    for (const owner of [...this.byOwner.keys(), ...this.closedByOwner.keys()]) {
      if (!isPrincipalOwner(owner) && !isConversationOwner(owner)) this.dropOwner(owner);
    }
  }

  private dropOwner(owner: string): void {
    this.closedByOwner.delete(owner);
    const owned = this.byOwner.get(owner);
    if (owned !== undefined) {
      for (const key of owned.keys()) {
        if (this.ownerByResource.get(key) === owner) this.ownerByResource.delete(key);
      }
      this.byOwner.delete(owner);
    }
    // A conversation's kept records go with it, even ones no restore has handed back yet.
    if (isConversationOwner(owner)) this.notify((observer) => observer.dropped(owner));
  }
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * What each creation tool's *successful* result contributes to the ledger.
 *
 * Keyed by action id rather than sniffing result shapes, so adding a creation
 * path is a deliberate entry here and not something a lucky field name turns on
 * by accident. Every id listed is one a session that is not the assistant can
 * reach — on the external surface, or on a ladder tier through an agent pane's
 * bearer, whose terminal input is limited to what it created (#12407).
 *
 * `agent.launch` returns a `worktreeId`, and it is deliberately NOT recorded:
 * that field names the worktree the agent was launched *into*, which the
 * session did not create and has no authority to delete.
 */
const SUCCESS_EXTRACTORS: Record<
  string,
  (result: Record<string, unknown>) => OwnedResourceDraft[]
> = {
  "terminal.new": (result) => {
    const terminalId = readString(result, "terminalId");
    return terminalId === undefined ? [] : [{ kind: "terminal", id: terminalId }];
  },
  "agent.launch": (result) => {
    // `launched: false` pairs with `terminalId: null`, so the id check alone
    // is sufficient — but read the flag too, so a future result shape that
    // reports a failed launch beside a stale id cannot leak an attribution.
    if (result.launched === false) return [];
    const terminalId = readString(result, "terminalId");
    return terminalId === undefined ? [] : [{ kind: "terminal", id: terminalId }];
  },
  // Only a pane the call itself started (#16341). `existing` names a live pane
  // that already held the session: knowing a session id is no claim on it.
  "agent.resumeOwned": (result) => {
    if (result.status !== "launched") return [];
    const terminalId = readString(result, "terminalId");
    return terminalId === undefined ? [] : [{ kind: "terminal", id: terminalId }];
  },
  // Opens a panel on a ladder tier and hands its id back (#12407). Without it
  // a pane bearer that started work on an issue could not type into the
  // terminal it had just opened. The agent terminal only: the worktree it
  // creates and any recipe children are left unrecorded. Children come back as
  // a count that identifies nothing, and attributing the worktree would extend
  // owned-delete authority, which is a separate decision from terminal input.
  "workflow.startWorkOnIssue": (result) => {
    const terminalId = readString(result, "terminalId");
    return terminalId === undefined ? [] : [{ kind: "terminal", id: terminalId }];
  },
  "recipe.run": (result) =>
    readStringArray(result, "spawnedTerminalIds").map((id) => ({ kind: "terminal", id })),
  "worktree.createWithRecipe": (result) => {
    const drafts: OwnedResourceDraft[] = [];
    const worktreeId = readString(result, "worktreeId");
    if (worktreeId !== undefined) drafts.push({ kind: "worktree", id: worktreeId });
    for (const id of readStringArray(result, "spawnedTerminalIds")) {
      drafts.push({ kind: "terminal", id });
    }
    return drafts;
  },
};

/**
 * Composites that can fail *after* creating a worktree, and carry what already
 * exists in the structured `PARTIAL_SUCCESS:` payload.
 *
 * Attributing the half-created worktree is the whole point: a caller that
 * cannot clean up the mess its own failed call left is exactly the gap #11909
 * closes. Terminals are not read from the partial payload — the composite's
 * partial results report counts, and a count is not an id.
 */
const PARTIAL_FAILURE_TOOLS = new Set(["worktree.createWithRecipe"]);

export function extractOwnedResources(actionId: string, result: unknown): OwnedResourceDraft[] {
  const extract = SUCCESS_EXTRACTORS[actionId];
  if (extract === undefined) return [];
  const record = asRecord(result);
  return record === undefined ? [] : extract(record);
}

export function extractOwnedResourcesFromFailure(
  actionId: string,
  error: { code?: unknown; message?: unknown }
): OwnedResourceDraft[] {
  if (!PARTIAL_FAILURE_TOOLS.has(actionId)) return [];
  // Provenance before syntax. The code is stamped only for a thrown
  // `PartialSuccessError`, which nothing outside this repo can construct — and
  // that matters because the composite calls forge providers and git BEFORE the
  // worktree exists, and those failures rethrow the provider's own message
  // unchanged. Trusting the `PARTIAL_SUCCESS:` prefix alone would let a
  // provider that returned a suitably-shaped string mint an ownership record
  // for a worktree nothing ever created.
  if (error.code !== PARTIAL_SUCCESS_ERROR_CODE) return [];
  const payload = parsePartialSuccessMessage(error.message);
  if (payload === null) return [];
  const worktreeId = readString(payload.partialResult, "worktreeId");
  return worktreeId === undefined ? [] : [{ kind: "worktree", id: worktreeId }];
}

/**
 * Everything a completed dispatch contributes to the ledger, success or
 * partial failure. One entry point so the caller in `sessionServer` cannot
 * cover the `ok` leg and forget the other.
 */
export function extractOwnedResourcesFromDispatch(
  actionId: string,
  result: ActionDispatchResult
): OwnedResourceDraft[] {
  return result.ok
    ? extractOwnedResources(actionId, result.result)
    : extractOwnedResourcesFromFailure(actionId, result.error);
}

/** Action ids whose results feed the ledger — exported so tests can pin the set. */
export const OWNERSHIP_RECORDING_TOOLS: readonly string[] = Object.keys(SUCCESS_EXTRACTORS);
