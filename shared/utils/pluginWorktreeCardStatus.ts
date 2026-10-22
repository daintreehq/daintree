import {
  PLUGIN_WORKTREE_CARD_STATUS_LABEL_MAX,
  PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX,
  type PluginWorktreeCardStatus,
} from "../types/plugin.js";
import { isBuiltInActionId } from "./builtInActionIds.js";

export type PluginWorktreeCardStatusResult =
  | { ok: true; worktreeId: string; status: PluginWorktreeCardStatus | null }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["label", "tooltip", "command"]);

/** The authored form a plugin writes its own action ids in, `"{manifestId}.{id}"`. */
const AUTHORED_ACTION_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;

// Read without invoking an accessor, so a getter on plugin data can neither
// throw out of a host method that must reject nor answer differently twice.
function readField(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * Vet one `host.setWorktreeCardStatus(worktreeId, status)` call (#13704).
 * `null` and `undefined` both clear. Returns a fresh plain copy, so nothing the
 * plugin still holds can change what the host stores. Shared by the in-process
 * host, the worker proxy and the mock host so every host accepts and refuses
 * exactly the same calls. Whether the worktree is one the plugin may reach is
 * the host's check, not this one's.
 *
 * A `command` (#13776) must be one of the plugin's own actions in its authored
 * namespace, and is rewritten into the instance's, as a panel menu's entries
 * are, so a project plugin's chip runs its own action rather than a same-named
 * installed plugin's. A click runs with the user's authority, so neither form
 * may name a built-in (a manifest name can spell a built-in's prefix).
 */
export function validatePluginWorktreeCardStatus(
  worktreeId: unknown,
  status: unknown,
  manifestId: string,
  instanceId: string
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
  const label = readField(status, "label");
  const tooltip = readField(status, "tooltip");
  const command = readField(status, "command");
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
  let detail: string | undefined;
  if (tooltip !== undefined && tooltip !== null) {
    if (typeof tooltip !== "string") return { ok: false, error: "status.tooltip must be a string" };
    if (tooltip.length > PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX) {
      return {
        ok: false,
        error: `status.tooltip must be at most ${PLUGIN_WORKTREE_CARD_STATUS_TOOLTIP_MAX} characters`,
      };
    }
    detail = tooltip.trim() || undefined;
  }
  let actionId: string | undefined;
  if (command !== undefined && command !== null) {
    const ownPrefix = `${manifestId}.`;
    if (
      typeof command !== "string" ||
      !command.startsWith(ownPrefix) ||
      command.length === ownPrefix.length ||
      !AUTHORED_ACTION_ID.test(command)
    ) {
      const named =
        typeof command === "string" ? `"${command.slice(0, 200)}"` : `of type ${typeof command}`;
      return {
        ok: false,
        error: `status.command ${named} must be one of this plugin's own actions, written "${manifestId}.<id>"`,
      };
    }
    actionId = `${instanceId}.${command.slice(ownPrefix.length)}`;
    if (isBuiltInActionId(command) || isBuiltInActionId(actionId)) {
      return {
        ok: false,
        error: `status.command "${command}" is a built-in action, not one of this plugin's own`,
      };
    }
  }
  return {
    ok: true,
    worktreeId,
    status: {
      label: trimmed,
      ...(detail !== undefined ? { tooltip: detail } : {}),
      ...(actionId !== undefined ? { command: actionId } : {}),
    },
  };
}

/** Whether two vetted statuses would draw the same chip. */
export function sameWorktreeCardStatus(
  a: PluginWorktreeCardStatus | undefined,
  b: PluginWorktreeCardStatus
): boolean {
  return (
    a !== undefined && a.label === b.label && a.tooltip === b.tooltip && a.command === b.command
  );
}
