import { defineIpcNamespace, op } from "../define.js";
import { AGENT_ACCOUNTS_METHOD_CHANNELS } from "./agentAccounts.preload.js";
import { addAgentAccount, removeAgentAccount } from "../../services/agentAccounts.js";
import type { AgentSettings } from "../../../shared/types/agentSettings.js";
import type {
  AddAgentAccountRequest,
  AddAgentAccountResult,
} from "../../../shared/types/ipc/agentAccounts.js";

// An agent's accounts (#16040). Edits that need no folder (renaming, the
// default, a worktree's choice) go through agent settings like any other field.
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
  },
});

export function registerAgentAccountsHandlers(): () => void {
  return agentAccountsNamespace.register();
}
