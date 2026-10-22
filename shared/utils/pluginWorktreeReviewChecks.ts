import {
  PLUGIN_WORKTREE_REVIEW_CHECKS_MAX,
  PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX,
  PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX,
  type PluginWorktreeReviewCheck,
} from "../types/plugin.js";
import { qualifyPluginOwnCommand, readField } from "./pluginWorktreeCardStatus.js";

export type PluginWorktreeReviewChecksResult =
  | { ok: true; worktreeId: string; checks: PluginWorktreeReviewCheck[] | null }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["label", "severity", "detail", "command"]);

/**
 * Vet one `host.setWorktreeReviewChecks(worktreeId, checks)` call (#13806).
 * `null`, `undefined` and `[]` clear. The whole list is vetted before any of it
 * is accepted, and a fresh plain copy comes back, so nothing the plugin still
 * holds can change what the host stores. Shared by the in-process host, the
 * worker proxy and the mock host so every host accepts and refuses the same
 * calls. Whether the worktree is one the plugin may reach is the host's check.
 *
 * A `command` follows the card-status rules: one of the plugin's own actions,
 * rewritten into the instance's namespace, never a built-in.
 */
export function validatePluginWorktreeReviewChecks(
  worktreeId: unknown,
  checks: unknown,
  manifestId: string,
  instanceId: string
): PluginWorktreeReviewChecksResult {
  if (typeof worktreeId !== "string" || worktreeId.length === 0) {
    return { ok: false, error: "worktreeId must be a non-empty string" };
  }
  if (checks === null || checks === undefined) return { ok: true, worktreeId, checks: null };
  if (!Array.isArray(checks)) {
    return { ok: false, error: "checks must be an array of checks, or null" };
  }
  if (checks.length === 0) return { ok: true, worktreeId, checks: null };
  if (checks.length > PLUGIN_WORKTREE_REVIEW_CHECKS_MAX) {
    return {
      ok: false,
      error: `checks must hold at most ${PLUGIN_WORKTREE_REVIEW_CHECKS_MAX} checks`,
    };
  }
  const accepted: PluginWorktreeReviewCheck[] = [];
  for (let index = 0; index < checks.length; index++) {
    const check: unknown = Object.getOwnPropertyDescriptor(checks, index)?.value;
    const at = `checks[${index}]`;
    if (typeof check !== "object" || check === null || Array.isArray(check)) {
      return { ok: false, error: `${at} must be an object with a label and a severity` };
    }
    const unknownKey = Object.keys(check).find((key) => !ALLOWED_KEYS.has(key));
    if (unknownKey !== undefined) {
      return { ok: false, error: `${at} has an unsupported field "${unknownKey}"` };
    }
    const label = readField(check, "label");
    const severity = readField(check, "severity");
    const detail = readField(check, "detail");
    const command = readField(check, "command");
    if (typeof label !== "string") return { ok: false, error: `${at}.label must be a string` };
    const trimmed = label.trim();
    if (trimmed.length === 0) return { ok: false, error: `${at}.label must not be empty` };
    if (/[\r\n]/.test(trimmed)) return { ok: false, error: `${at}.label must be a single line` };
    if (trimmed.length > PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX) {
      return {
        ok: false,
        error: `${at}.label must be at most ${PLUGIN_WORKTREE_REVIEW_CHECK_LABEL_MAX} characters`,
      };
    }
    if (severity !== "warning" && severity !== "info") {
      return { ok: false, error: `${at}.severity must be "warning" or "info"` };
    }
    let trimmedDetail: string | undefined;
    if (detail !== undefined && detail !== null) {
      if (typeof detail !== "string") return { ok: false, error: `${at}.detail must be a string` };
      if (detail.length > PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX) {
        return {
          ok: false,
          error: `${at}.detail must be at most ${PLUGIN_WORKTREE_REVIEW_CHECK_DETAIL_MAX} characters`,
        };
      }
      trimmedDetail = detail.trim() || undefined;
    }
    let actionId: string | undefined;
    if (command !== undefined && command !== null) {
      const qualified = qualifyPluginOwnCommand(command, `${at}.command`, manifestId, instanceId);
      if (!qualified.ok) return qualified;
      actionId = qualified.actionId;
    }
    accepted.push({
      label: trimmed,
      severity,
      ...(trimmedDetail !== undefined ? { detail: trimmedDetail } : {}),
      ...(actionId !== undefined ? { command: actionId } : {}),
    });
  }
  return { ok: true, worktreeId, checks: accepted };
}

/** Whether two vetted lists would draw the same rows. */
export function sameWorktreeReviewChecks(
  a: readonly PluginWorktreeReviewCheck[] | undefined,
  b: readonly PluginWorktreeReviewCheck[]
): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every(
      (check, i) =>
        check.label === b[i]!.label &&
        check.severity === b[i]!.severity &&
        check.detail === b[i]!.detail &&
        check.command === b[i]!.command
    )
  );
}
