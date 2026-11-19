import { defineIpcNamespace, op } from "../define.js";
import { AGENT_ACCOUNTS_METHOD_CHANNELS } from "./agentAccounts.preload.js";
import {
  addAgentAccount,
  removeAgentAccount,
  renameAgentAccount,
} from "../../services/agentAccounts.js";
import type { AgentSettings } from "../../../shared/types/agentSettings.js";
import type {
  AddAgentAccountRequest,
  AddAgentAccountResult,
} from "../../../shared/types/ipc/agentAccounts.js";

// An agent's accounts (#16040). A rename is read and written in main, by id,
// so a view's stale list can't undo another view's add or remove (#17080).
// Choosing an account (the default, a worktree's choice) goes through agent
// settings like any other field.
export const agentAccountsNamespace = defineIpcNamespace({
  name: "agentAccounts",
  ops: {
    add: op(
      AGENT_ACCOUNTS_METHOD_CHANNELS.add,
      async (request: AddAgentAccountRequest): Promise<AddAgentAccountResult> =>
        addAgentAccount(request)
    ),
    remove: op(
      AGENT_ACCOUNTS_METHOD_CHANNELS.remove,
      async (agentId: string, accountId: string): Promise<AgentSettings> =>
        removeAgentAccount(agentId, accountId)
    ),
    rename: op(
      AGENT_ACCOUNTS_METHOD_CHANNELS.rename,
      async (agentId: string, accountId: string | null, name: string): Promise<AgentSettings> =>
        renameAgentAccount(agentId, accountId, name)
    ),
  },
});

export function registerAgentAccountsHandlers(): () => void {
  return agentAccountsNamespace.register();
}
