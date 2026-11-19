import { defineIpcNamespace, op } from "../define.js";
import { AGENT_ACCOUNTS_METHOD_CHANNELS } from "./agentAccounts.preload.js";
import {
  addAgentAccount,
  applyAccountEverywhere,
  listAccountChoicesAwayOnHost,
  removeAgentAccount,
  renameAgentAccount,
} from "../../services/agentAccounts.js";
import type { AgentSettings } from "../../../shared/types/agentSettings.js";
import type {
  AccountChoicesAway,
  AddAgentAccountRequest,
  AddAgentAccountResult,
  ApplyAccountEverywhereRequest,
} from "../../../shared/types/ipc/agentAccounts.js";

// An agent's accounts (#16040). A rename is read and written in main, by id,
// so a view's stale list can't undo another view's add or remove (#17080).
// Choosing an account (the default, a worktree's choice) goes through agent
// settings like any other field, except using one everywhere (#17893), whose
// clears are checked against what main holds when they land.
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
    listChoicesAway: op(
      AGENT_ACCOUNTS_METHOD_CHANNELS.listChoicesAway,
      async (agentId: string, accountId: string | null): Promise<AccountChoicesAway> =>
        listAccountChoicesAwayOnHost(agentId, accountId)
    ),
    applyEverywhere: op(
      AGENT_ACCOUNTS_METHOD_CHANNELS.applyEverywhere,
      async (request: ApplyAccountEverywhereRequest): Promise<AgentSettings> =>
        applyAccountEverywhere(request)
    ),
  },
});

export function registerAgentAccountsHandlers(): () => void {
  return agentAccountsNamespace.register();
}
