import type {
  ContextProviderContent,
  ContextProviderItem,
} from "../types/pluginContextProvider.js";
import {
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  boundedAgentContextLine,
  normalizeAgentContextText,
} from "./agentContextDrag.js";
import {
  CONTEXT_ITEM_DESCRIPTION_MAX_LENGTH,
  CONTEXT_ITEM_LABEL_MAX_LENGTH,
  CONTEXT_SEARCH_MAX_RESULTS,
  isContextItemId,
} from "./pluginContextReference.js";

/**
 * A provider's search results held to the contract: at most fifty, each with a
 * valid id and a one-line label, duplicates dropped. A malformed row is
 * skipped rather than failing the list.
 */
export function sanitizeContextProviderItems(value: unknown): ContextProviderItem[] {
  if (!Array.isArray(value)) return [];
  const items: ContextProviderItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (items.length >= CONTEXT_SEARCH_MAX_RESULTS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (!isContextItemId(record.id) || seen.has(record.id)) continue;
    const label =
      typeof record.label === "string"
        ? boundedAgentContextLine(record.label, CONTEXT_ITEM_LABEL_MAX_LENGTH)
        : "";
    const description =
      typeof record.description === "string"
        ? boundedAgentContextLine(record.description, CONTEXT_ITEM_DESCRIPTION_MAX_LENGTH)
        : "";
    seen.add(record.id);
    items.push({
      id: record.id,
      label: label || record.id,
      ...(description ? { description } : {}),
    });
  }
  return items;
}

/**
 * A provider's resolved content held to the contract, or why it isn't one.
 * Text over the limit is refused rather than cut: a quote that silently stops
 * partway reads to the agent as the whole item.
 */
export function sanitizeContextProviderContent(
  value: unknown
): { ok: true; content: ContextProviderContent } | { ok: false; reason: string } {
  if (value === null || value === undefined) return { ok: false, reason: "not found" };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "returned something other than content" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") return { ok: false, reason: "returned no text" };
  const text = normalizeAgentContextText(record.text).replace(/\n+$/, "");
  if (text.length > AGENT_CONTEXT_MAX_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `returned more than ${AGENT_CONTEXT_MAX_TEXT_LENGTH.toLocaleString("en-US")} characters`,
    };
  }
  if (text.trim().length === 0) return { ok: false, reason: "returned empty text" };
  const title =
    typeof record.title === "string"
      ? boundedAgentContextLine(record.title, AGENT_CONTEXT_MAX_TITLE_LENGTH)
      : "";
  return { ok: true, content: { text, ...(title ? { title } : {}) } };
}
