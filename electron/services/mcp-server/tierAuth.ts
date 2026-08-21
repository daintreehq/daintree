import { createHash, timingSafeEqual } from "node:crypto";
import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import { deriveBand, BAND_OVERRIDES } from "../../../shared/utils/actionRiskBand.js";
import { toWireSchema } from "../../../shared/utils/mcpWireSchema.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import type { HelpTokenValidator } from "./shared.js";
import { type McpTier, TIER_ALLOWLISTS, minimumPermittingTier } from "./shared.js";
import {
  ACTIONS_LIST_DEFAULT_LIMIT,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
} from "../../../shared/config/mcpIntrospection.js";
import { canonicalJson, toCompatibilityShape } from "./compatibilityHash.js";
import type { McpTargetPolicy, McpTargetTier } from "../../../shared/types/mcpTargetPolicy.js";

export { deriveBand, BAND_OVERRIDES };

const BEARER_HEADER_PATTERN = /^Bearer[ \t]+(.+)$/i;

export function extractBearerToken(authHeader: string): string | null {
  const match = BEARER_HEADER_PATTERN.exec(authHeader);
  const token = match?.[1]?.replace(/^[ \t]+|[ \t]+$/g, "");
  return token ? token : null;
}

export function precomputeApiKeyBearerHash(apiKey: string | null): Buffer | null {
  if (!apiKey) return null;
  return createHash("sha256").update(`Bearer ${apiKey}`).digest();
}

export function isAuthorized(
  authHeader: string,
  apiKeyBearerHash: Buffer | null,
  helpTokenValidator: HelpTokenValidator | null
): boolean {
  if (apiKeyBearerHash) {
    const actualHash = createHash("sha256").update(authHeader).digest();
    if (
      apiKeyBearerHash.length === actualHash.length &&
      timingSafeEqual(actualHash, apiKeyBearerHash)
    ) {
      return true;
    }
  } else if (authHeader.length === 0) {
    return true;
  }

  const token = extractBearerToken(authHeader);
  if (token === null) return false;

  if (mcpPaneConfigService.isValidPaneToken(token)) return true;

  if (helpTokenValidator) {
    const tier = helpTokenValidator(token);
    if (tier) return true;
  }

  return false;
}

export function resolveTokenTier(
  authHeader: string,
  apiKeyBearerHash: Buffer | null,
  helpTokenValidator: HelpTokenValidator | null
): McpTier {
  if (apiKeyBearerHash) {
    const actualHash = createHash("sha256").update(authHeader).digest();
    if (
      apiKeyBearerHash.length === actualHash.length &&
      timingSafeEqual(actualHash, apiKeyBearerHash)
    ) {
      return "external";
    }
  } else if (authHeader.length === 0) {
    return "external";
  }

  const token = extractBearerToken(authHeader);
  if (token === null) return "workbench";

  const paneTier = mcpPaneConfigService.getTierForToken(token);
  if (paneTier === "workbench" || paneTier === "action" || paneTier === "system") {
    return paneTier;
  }
  if (helpTokenValidator) {
    const helpTier = helpTokenValidator(token);
    if (helpTier) return helpTier;
  }

  return "workbench";
}

/**
 * `tools/list` gate. The manifest-metadata exclusions are advertisement-only
 * filters layered on top of the tier floor; membership itself defers to
 * {@link isTierPermitted} so exposure and dispatch can never drift apart and
 * advertise a tool the dispatcher then rejects (#7155).
 *
 * Only two things withhold a tier-permitted tool from the listing, and both are
 * genuine ceilings rather than deferrals: `danger: "restricted"` (which
 * `ActionService.dispatch` rejects independently of tier) and
 * `mcpVisibility: "hidden"`. `mcpVisibility: "discoverable"` used to be a third,
 * on the theory that omitted tools stayed reachable through the meta-tools —
 * #11585 established that no shipped client can act on that, so withholding a
 * name is equivalent to revoking it. Tools we do not want an external caller to
 * reach are now cut from the tier allowlist itself, which revokes them honestly
 * at both gates.
 */
