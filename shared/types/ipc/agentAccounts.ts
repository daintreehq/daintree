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
