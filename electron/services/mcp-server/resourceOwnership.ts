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
 *    by a per-pane bearer is bound at handshake to that bearer's principal
 *    (#12487), and its records are held by the principal instead: a reconnect,
 *    an idle reap or a server restart replaces the session but not the bearer,
 *    so the pane keeps authority over what it launched. The principal's
 *    records go when the bearer is revoked ({@link revokePrincipal}), never
 *    before. Clearing authority is not cleanup: the terminals and worktrees
 *    themselves stay exactly where they are, because a disconnect is not a
 *    decision to destroy the user's work.
 *
 * Recorded for every tier, not just `external`. "Owned" means *this session
 * created it*, which is a fact about the session rather than about its
 * privileges — tying the record to a tier would silently open a gap the day an
 * owned-cleanup tool is offered to another tier.
 */
export type OwnedResourceKind = "terminal" | "worktree";

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

function resourceKey(kind: OwnedResourceKind, id: string): string {
  return `${kind}\u0000${id}`;
}

// NUL-led like `resourceKey`, so no session id — a server-minted UUID — can
// spell a principal's owner key and read or write its records.
const PRINCIPAL_OWNER_PREFIX = "principal\u0000";

function principalOwnerKey(principalId: string): string {
  return `${PRINCIPAL_OWNER_PREFIX}${principalId}`;
}

function isPrincipalOwner(owner: string): boolean {
  return owner.startsWith(PRINCIPAL_OWNER_PREFIX);
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
  /** sessionId → principal owner key, for sessions a per-pane bearer authenticated. */
  private readonly principalBySession = new Map<string, string>();
  /**
   * Principal owner keys whose bearer has not been revoked. A principal id is
   * minted per bearer and never reused, so leaving this set is final.
   */
  private readonly livePrincipals = new Set<string>();

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
   * Attribute freshly created resources to an owner.
   *
   * A previous holder of the same id loses its record, because the id now names
   * something new — see the class note on why the newest creation wins. A
   * revoked principal records nothing: a creation admitted before its bearer was
   * revoked must not resurrect authority the revocation just took away. Returns
   * the records added.
   */
  record(
    owner: string,
    drafts: readonly OwnedResourceDraft[],
    workspaceId?: string
  ): OwnedResourceRecord[] {
    if (drafts.length === 0) return [];
    if (isPrincipalOwner(owner) && !this.livePrincipals.has(owner)) return [];
    const added: OwnedResourceRecord[] = [];
    for (const draft of drafts) {
      if (draft.id.length === 0) continue;
      const key = resourceKey(draft.kind, draft.id);
      const previousOwner = this.ownerByResource.get(key);
      if (previousOwner !== undefined && previousOwner !== owner) {
        const previous = this.byOwner.get(previousOwner);
        previous?.delete(key);
        if (previous?.size === 0) this.byOwner.delete(previousOwner);
      }
      let owned = this.byOwner.get(owner);
      if (owned === undefined) {
        owned = new Map();
        this.byOwner.set(owner, owned);
      }
      const record: OwnedResourceRecord = {
        kind: draft.kind,
        id: draft.id,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      };
      owned.set(key, record);
      this.ownerByResource.set(key, owner);
      added.push(record);
    }
    return added;
  }

  /**
   * The record this owner holds for a resource, or `undefined`.
   *
   * Fails closed on an unknown owner for the same reason
   * `SessionStore.getOrigin` defaults to `external`: a session that never
   * handshook, or one already half torn down, owns nothing.
   */
  get(owner: string, kind: OwnedResourceKind, id: string): OwnedResourceRecord | undefined {
    return this.byOwner.get(owner)?.get(resourceKey(kind, id));
  }

  owns(owner: string, kind: OwnedResourceKind, id: string): boolean {
    return this.get(owner, kind, id) !== undefined;
  }

  /**
   * Drop one record after its resource is gone.
   *
   * Called on a successful cleanup so a long-lived owner's ledger tracks what
   * still exists instead of growing for the life of the connection. Nothing
   * else prunes it: a terminal the *user* closed leaves a stale entry, which
   * costs two short strings and fails honestly at the delegated action ("no
   * panel with id …") rather than pretending to close something.
   */
  release(owner: string, kind: OwnedResourceKind, id: string): void {
    const key = resourceKey(kind, id);
    const owned = this.byOwner.get(owner);
    if (owned?.delete(key) !== true) return;
    if (owned.size === 0) this.byOwner.delete(owner);
    if (this.ownerByResource.get(key) === owner) this.ownerByResource.delete(key);
  }

  /** Every resource this owner still holds authority over. */
  list(owner: string): OwnedResourceRecord[] {
    const owned = this.byOwner.get(owner);
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
   */
  revokePrincipal(principalId: string): void {
    const owner = principalOwnerKey(principalId);
    this.livePrincipals.delete(owner);
    this.dropOwner(owner);
  }

  /**
   * End every session at once, for `SessionStore.drain`. Principals keep their
   * records: stopping the server revokes no pane bearer, so a pane that
   * reconnects to the restarted server is still the pane that launched them.
   */
  clearAllSessions(): void {
    this.principalBySession.clear();
    for (const owner of [...this.byOwner.keys()]) {
      if (!isPrincipalOwner(owner)) this.dropOwner(owner);
    }
  }

  private dropOwner(owner: string): void {
    const owned = this.byOwner.get(owner);
    if (owned === undefined) return;
    for (const key of owned.keys()) {
      if (this.ownerByResource.get(key) === owner) this.ownerByResource.delete(key);
    }
    this.byOwner.delete(owner);
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
  // Both open a panel on a ladder tier and hand its id back (#12407). Without
  // them a pane bearer that opened a shell or started work on an issue could
  // not type into the terminal it had just opened.
  "agent.terminal": (result) => {
    const terminalId = readString(result, "terminalId");
    return terminalId === undefined ? [] : [{ kind: "terminal", id: terminalId }];
  },
  // The agent terminal only. The worktree it creates and any recipe children
  // are left unrecorded: children come back as a count that identifies nothing,
  // and attributing the worktree would extend owned-delete authority, which is
  // a separate decision from terminal input.
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
