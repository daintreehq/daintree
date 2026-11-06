import { agentSettingsClient } from "@/clients";
import type { AccountSwitchTarget } from "@/store/slices/panelRegistry/types";
import { getAgentConfigFolderAccount, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";

/**
 * The folder `accountId` names for `agentId` in the saved settings, read fresh,
 * with the variable its CLI reads it from (#16040). `null` is the CLI's default
 * login. Throws for an agent without folder accounts and for an account that
 * isn't saved: a switch never lands on another login in its place.
 */
export async function resolveAccountSwitchTarget(
  agentId: string,
  accountId: string | null
): Promise<AccountSwitchTarget> {
  const declaration = getAgentConfigFolderAccount(agentId);
  const agentName = getEffectiveAgentConfig(agentId)?.name ?? agentId;
  if (!declaration) throw new Error(`${agentName} has no accounts to choose between`);
  if (accountId === null) return null;
  const settings = await agentSettingsClient.get();
  const account = sanitizeAgentAccounts(settings?.agents?.[agentId]?.accounts).find(
    (candidate) => candidate.id === accountId
  );
  if (!account) throw new Error(`${agentName} has no account '${accountId}'`);
  return { id: account.id, envVar: declaration.envVar, configDir: account.configDir };
}
