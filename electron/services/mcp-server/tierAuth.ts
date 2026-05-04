import { createHash, timingSafeEqual } from "node:crypto";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { mcpPaneConfigService } from "../McpPaneConfigService.js";
import type { HelpTokenValidator } from "./shared.js";
import { type McpTier, OPEN_WORLD_CATEGORIES, TIER_ALLOWLISTS } from "./shared.js";

export function resolveBearer(token: string): McpTier | null {
  const paneTier = mcpPaneConfigService.getTierForToken(token);
  if (paneTier === "workbench" || paneTier === "action" || paneTier === "system") {
    return paneTier;
  }
  return null;
}

export function isAuthorized(
  authHeader: string,
  apiKey: string | null,
  helpTokenValidator: HelpTokenValidator | null
): boolean {
  if (apiKey) {
    const expected = `Bearer ${apiKey}`;
    const actualHash = createHash("sha256").update(authHeader).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    if (timingSafeEqual(actualHash, expectedHash)) return true;
  } else if (authHeader.length === 0) {
    return true;
  }

  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    if (mcpPaneConfigService.isValidPaneToken(token)) return true;
  }

  if (helpTokenValidator) {
    const match = /^Bearer\s+(.+)$/.exec(authHeader);
    const token = match?.[1]?.trim();
    if (token) {
      const tier = helpTokenValidator(token);
      if (tier) return true;
    }
  }

  return false;
}

export function resolveTokenTier(
  authHeader: string,
  apiKey: string | null,
  helpTokenValidator: HelpTokenValidator | null
): McpTier {
  if (apiKey) {
    const expected = `Bearer ${apiKey}`;
    const actualHash = createHash("sha256").update(authHeader).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    if (timingSafeEqual(actualHash, expectedHash)) return "external";
  } else if (authHeader.length === 0) {
    return "external";
  }

  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    const paneTier = mcpPaneConfigService.getTierForToken(token);
    if (paneTier === "workbench" || paneTier === "action" || paneTier === "system") {
      return paneTier;
    }
    if (helpTokenValidator) {
      const helpTier = helpTokenValidator(token);
      if (helpTier) return helpTier;
    }
  }

  return "workbench";
}

export function shouldExposeTool(
  entry: ActionManifestEntry,
  tier: McpTier,
  fullToolSurface: boolean
): boolean {
  if (entry.danger === "restricted") {
    return false;
  }
  if (tier === "external" && fullToolSurface) {
    return true;
  }
  return TIER_ALLOWLISTS[tier].has(entry.id);
}

export function isTierPermitted(
  tier: McpTier,
  actionId: string,
  fullToolSurface: boolean
): boolean {
  if (tier === "external" && fullToolSurface) {
    return true;
  }
  return TIER_ALLOWLISTS[tier].has(actionId);
}

export function buildToolDescription(entry: ActionManifestEntry): string {
  return entry.description;
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
    openWorldHint: OPEN_WORLD_CATEGORIES.has(entry.category),
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

export function parseToolArguments(rawArgs: unknown): { args: unknown } {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: rawArgs ?? {} };
  }

  const argsRecord = rawArgs as Record<string, unknown>;
  if (!("_meta" in argsRecord)) {
    return { args: rawArgs };
  }

  const { _meta: _ignored, ...actionArgs } = argsRecord;
  return { args: Object.keys(actionArgs).length > 0 ? actionArgs : {} };
}
