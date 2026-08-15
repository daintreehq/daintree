import { createHash, timingSafeEqual } from "node:crypto";
import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import { deriveBand, BAND_OVERRIDES } from "../../../shared/utils/actionRiskBand.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import type { HelpTokenValidator } from "./shared.js";
import { type McpTier, TIER_ALLOWLISTS } from "./shared.js";
import {
  ACTIONS_LIST_DEFAULT_LIMIT,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
  ACTIONS_SEARCH_MAX_LIMIT,
} from "../../../shared/config/mcpIntrospection.js";

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
 * result schemas declare their entries as `z.unknown()`, so main re-narrows
 * rather than trusting the renderer's shape.
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
      return { ok: true, result: { ok: true, entry: payload.entry } };
    }
    // Collapse onto the shape the renderer already returns for an unknown,
    // hidden, or restricted id rather than minting a tier-specific error: a
    // distinct error would confirm the id exists while offering no way to
    // reach it (grants are issued off a denied *dispatch*, not a schema read).
    // The renderer's own denial is rebuilt rather than forwarded, so the
    // message can only ever name the id the caller asked about.
    return {
      ok: true,
      result: {
        ok: false,
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

export function buildToolInputSchema(entry: ActionManifestEntry): Record<string, unknown> {
  if (
    entry.inputSchema &&
    typeof entry.inputSchema === "object" &&
    !Array.isArray(entry.inputSchema) &&
    entry.inputSchema["type"] === "object"
  ) {
    return { ...entry.inputSchema, additionalProperties: false } as Record<string, unknown>;
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
