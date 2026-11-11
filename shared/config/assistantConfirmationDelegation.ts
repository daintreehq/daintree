/**
 * The confirm-gated calls a person can hand over to their own assistant one by
 * one (#16752), under the "Ask, except for…" Daintree confirmations mode.
 *
 * Keyed on the id the assistant called, never the action that reaches the
 * dialog: `worktree.deleteOwned` is sent on as `worktree.delete`, so a tick on
 * the dialog's id would hand over every delete. An allowlist, so a new
 * confirm-gated action is never delegable until someone adds it here.
 */
export interface DelegableAssistantConfirmation {
  /** The tool id the assistant calls. */
  id: string;
  label: string;
  /** What still holds, or what the tick doesn't cover. */
  detail: string;
}

export const ASSISTANT_HOST_SETTINGS_CONFIRMATION = "host.settings";

export const DELEGABLE_ASSISTANT_CONFIRMATIONS: readonly DelegableAssistantConfirmation[] = [
  {
    id: "worktree.deleteOwned",
    label: "Delete a worktree it created",
    detail:
      "Only a clean one: it never forces past uncommitted or untracked changes, deletes the branch, or closes panels",
  },
  {
    id: "worktree.retireOwned",
    label: "Retire a worktree it created",
    detail:
      "Only once it's clean and every commit is on a remote. Closes the assistant's own panels there first",
  },
  {
    id: ASSISTANT_HOST_SETTINGS_CONFIRMATION,
    label: "Change a host's settings",
    detail:
      "Only the settings an assistant may change, exactly as it previewed them. Never ask doesn't cover this",
  },
];

/**
 * Confirm-gated calls that always ask in "Ask, except for…", shown greyed with
 * the reason. Display only: what may be delegated is the allowlist above.
 */
export interface UndelegableAssistantConfirmation {
  ids: readonly string[];
  label: string;
  reason: string;
}

export const UNDELEGABLE_ASSISTANT_CONFIRMATIONS: readonly UndelegableAssistantConfirmation[] = [
  {
    ids: ["worktree.delete"],
    label: "Delete any worktree",
    reason: "It reaches worktrees the assistant didn't create, and can force past changes",
  },
  {
    ids: ["terminal.closeAll", "terminal.killAll", "terminal.killBatch"],
    label: "Close or end panels in bulk",
    reason: "One tick would cover every panel a call names",
  },
  {
    ids: ["recipe.run", "worktree.createWithRecipe", "terminal.new"],
    label: "Run a recipe or a command",
    reason: "What runs depends on what the assistant sends",
  },
  {
    ids: ["host.switch", "project.openOnHost"],
    label: "Move this window to a host",
    reason: "Moving the window you're using always asks",
  },
];

const DELEGABLE_IDS: ReadonlySet<string> = new Set(
  DELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => entry.id)
);

export function isDelegableAssistantConfirmation(actionId: string): boolean {
  return DELEGABLE_IDS.has(actionId);
}

/**
 * A stored or submitted list, kept to the delegable ids in catalog order. An
 * id that is unknown, or no longer delegable, never authorizes anything.
 */
export function sanitizeDelegatedConfirmations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const given = new Set(value.filter((id): id is string => typeof id === "string"));
  return DELEGABLE_ASSISTANT_CONFIRMATIONS.map((entry) => entry.id).filter((id) => given.has(id));
}