export function shouldExposeTool(
  entry: ActionManifestEntry,
  tier: McpTier,
  session: SessionSurfacePolicy = UNBOUND_SESSION_SURFACE
): boolean {
  if (entry.danger === "restricted") {
    return false;
  }
  if (entry.mcpVisibility === "hidden") {
    return false;
  }
  if (isWithheldFromBoundSession(entry, tier, session)) {
    return false;
  }
  return isTierPermitted(tier, entry.id);
}

/**
 * Whether this session routes every call to one workspace it was bound to at
 * handshake (#11789), rather than following window focus.
 */
export interface SessionSurfacePolicy {
  workspaceBound: boolean;
}

/** The default for every session that did not send a workspace selector. */
export const UNBOUND_SESSION_SURFACE: SessionSurfacePolicy = { workspaceBound: false };

/**
 * Whether a confirm-gated tool must be withheld from a workspace-bound external
 * session (#11789).
 *
 * A `danger: "confirm"` dispatch is only ever approved by a human in the target
 * renderer's native dialog, which gives up after 28s — inside main's 30s
 * dispatch timeout and the client's 60s request timeout. A session bound to a
 * background workspace has no one watching that view, and no arrangement holds
 * the call open long enough to go find someone. Presenting the dialog in some
 * *other* visible renderer was considered and rejected: it turns approval into a
 * cross-renderer trust boundary needing a one-use nonce bound to the session,
 * workspace generation, target and presenter ids, action id, args hash and
 * deadline, plus presenter re-election mid-dialog — a great deal of machinery to
 * buy back one tool.
 *
 * So the tool is withheld from the session's effective surface *and* refused
 * before dispatch, per the #6653 rule that confirmation is a pre-dispatch
 * protocol primitive rather than something a model is trusted to honour.
 *
 * Derived from the manifest's own `danger` rather than a hand-written id list,
 * so a future confirm-gated addition to `MCP_EXTERNAL_TIER_TOOLS` is covered the
 * day it lands — the drift a second curated allowlist would have guaranteed.
 *
 * Covers only what the manifest declares statically. Confirmation that is
 * elevated per-dispatch from the ARGUMENTS (#11860) is invisible here, because
 * discovery has no args to read; `sessionServer`'s bound-external guard refuses
 * those calls beside this one, where the args are in hand.
 *
 * Keyed on external tier AND bound, never on "this session has a renderer
 * route": the Daintree Assistant is pinned and carries `recipe.run` in its own
 * tier allowlist, so a blanket "routed sessions can't confirm" rule would
 * silently regress it.
 */
export function isWithheldFromBoundSession(
  entry: Pick<ActionManifestEntry, "danger">,
  tier: McpTier,
  session: SessionSurfacePolicy
): boolean {
  return session.workspaceBound && tier === "external" && entry.danger === "confirm";
}

/**
 * The exact allowlist {@link isTierPermitted} consults for a tier. Exposed as a
 * set so discovery filtering can enumerate the tier's surface instead of
 * probing it id-by-id; both callers share this one selector so the discovery
 * gate can never drift from the dispatch gate.
 */
export function getTierPermittedActionIds(tier: McpTier): ReadonlySet<string> {
  return TIER_ALLOWLISTS[tier];
}

export function isTierPermitted(tier: McpTier, actionId: string): boolean {
  return getTierPermittedActionIds(tier).has(actionId);
}

/**
 * The introspection tools whose results enumerate the action registry, and so
 * must be narrowed to the caller's effective surface (#11525). Discovery that
 * advertises ids the session cannot dispatch just trades a `TIER_NOT_PERMITTED`
 * round-trip for every pick the model makes.
 *
 * `actions.getContext` / `actions.persistedStores` never touch the registry —
 * there is nothing tier-shaped in their results to narrow.
 */
