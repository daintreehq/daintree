import { createHash, timingSafeEqual } from "node:crypto";
import type { ActionDispatchResult, ActionManifestEntry } from "../../../shared/types/actions.js";
import { deriveBand, BAND_OVERRIDES } from "../../../shared/utils/actionRiskBand.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import type { HelpTokenValidator } from "./shared.js";
import { type McpTier, TIER_ALLOWLISTS } from "./shared.js";

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
 */
export function shouldExposeTool(entry: ActionManifestEntry, tier: McpTier): boolean {
  if (entry.danger === "restricted") {
    return false;
  }
  if (entry.mcpVisibility === "hidden") {
    return false;
  }
  if (entry.mcpVisibility === "discoverable") {
    return false;
  }
  return isTierPermitted(tier, entry.id);
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

/** Mirrors `actions.search`'s `limit` bounds in `introspectionActions.ts`. */
export const ACTIONS_SEARCH_MAX_LIMIT = 100;
export const ACTIONS_SEARCH_DEFAULT_LIMIT = 20;

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
 * `mcpVisibility: "discoverable"` is deliberately allowed through — that
 * visibility exists precisely so `actions.search` / `actions.getSchema` can
 * surface non-core actions that eager `tools/list` omits (#8502). Reusing
 * {@link shouldExposeTool} here would silently defeat progressive disclosure.
 */
function isDiscoverableForSession(entry: unknown, permittedActionIds: ReadonlySet<string>): boolean {
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
  callerLimit: number
): ActionDispatchResult {
  if (!result.ok) return result;

  if (actionId === ACTIONS_LIST_TOOL_ID) {
    const payload = result.result as { actions?: unknown } | null | undefined;
    if (!payload || !Array.isArray(payload.actions)) return result;
    return {
      ok: true,
      result: {
        ...payload,
        actions: payload.actions.filter((entry) =>
          isDiscoverableForSession(entry, permittedActionIds)
        ),
      },
    };
  }

  if (actionId === ACTIONS_SEARCH_TOOL_ID) {
    const payload = result.result as { results?: unknown } | null | undefined;
    if (!payload || !Array.isArray(payload.results)) return result;
    const permitted = payload.results.filter((entry) =>
      isDiscoverableForSession(entry, permittedActionIds)
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
        ...payload,
        totalMatches: permitted.length,
        results: permitted.slice(0, callerLimit),
      },
    };
  }

  if (actionId === ACTIONS_GET_SCHEMA_TOOL_ID) {
    const payload = result.result as { ok?: unknown; entry?: unknown } | null | undefined;
    if (!payload || payload.ok !== true) return result;
    if (isDiscoverableForSession(payload.entry, permittedActionIds)) return result;
    // Collapse onto the shape the renderer already returns for an unknown,
    // hidden, or restricted id rather than minting a tier-specific error: a
    // distinct error would confirm the id exists while offering no way to
    // reach it (grants are issued off a denied *dispatch*, not a schema read).
    const requestedId = readEntryId(payload.entry);
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
