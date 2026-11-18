import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { pluralize } from "@/lib/pluralize";
import type { PluginCloudAccountInfo } from "@shared/types/cloudHosts";

/**
 * The part of a plugin's uninstall that asks what happens to the cloud
 * accounts of its providers (#17353). Either way, nothing is asked of the
 * provider: every machine those accounts made keeps running there.
 */
export function PluginUninstallCloudAccounts({
  accounts,
  remove,
  onRemoveChange,
  disabled,
}: {
  accounts: readonly PluginCloudAccountInfo[];
  remove: boolean;
  onRemoveChange: (remove: boolean) => void;
  disabled: boolean;
}) {
  const hostCount = accounts.reduce((count, account) => count + account.hosts.length, 0);
  return (
    <div className="mb-3 space-y-2" data-testid="plugin-uninstall-cloud-accounts">
      <ul className="space-y-1 text-xs text-text-secondary">
        {accounts.map((account) => (
          <li key={account.id}>
            <span className="font-medium text-text-primary">{account.name}</span> <FactSeparator />{" "}
            {account.providerName} <FactSeparator />{" "}
            {account.hosts.length > 0
              ? account.hosts.map((host) => host.name).join(", ")
              : "No hosts"}
          </li>
        ))}
      </ul>
      <RadioChoiceGroup legend="Cloud accounts">
        <RadioChoiceRow
          name="plugin-uninstall-cloud-accounts"
          value="keep"
          checked={!remove}
          onChange={() => onRemoveChange(false)}
          disabled={disabled}
          label="Keep cloud accounts"
          description={
            hostCount > 0
              ? "Their credentials stay sealed on this device, and their hosts stay listed. Reinstalling the plugin brings them back"
              : "Their credentials stay sealed on this device. Reinstalling the plugin brings them back"
          }
        />
        <RadioChoiceRow
          name="plugin-uninstall-cloud-accounts"
          value="remove"
          checked={remove}
          onChange={() => onRemoveChange(true)}
          disabled={disabled}
          label="Remove cloud accounts"
          description={
            hostCount > 0
              ? `Deletes their credentials from this device and removes ${pluralize(hostCount, "host")} from the list`
              : "Deletes their credentials from this device"
          }
          details={
            hostCount > 0
              ? "Windows on those hosts return to this machine, and their plugin permissions, history and browser data on this device are cleared."
              : undefined
          }
        />
      </RadioChoiceGroup>
      <p className="text-xs text-text-secondary">
        Either way, nothing is stopped or deleted at the provider: every machine stays in its
        provider account, and one that's running keeps running and can keep billing there until you
        stop or delete it in the provider's console.
      </p>
    </div>
  );
}