export const ACTIONS_LIST_TOOL_ID = "actions.list";
export const ACTIONS_SEARCH_TOOL_ID = "actions.search";
export const ACTIONS_GET_SCHEMA_TOOL_ID = "actions.getSchema";

export const INTROSPECTION_TOOL_IDS: ReadonlySet<string> = new Set([
  ACTIONS_LIST_TOOL_ID,
  ACTIONS_SEARCH_TOOL_ID,
  ACTIONS_GET_SCHEMA_TOOL_ID,
]);

export {
  ACTIONS_LIST_DEFAULT_LIMIT,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
};

/**
 * The page size an `actions.search` caller asked for, clamped to the tool's
 * contract. Returns null when the caller supplied a `limit` the renderer's own
 * validation will reject, so the over-fetch leaves those args untouched rather
 * than rewriting an out-of-contract request into a legal one.
 */
export function readSearchLimit(args: unknown): number | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return ACTIONS_SEARCH_DEFAULT_LIMIT;
  }
  const limit = (args as { limit?: unknown }).limit;
  if (limit === undefined) return ACTIONS_SEARCH_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit)) return null;
  if (limit < 1 || limit > ACTIONS_SEARCH_MAX_LIMIT) return null;
  return limit;
}

/**
 * The page window an `actions.list` caller asked for. Returns null when the
 * caller supplied bounds the renderer's own validation will reject, so the
 * handler leaves those args alone instead of rewriting an out-of-contract
 * request into a legal one.
 */
export function readListPaging(args: unknown): { offset: number; limit: number } | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { offset: 0, limit: ACTIONS_LIST_DEFAULT_LIMIT };
  }
  const { limit, offset } = args as { limit?: unknown; offset?: unknown };
  let resolvedLimit = ACTIONS_LIST_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return null;
    if (limit < 1 || limit > ACTIONS_LIST_MAX_LIMIT) return null;
    resolvedLimit = limit;
  }
  let resolvedOffset = 0;
  if (offset !== undefined) {
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
    resolvedOffset = offset;
  }
  return { offset: resolvedOffset, limit: resolvedLimit };
}

/**
 * Read a manifest entry's id from an untyped result payload. The introspection
 * result schemas declare their entries permissively — `z.unknown()` for the
 * list/search arrays, an open record for `getSchema` — so main re-narrows rather
 * than trusting the renderer's shape.
 */
function readEntryId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/**
 * Whether a discovered manifest entry may be surfaced to a session holding
 * `permittedActionIds`. The `hidden` / `restricted` ceilings are re-applied
 * here even though the renderer already enforces them: this is the host-side
 * authorization boundary, and it does not take the renderer's word for it.
 *
 * This narrows introspection results to the session's *effective* surface, so
 * `actions.search` / `actions.getSchema` describe tools the caller can actually
 * dispatch. It is not a progressive-disclosure escape hatch: since #11585 the
 * tier allowlist is the whole surface, and introspection reports it rather than
 * reaching past it.
 */
function isIntrospectableForSession(
  entry: unknown,
  permittedActionIds: ReadonlySet<string>
): boolean {
  const id = readEntryId(entry);
  if (id === null) return false;
  const record = entry as { mcpVisibility?: unknown; danger?: unknown };
  if (record.mcpVisibility === "hidden") return false;
  if (record.danger === "restricted") return false;
  return permittedActionIds.has(id);
}

/**
 * Shape version of the `actions.getSchema` policy record (#11910). Bump by hand
 * when a field is added, removed, or given new meaning — never for a change in
 * what one target's policy evaluates to, which is what the per-target hash is
 * for.
 *
 * Lives here rather than beside the payload types in `shared/` for the same
 * reason {@link MCP_SURFACE_MANIFEST_VERSION} does: main is the only process
 * that stamps it, so the shared module stays a type-only import from here and
 * its `zod` value import never becomes an eager edge on main's boot path.
 */
