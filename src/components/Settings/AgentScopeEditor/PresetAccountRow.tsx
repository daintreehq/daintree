import type { AgentPreset } from "@/config/agents";
import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import { SettingsSelect } from "../SettingsSelect";

const NOT_PINNED = "not-pinned";

interface PresetAccountRowProps {
  agentId: string;
  agentName: string;
  selectedPreset: AgentPreset;
  /** The agent's saved accounts, as settings hold them. */
  accounts: unknown;
  /** `undefined` takes the pin away. */
  onChange: (accountId: string | undefined) => void;
}

/**
 * The account a user preset pins (#16133). Only for an agent whose CLI keeps
 * its login in a folder, and only once there is an account to pin or a pin to
 * take away.
 */
export function PresetAccountRow({
  agentId,
  agentName,
  selectedPreset,
  accounts,
  onChange,
}: PresetAccountRowProps) {
  if (!getAgentConfigFolderAccount(agentId)) return null;
  const saved = sanitizeAgentAccounts(accounts);
  const pin = selectedPreset.accountId;
  if (saved.length === 0 && pin === undefined) return null;
  const pinned = pin === undefined ? undefined : saved.find((account) => account.id === pin);
  // A pin no account answers to refuses every launch of the preset, so it
  // shows as changed and can be reset even with nothing left to choose.
  const isGone = pin !== undefined && pinned === undefined;

  return (
    <SettingsSelect
      label="Account"
      description={
        isGone
          ? "The pinned account was removed, so launches with this preset are refused until this is reset"
          : `Who ${agentName} signs in as with this preset, unless the worktree or the launch picks another account`
      }
      value={pinned?.id ?? NOT_PINNED}
      onValueChange={(value) => onChange(value === NOT_PINNED ? undefined : value)}
      options={[
        { value: NOT_PINNED, label: "Not pinned" },
        ...saved.map((account) => ({ value: account.id, label: account.name })),
      ]}
      isModified={pin !== undefined}
      onReset={() => onChange(undefined)}
      resetAriaLabel="Unpin the account"
    />
  );
}
