import {
  PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX,
  PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX,
  type PluginWorktreeCardStatus,
} from "../types/plugin.js";

export type PluginWorktreeCardStatusResult =
  | { ok: true; worktreeId: string; status: PluginWorktreeCardStatus | null }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["label", "tooltip"]);

/**
 * Vet one `host.setWorktreeCardStatus(worktreeId, status)` call (#13704).
 * `null` and `undefined` both clear. Returns a fresh plain copy, so nothing the
 * plugin still holds can change what the host stores. Shared by the in-process
 * host, the worker proxy and the mock host so every host accepts and refuses
 * exactly the same calls. Whether the worktree is one the plugin may reach is
 * the host's check, not this one's.
 */
export function validatePluginWorktreeCardStatus(
  worktreeId: unknown,
  status: unknown
): PluginWorktreeCardStatusResult {
  if (typeof worktreeId !== "string" || worktreeId.length === 0) {
    return { ok: false, error: "worktreeId must be a non-empty string" };
  }
  if (status === null || status === undefined) return { ok: true, worktreeId, status: null };
  if (typeof status !== "object" || Array.isArray(status)) {
    return { ok: false, error: "status must be an object with a label, or null" };
  }
  const unknownKey = Object.keys(status).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { ok: false, error: `status has an unsupported field "${unknownKey}"` };
  }
  const { label, tooltip } = status as Record<string, unknown>;
  if (typeof label !== "string") return { ok: false, error: "status.label must be a string" };
  const trimmed = label.trim();
  if (trimmed.length === 0) return { ok: false, error: "status.label must not be empty" };
  if (/[\r\n]/.test(trimmed)) return { ok: false, error: "status.label must be a single line" };
  if (trimmed.length > PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX) {
    return {
      ok: false,
      error: `status.label must be at most ${PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX} characters`,
    };
  }
  if (tooltip === undefined || tooltip === null) {
    return { ok: true, worktreeId, status: { label: trimmed } };
  }
  if (typeof tooltip !== "string") return { ok: false, error: "status.tooltip must be a string" };
  if (tooltip.length > PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX) {
    return {
      ok: false,
      error: `status.tooltip must be at most ${PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX} characters`,
    };
  }
  const detail = tooltip.trim();
  return {
    ok: true,
    worktreeId,
    status: detail.length > 0 ? { label: trimmed, tooltip: detail } : { label: trimmed },
  };
}

/** Whether two vetted statuses would draw the same chip. */
export function sameWorktreeCardStatus(
  a: PluginWorktreeCardStatus | undefined,
  b: PluginWorktreeCardStatus
): boolean {
  return a !== undefined && a.label === b.label && a.tooltip === b.tooltip;
}