export const MCP_TARGET_POLICY_VERSION = 1;

/**
 * The session facts a target policy is evaluated against, captured once at
 * dispatch start so every field of one record describes the same instant.
 *
 * Passed in rather than read here so this module stays pure and testable
 * without a session store, matching {@link filterIntrospectionResultForSession}.
 */
export interface TargetPolicySessionSnapshot {
  /** The tier the session was admitted at. */
  tier: McpTier;
  /**
   * Whether this session's ORIGIN can hold grants at all —
   * `sessionStore.isRendererOwnedOrigin`.
   *
   * Not derivable from {@link tier}, which is why it is threaded rather than
   * inferred. `resolveTokenTier` falls back to `workbench` for any bearer token
   * it does not recognise, while `getOrigin` defaults an unknown session to
   * `external`, so a session can hold a ladder tier and a non-renderer origin at
   * once. Grant issuance gates on the origin (`issueGrant` /
   * `issueNativeGrant` both refuse a session that is not renderer-owned), so
   * reporting grantability off the tier would promise an api-key client an
   * approval flow it can never reach.
   */
  rendererOwnedOrigin: boolean;
  /** Live per-tool grants, from the non-evicting snapshot. */
  perToolGrantedActionIds: ReadonlySet<string>;
  /** Live native automation grants' `allowedTools`, unioned. */
  nativeGrantedActionIds: ReadonlySet<string>;
}

/** The `recipeId` argument that elevates a safe dispatch to confirm (#11860). */
const RECIPE_ID_ARG = "recipeId";

/**
 * Whether this target's own arguments can raise it from `safe` to
 * confirmation-gated.
 *
 * Read off the declared input schema rather than an action allowlist, mirroring
 * `resolveEffectiveActionDanger`, which keys the elevation on the ARGUMENT for
 * exactly that reason: an allowlist would need updating for every future
 * composite and would silently under-gate the one someone forgets. A target that
 * cannot accept a `recipeId` can never be elevated by one.
 */
function acceptsRecipeId(inputSchema: unknown): boolean {
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return false;
  }
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return false;
  }
  return RECIPE_ID_ARG in (properties as Record<string, unknown>);
}

/**
 * The authoritative policy record for one already-authorized target (#11910).
 *
 * Returns `null` — never a partial record — for anything it cannot describe
 * truthfully: a malformed entry, a danger outside the two callable values, or a
 * target whose tier membership it cannot establish. The caller collapses that
 * onto the same `NOT_FOUND` an unknown id returns, so missing or malformed
 * policy metadata fails closed rather than shipping a record a client would
 * trust.
 *
 * Only ever called for an id that has already passed
 * {@link isIntrospectableForSession}, so `null` here is a fail-closed backstop
 * rather than the ordinary denial path.
 */
