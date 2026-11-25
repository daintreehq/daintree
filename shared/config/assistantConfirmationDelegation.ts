/**
 * The confirm-gated calls a person can hand over to their own assistant one by
 * one (#16752), under the "Ask, except for…" Daintree confirmations mode.
 *
 * Keyed on the id the assistant called, never the action that reaches the
 * dialog: `worktree.deleteOwned` is sent on as `worktree.delete`, so a tick on
 * the dialog's id would hand over every delete. An allowlist, so a new
 * confirm-gated action is never delegable until someone adds it here.
 *
 * `host.startAgentSignIn` (#18197) is on neither list here on purpose: it has
 * no confirmation to ask or hand over. It opens the sign-in a CLI's row in
 * Settings → Hosts opens, in the person's window, and types and reads nothing
 * there; the approval and any code are the person's own steps in it.
 */
export interface DelegableAssistantConfirmation {
  /** The tool id the assistant calls, or the tick's own key when `calledActionId` names the tool. */
  id: string;
  /**
   * The tool a tick covers only some calls of (#17917). Its pane's view
   * settles each call, so a policy keyed on the called id never matches it.
   */
  calledActionId?: string;
  label: string;
  /** What still holds, or what the tick doesn't cover: one sentence, no period. */
  detail: string;
}

export const ASSISTANT_HOST_SETTINGS_CONFIRMATION = "host.settings";

export const ASSISTANT_GLOBAL_CLOSE_TOOL = "terminal.closeOwned";

/**
 * Covers the global Assistant's close of a finished agent it didn't launch
 * (#16750), never one stopped on an error. Not a tool id: the owned close
 * also ends what the assistant launched, which never asks.
 */
export const ASSISTANT_GLOBAL_CLOSE_CONFIRMATION = "terminal.closeOwned.finishedAgent";

/** Never skipped, delegated or granted: the person ticks each account's folder (#17079). */
export const ASSISTANT_ACCOUNT_ADD_CONFIRMATION = "agent.addAccount";

export const ASSISTANT_PRESET_MOVE_TOOL = "terminal.restartOnPresetOwned";

/** What main dispatches to the pane's view for {@link ASSISTANT_PRESET_MOVE_TOOL}. */
export const ASSISTANT_PRESET_MOVE_DELEGATE = "terminal.restartOnPreset";

/**
 * Covers a preset move only to the next step of the chain the pane walks
 * (#17917). Not a tool id: a tick on the tool itself would hand over every
 * preset, including one that skips permission prompts.
 */
export const ASSISTANT_NEXT_FALLBACK_CONFIRMATION = "terminal.restartOnPresetOwned.nextFallback";

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
      "Only once it's clean and every commit is on a remote, after closing the assistant's own panels there",
  },
  {
    id: ASSISTANT_NEXT_FALLBACK_CONFIRMATION,
    calledActionId: ASSISTANT_PRESET_MOVE_TOOL,
    label: "Move an agent it launched to the next preset in its fallback chain",
    detail:
      "Only the next step of a custom preset's fallback chain, walked as a usage-limit fallback walks it and on the same account; any other preset still asks",
  },
  {
    id: ASSISTANT_GLOBAL_CLOSE_CONFIRMATION,
    calledActionId: ASSISTANT_GLOBAL_CLOSE_TOOL,
    label: "Close a finished agent",
    detail:
      "For the global assistant, only an agent that handed its work back with nothing typed; one stopped on an error always asks",
  },
  {
    id: ASSISTANT_HOST_SETTINGS_CONFIRMATION,
    label: "Change a host's settings",
    detail:
      "Only the settings an assistant may change, exactly as it previewed them; Never ask doesn't cover this",
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
    reason:
      "Always asks: it reaches worktrees the assistant didn't create, and can force past changes",
  },
  {
    ids: ["terminal.closeAll", "terminal.killAll", "terminal.killBatch"],
    label: "Close or end panels in bulk",
    reason: "Always asks: one tick would cover every panel a call names",
  },
  {
    ids: ["recipe.run", "worktree.createWithRecipe", "terminal.new"],
    label: "Run a recipe or a command",
    reason: "Always asks: what runs depends on what the assistant sends",
  },
  {
    ids: [ASSISTANT_PRESET_MOVE_TOOL],
    label: "Move an agent to any preset",
    reason: "Always asks: another preset can skip permission prompts or add its own flags",
  },
  {
    ids: ["terminal.restartOnAccountOwned"],
    label: "Move an agent to another account",
    reason: "Always asks: an account's folder carries the CLI's own settings, not just a login",
  },
  {
    ids: ["host.switch", "project.openOnHost"],
    label: "Move this window to a host",
    reason: "Always asks: it moves the window you're using",
  },
  {
    ids: [ASSISTANT_ACCOUNT_ADD_CONFIRMATION],
    label: "Add agent accounts",
    reason: "Always asks, even under Never ask: you tick each folder before it's made",
  },
];

const DELEGABLE_IDS: ReadonlySet<string> = new Set(
  DELEGABLE_ASSISTANT_CONFIRMATIONS.filter((entry) => entry.calledActionId === undefined).map(
    (entry) => entry.id
  )
);

/** Whether a tick can hand over every call to `actionId`. */
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
