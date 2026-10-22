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
 * One display line of at most `max`, from a value cut well past `max` first, so
 * a provider's megabyte "label" costs no more than a long one to tidy.
 */
function boundedLine(value: string, max: number): string {
  return boundedAgentContextLine(value.slice(0, max * 8), max);
}

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
        ? boundedLine(record.label, CONTEXT_ITEM_LABEL_MAX_LENGTH)
        : "";
    const description =
      typeof record.description === "string"
        ? boundedLine(record.description, CONTEXT_ITEM_DESCRIPTION_MAX_LENGTH)
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
  const tooLong = {
    ok: false as const,
    reason: `returned more than ${AGENT_CONTEXT_MAX_TEXT_LENGTH.toLocaleString("en-US")} characters`,
  };
  // Normalising only ever shortens text, by at most half (CRLF to LF), so
  // anything past twice the limit is refused before paying to walk it.
  if (record.text.length > AGENT_CONTEXT_MAX_TEXT_LENGTH * 2) return tooLong;
  const text = normalizeAgentContextText(record.text).replace(/\n+$/, "");
  if (text.length > AGENT_CONTEXT_MAX_TEXT_LENGTH) return tooLong;
  if (text.trim().length === 0) return { ok: false, reason: "returned empty text" };
  const title =
    typeof record.title === "string"
      ? boundedLine(record.title, AGENT_CONTEXT_MAX_TITLE_LENGTH)
      : "";
  return { ok: true, content: { text, ...(title ? { title } : {}) } };
}