export function buildTargetPolicy(
  entry: unknown,
  snapshot: TargetPolicySessionSnapshot
): McpTargetPolicy | null {
  const id = readEntryId(entry);
  if (id === null) return null;
  const record = entry as Partial<ActionManifestEntry>;

  // `restricted` and `hidden` are already refused upstream; re-checking here
  // keeps this function safe to call on its own and makes the fail-closed
  // contract local rather than inherited.
  if (record.mcpVisibility === "hidden") return null;
  const danger = record.danger;
  if (danger !== "safe" && danger !== "confirm") return null;
  const kind = record.kind;
  if (kind !== "command" && kind !== "query") return null;

  // Grants only count where the origin can hold them. In practice an external
  // session never has any — both issuance paths refuse a non-renderer-owned
  // origin — so this is belt-and-braces against a stale entry outliving the
  // origin that minted it, and it keeps the reported authorization identical to
  // the one the dispatch gate would reach.
  const grantsReachable = snapshot.rendererOwnedOrigin;
  const perToolGranted = grantsReachable && snapshot.perToolGrantedActionIds.has(id);
  const nativeGranted = grantsReachable && snapshot.nativeGrantedActionIds.has(id);

  // The caller's own ladder, never a rung it cannot climb. An external
  // allowlist is a flat peer of the in-app ladder, so `minimumPermittingTier` —
  // which answers "how far would an in-app session have to elevate" — reports
  // either a rung this caller can never reach or nothing at all for a tool that
  // is external-only.
  const minimumTier: McpTargetTier | null =
    snapshot.tier === "external"
      ? TIER_ALLOWLISTS.external.has(id)
        ? "external"
        : null
      : minimumPermittingTier(id);
  // A ladder target with no permitting tier cannot be described honestly, and
  // cannot legitimately be granted either: both issuance paths refuse a tool
  // `minimumPermittingTier` does not place. Fail closed.
  if (minimumTier === null) return null;

  // Resolved in the dispatch gate's own order — static floor, then per-tool
  // grant, then native grant — so a client reading this learns which mechanism
  // would actually admit its next call, and therefore whether that access can
  // lapse.
  const authorizedBy = TIER_ALLOWLISTS[snapshot.tier].has(id)
    ? "tier"
    : perToolGranted
      ? "grant"
      : nativeGranted
        ? "nativeGrant"
        : null;
  if (authorizedBy === null) return null;

  // Strict rather than `!== false`: a malformed `enabled` (absent, or the
  // string "false") would otherwise be reported as callable, which is the one
  // direction this record must never guess in.
  if (typeof record.enabled !== "boolean") return null;
  const callable = record.enabled;
  const annotations = buildAnnotations(record as ActionManifestEntry);
  const confirmationMayEscalate = danger === "safe" && acceptsRecipeId(record.inputSchema);

  // The digest covers only what a caller's own code is built against. Live
  // session state is deliberately absent: `callable`, `effectiveTier`,
  // `requiresConfirmation`, `authorizedBy` and `grantable` all move as grants
  // come and go, and a hash that flapped on a timer would describe a target no
  // lookup ever returned. `grantable` is additionally redundant — it is fully
  // determined by `minimumTier` plus the caller's own class.
  //
  // Descriptions are excluded here and inside the schemas, matching
  // `buildSurfaceManifest`: they are model-facing prose that is reworded often,
  // and a compatibility check that cried drift on every wording edit is one
  // clients would learn to ignore.
  //
  // Both schemas are hashed as the LOOKUP HANDS THEM OVER — `entry.inputSchema`
  // and `entry.outputSchema`, unprojected. This diverges from
  // `buildSurfaceManifest`, deliberately: that digest describes `tools/list`, so
  // it hashes `buildToolOutputSchema`, the advertised view. This one accompanies
  // the entry itself, and `buildToolOutputSchema` collapses every schema without
  // a top-level `type: "object"` to nothing — so hashing that view would let a
  // top-level union change its variants, in a field the caller can read right
  // there in the payload, without moving the digest.
  //
  // JSON.stringify throws on a cycle or a BigInt, and a manifest entry is only
  // as well-formed as whatever built it. Fail closed on that rather than letting
  // it escape as a tool-call exception.
  let hash: string;
  try {
    hash = createHash("sha256")
      .update(
        canonicalJson({
          policyVersion: MCP_TARGET_POLICY_VERSION,
          id,
          kind,
          minimumTier,
          danger,
          confirmationMayEscalate,
          dynamicInvocation: "allowed",
          preferredTool: null,
          readOnlyHint: annotations.readOnlyHint ?? null,
          idempotentHint: annotations.idempotentHint ?? null,
          destructiveHint: annotations.destructiveHint ?? null,
          openWorldHint: annotations.openWorldHint ?? null,
          deprecated: record.deprecated ?? null,
          inputSchema: toCompatibilityShape(record.inputSchema ?? null),
          outputSchema: toCompatibilityShape(record.outputSchema ?? null),
        })
      )
      .digest("hex");
  } catch {
    return null;
  }

  return {
    version: MCP_TARGET_POLICY_VERSION,
    hash,
    callable,
    unavailableReason: callable ? null : "DISABLED",
    minimumTier,
    effectiveTier: snapshot.tier,
    danger,
    // A native grant is an explicit user approval of the tool's scope, so it
    // pre-authorises the modal (`dispatchConfirmed` in `sessionServer`). A
    // per-tool grant only widens the floor and never bypasses confirmation.
    requiresConfirmation: danger === "confirm" && !nativeGranted,
    confirmationMayEscalate,
    // Exactly the two checks `issueGrant` enforces, minus the runtime
    // caller-pin: the origin must be able to hold a grant, and the tool must be
    // one some non-external tier already permits.
    grantable: grantsReachable && minimumPermittingTier(id) !== null,
    authorizedBy,
    dynamicInvocation: "allowed",
    preferredTool: null,
  };
}

