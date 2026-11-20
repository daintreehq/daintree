import type { AgentAccount, AgentSettings } from "../agentSettings.js";

/**
 * Where a new account's folder comes from (#16040). `create` makes a fresh,
 * empty folder in the home directory beside the CLI's own, named after the
 * account (`~/.codex-company`), and never takes one that already exists;
 * `existing` points at a folder that is already there, such as one an earlier
 * `CODEX_HOME=… codex login` filled.
 */
export type AgentAccountFolderRequest = { kind: "create" } | { kind: "existing"; path: string };

export interface AddAgentAccountRequest {
  agentId: string;
  name: string;
  folder: AgentAccountFolderRequest;
}

/** The saved account, and the agent settings it was saved into. */
export interface AddAgentAccountResult {
  account: AgentAccount;
  settings: AgentSettings;
}

/**
 * A worktree's own account pick (#17893), named by its worktree id: the
 * worktree's path on the host that saved it. `null` is the default login in
 * that worktree alone.
 */
export interface WorktreeAccountChoice {
  worktreeId: string;
  accountId: string | null;
}

/** A user preset's pinned account (#16133). */
export interface PresetAccountPin {
  presetId: string;
  presetName: string;
  accountId: string;
  /**
   * Another user preset has the same id, so a clear by id can't say which is
   * meant. Listed as the first of them, the one a launch uses, and never cleared.
   */
  sharedId?: true;
}

/**
 * Every saved choice that would keep a launch off the account about to be
 * used everywhere (#17893), across every project on this host.
 */
export interface AccountChoicesAway {
  /** `gone`: nothing is at that path on this host, so no toolbar can reach the slot. */
  worktrees: Array<WorktreeAccountChoice & { gone: boolean }>;
  presets: PresetAccountPin[];
}

export interface ApplyAccountEverywhereRequest {
  agentId: string;
  /** The agent's new default; `null` is the CLI's default login. */
  accountId: string | null;
  /**
   * The listed choices the user left ticked, each with the account it was
   * listed under: one that names another account by the time this runs was
   * changed after the list was made, and stays.
   */
  clear: {
    worktrees: WorktreeAccountChoice[];
    presets: Array<Pick<PresetAccountPin, "presetId" | "accountId">>;
  };
}
