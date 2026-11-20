import type { ActionRegistry } from "../actionTypes";
import type { ActionId } from "@shared/types/actions";
import { z } from "zod";
import { AGENT_REGISTRY } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useMoveTerminalsDialogStore } from "@/store/moveTerminalsDialogStore";
import { defaultLoginLabel, sanitizeAgentAccounts } from "@shared/utils/agentAccounts";

const MoveTerminalsToAccountArgsSchema = z
  .object({
    accountId: z
      .string()
      .nullable()
      .optional()
      .describe("Saved account to move to; null is the default login. Omitted, the dialog asks."),
  })
  .strict()
  .optional();

function savedAccounts(agentId: string) {
  return sanitizeAgentAccounts(
    useAgentSettingsStore.getState().settings?.agents?.[agentId]?.accounts
  );
}

/**
 * "Move <agent> terminals to account" (#17089), one per agent that signs in
 * through a config folder, since the palette can't say which agent it means.
 * It opens the confirm and nothing more: the restart is
 * `terminal.restartOnAccount`, once per pane the user leaves checked, and the
 * account new launches use stays where it was.
 */
export function registerAgentAccountMoveActions(actions: ActionRegistry): void {
  for (const [agentId, config] of Object.entries(AGENT_REGISTRY)) {
    if (config.account?.kind !== "config-folder") continue;
    const actionId = `agent.moveTerminalsToAccount.${agentId}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Move ${config.name} terminals to account`,
      description: `Open a confirm listing every running ${config.name} terminal in the project that isn't on the account, to restart the ones left checked on it. Leaves the default account alone.`,
      paletteDescription: `Restart running ${config.name} terminals on another account`,
      category: "agent",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      denyPluginDispatch: true,
      // Nothing to move between until the agent has an account besides its default login.
      isVisible: () => savedAccounts(agentId).length > 0,
      keywords: ["account", "login", "switch", "move", "panes", "usage limit", "rate limit"],
      argsSchema: MoveTerminalsToAccountArgsSchema,
      run: async (args: unknown) => {
        const { accountId } = MoveTerminalsToAccountArgsSchema.parse(args) ?? {};
        if (accountId === undefined) {
          useMoveTerminalsDialogStore.getState().open(agentId);
          return;
        }
        if (accountId === null) {
          const name = defaultLoginLabel(
            useAgentSettingsStore.getState().settings?.agents?.[agentId]?.defaultLoginName
          );
          useMoveTerminalsDialogStore.getState().open(agentId, { id: null, name });
          return;
        }
        const account = savedAccounts(agentId).find((candidate) => candidate.id === accountId);
        if (!account) throw new Error(`No ${config.name} account "${accountId}"`);
        useMoveTerminalsDialogStore
          .getState()
          .open(agentId, { id: account.id, name: account.name });
      },
    }));
  }
}