/**
 * Narrow an introspection tool's result to the ids the calling session can
 * actually dispatch. Pure: takes one immutable permission snapshot, returns a
 * new payload, and never reads the session store or the grant cache.
 *
 * `permittedActionIds` is the session's *effective* surface — its static tier
 * allowlist widened by any live grants — so a tool the user has approved stays
 * discoverable for as long as the approval lasts.
 */
export function filterIntrospectionResultForSession(
  actionId: string,
  result: ActionDispatchResult,
  permittedActionIds: ReadonlySet<string>,
  options: {
    callerLimit: number;
    requestedActionId?: string;
    listPaging?: { offset: number; limit: number };
    /**
     * The session facts `actions.getSchema`'s policy record is built from
     * (#11910). Absent means no policy can be built, and a schema read without
     * one collapses to `NOT_FOUND` — the same fail-closed direction a malformed
     * entry takes, so a caller can never receive an entry whose policy is
     * silently missing.
     */
    policySnapshot?: TargetPolicySessionSnapshot;
  }
): ActionDispatchResult {
  if (!result.ok) return result;

  // Every branch below rebuilds the payload from scratch rather than spreading
  // the renderer's, and treats an unrecognised shape as a denial. Nothing
  // validates these payloads at runtime — not the IPC bridge, not
  // `ActionService.dispatch` — so passing an unexpected shape through would
  // hand back an unfiltered result, and spreading would forward any extra
  // field the renderer attached alongside the one being filtered.
  if (actionId === ACTIONS_LIST_TOOL_ID) {
    const payload = result.result as { actions?: unknown } | null | undefined;
    const entries = Array.isArray(payload?.actions) ? payload.actions : [];
    const permitted = entries.filter((entry) =>
      isIntrospectableForSession(entry, permittedActionIds)
    );
    // `entries` is the COMPLETE match set — the handler walked every renderer
    // page before calling this. Paging the permitted set here (rather than
    // filtering a page the renderer already cut) is what keeps `total` and
    // `hasMore` describing the surface the caller can actually reach: a page
    // sliced before the tier filter would come back short, and its `total`
    // would count actions this session can never dispatch (#11529 + #11525).
    const { offset, limit } = options.listPaging ?? {
      offset: 0,
      limit: ACTIONS_LIST_DEFAULT_LIMIT,
    };
    return {
      ok: true,
      result: {
        actions: permitted.slice(offset, offset + limit),
        total: permitted.length,
        limit,
        offset,
        hasMore: offset + limit < permitted.length,
      },
    };
  }

  if (actionId === ACTIONS_SEARCH_TOOL_ID) {
    const payload = result.result as { results?: unknown } | null | undefined;
    const entries = Array.isArray(payload?.results) ? payload.results : [];
    const permitted = entries.filter((entry) =>
      isIntrospectableForSession(entry, permittedActionIds)
    );
    // `totalMatches` counts the permitted matches main actually saw. The
    // handler over-fetches to ACTIONS_SEARCH_MAX_LIMIT so that window is the
    // complete match set for any query matching at most that many actions —
    // the common case, where this count is exact. A broader query truncates
    // the window and the count becomes a lower bound, which is the safe
    // direction: discovery never advertises more surface than it can show.
    return {
      ok: true,
      result: {
        totalMatches: permitted.length,
        results: permitted.slice(0, options.callerLimit),
      },
    };
  }

  if (actionId === ACTIONS_GET_SCHEMA_TOOL_ID) {
    const payload = result.result as { ok?: unknown; entry?: unknown } | null | undefined;
    // Authorize the id the CALLER asked for, never the one the payload
    // carries: a mismatch means the renderer answered a different question,
    // and honouring the payload's id would let a permitted id vouch for a
    // denied entry's schema. An absent request id fails closed — the tool's
    // schema requires one, so its absence means this is not an answer to a
    // well-formed request.
    const requestedId = options.requestedActionId;
    const answersTheRequest =
      payload?.ok === true &&
      requestedId !== undefined &&
      readEntryId(payload.entry) === requestedId;
    if (answersTheRequest && isIntrospectableForSession(payload.entry, permittedActionIds)) {
      // The renderer has no session, tier, or grant state, so it returns
      // `policy: null` and main substitutes the real record here — the same
      // rebuild-from-scratch point that strips any sibling key the renderer
      // attached. A snapshot that cannot produce a policy denies the read
      // rather than returning an entry a client would treat as unrestricted.
      const policy = options.policySnapshot
        ? buildTargetPolicy(payload.entry, options.policySnapshot)
        : null;
      if (policy !== null) {
        return { ok: true, result: { ok: true, entry: payload.entry, policy, error: null } };
      }
    }
    // Collapse onto the shape the renderer already returns for an unknown,
    // hidden, or restricted id rather than minting a tier-specific error: a
    // distinct error would confirm the id exists while offering no way to
    // reach it (grants are issued off a denied *dispatch*, not a schema read).
    // The renderer's own denial is rebuilt rather than forwarded, so the
    // message can only ever name the id the caller asked about.
    //
    // `entry` and `policy` are present-and-null rather than absent, matching
    // the renderer's own denial: one shape for both branches means a client
    // reads `ok` rather than probing for which keys arrived.
    return {
      ok: true,
      result: {
        ok: false,
        entry: null,
        policy: null,
        error: {
          code: "NOT_FOUND",
          message: `No action found with id "${requestedId ?? "unknown"}". Use actions.search to find available actions.`,
        },
      },
    };
  }

  return result;
}

/**
 * The action id an `actions.getSchema` caller asked about, so the filter can
 * authorize the request rather than whatever id the answer came back carrying.
 */
export function readRequestedActionId(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const actionId = (args as { actionId?: unknown }).actionId;
  return typeof actionId === "string" && actionId.length > 0 ? actionId : undefined;
}

/**
 * The advertised half of a tool's schema — the wire view.
 *
 * `toWireSchema` drops the value-range keywords, which a constrained-decoding
 * backend never enforces and which therefore reach the model as prompt text
 * billed on every turn. Nothing is weakened by their absence: `argsSchema` is
 * what actually validates a dispatch, and it is untouched by this projection.
 * See `shared/utils/mcpWireSchema.ts` for the full reasoning and for why
 * `additionalProperties: false` is deliberately not in the stripped set.
 */
export function buildToolInputSchema(entry: ActionManifestEntry): Record<string, unknown> {
  if (
    entry.inputSchema &&
    typeof entry.inputSchema === "object" &&
    !Array.isArray(entry.inputSchema) &&
    entry.inputSchema["type"] === "object"
  ) {
    return {
      ...(toWireSchema(entry.inputSchema) as Record<string, unknown>),
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

export function buildAnnotations(entry: ActionManifestEntry): ToolAnnotations {
  const overrides = entry.mcpAnnotations;
  const isQuery = entry.kind === "query";
  return {
    title: entry.title,
    readOnlyHint: overrides?.readOnlyHint ?? isQuery,
    idempotentHint: overrides?.idempotentHint ?? isQuery,
    destructiveHint: overrides?.destructiveHint ?? entry.danger === "confirm",
    openWorldHint: overrides?.openWorldHint ?? true,
  };
}

/**
 * The advertised return shape, emitted verbatim.
 *
 * Deliberately NOT projected through {@link toWireSchema}, even though it rides
 * `tools/list` and costs bytes on every turn like the input half. An output
 * schema is not advertisement — it is an enforced contract. The MCP SDK compiles
 * every advertised `outputSchema` and validates `structuredContent` against it
 * with AJV on the client side, and AJV genuinely enforces the value-range family
 * that constrained decoding ignores.
 *
 * Stripping them would therefore delete real validation rather than dead prompt
 * text, and it would bite hardest where there is no second line of defence: a
 * main-process tool returns its result without going through `ActionService`, so
 * it never gets the `resultSchema` check that covers renderer-dispatched
 * actions, and the client's AJV pass is the only validation there is. That gap
 * is latent rather than live today — the main-process tools do not currently opt
 * into `mcpOutputSchema`, so no output schema is advertised for them at all —
 * but the moment one does, this projection would be the thing that silently
 * disarmed it.
 */
export function buildToolOutputSchema(
  entry: ActionManifestEntry
): Record<string, unknown> | undefined {
  const schema = entry.outputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  if (schema["type"] !== "object") return undefined;
  return schema;
}

export function buildStructuredContent(
  entry: ActionManifestEntry | undefined,
  result: unknown
): Record<string, unknown> | undefined {
  if (!entry || !buildToolOutputSchema(entry)) return undefined;
  if (
    result === null ||
    result === undefined ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result instanceof Error
  ) {
    return undefined;
  }
  return result as Record<string, unknown>;
}

/**
 * Maximum accepted length for the optional `requestKey` dedup hint. A
 * generous cap that comfortably fits UUIDs, ULIDs, hashes, and short
 * descriptive labels while preventing a caller from pinning arbitrarily
 * large strings in the per-session dedup map for the TTL window.
 */
export const MAX_REQUEST_KEY_LENGTH = 256;

/**
 * Parse the raw `tools/call` arguments shape, stripping MCP-protocol-only
 * fields (`_meta`) and the per-call idempotency hint (`requestKey`) so they
 * never reach `dispatchAction`. The extracted `requestKey` is returned to
 * the caller so the dedup guard can use it as an explicit cache key.
 *
 * `requestKey` must be a non-empty string of at most `MAX_REQUEST_KEY_LENGTH`
 * characters to be honored — anything else (number, object, empty string,
 * over-long string) falls through to the auto-computed canonical-args hash,
 * matching the `readStringField` convention.
 */
export function parseToolArguments(rawArgs: unknown): {
  args: unknown;
  requestKey: string | undefined;
} {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: {}, requestKey: undefined };
  }

  const argsRecord = rawArgs as Record<string, unknown>;
  if (!("_meta" in argsRecord) && !("requestKey" in argsRecord)) {
    return { args: rawArgs, requestKey: undefined };
  }

  const { _meta: _ignored, requestKey: rawRequestKey, ...actionArgs } = argsRecord;
  const requestKey =
    typeof rawRequestKey === "string" &&
    rawRequestKey.length > 0 &&
    rawRequestKey.length <= MAX_REQUEST_KEY_LENGTH
      ? rawRequestKey
      : undefined;
  return {
    args: Object.keys(actionArgs).length > 0 ? actionArgs : {},
    requestKey,
  };
}
