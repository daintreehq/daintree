import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { InlineError } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { pluralize } from "@/lib/pluralize";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudAccountSummary, CloudProviderInfo } from "@shared/types/cloudHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { ConnectCloudAccountDialog } from "./ConnectCloudAccountDialog";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

function scopeLabel(account: CloudAccountSummary): string {
  return account.billingScope.kind === "personal" ? "Personal" : account.billingScope.name;
}

/**
 * Settings → Hosts → Cloud providers: the provider accounts that let Daintree
 * create, start and stop machines as hosts. Removing one here only forgets
 * its key on this device; nothing changes at the provider.
 */
export function CloudProvidersSection() {
  const { snapshot, loaded, loadError, refresh } = useCloudHosts();
  const [connecting, setConnecting] = useState<{
    provider: CloudProviderInfo;
    replacing: CloudAccountSummary | null;
  } | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<CloudAccountSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const providers = snapshot.providers;
  const usable = providers.filter((provider) => provider.unsupportedReason === null);
  const accounts = snapshot.accounts;
  const providerFor = (account: CloudAccountSummary) =>
    providers.find((provider) => provider.id === account.providerId) ?? null;
  // Only Boat today; the section is written for any number.
  const primaryProvider = usable[0] ?? null;

  const clearRowError = (accountId: string) =>
    setRowErrors((errors) => {
      const next = { ...errors };
      delete next[accountId];
      return next;
    });
  const setChecked = (accountId: string, on: boolean) =>
    setChecking((current) => {
      const next = new Set(current);
      if (on) next.add(accountId);
      else next.delete(accountId);
      return next;
    });

  const check = (account: CloudAccountSummary) => {
    setChecked(account.id, true);
    clearRowError(account.id);
    cloudHostsClient.validateAccount(account.id).then(
      () => setChecked(account.id, false),
      (err: unknown) => {
        setChecked(account.id, false);
        setRowErrors((errors) => ({
          ...errors,
          [account.id]: errorText(err, "Couldn't check the account"),
        }));
      }
    );
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    setRemoving(true);
    setRemoveError(null);
    cloudHostsClient.removeAccount(removeTarget.id).then(
      () => {
        setRemoving(false);
        setRemoveTarget(null);
      },
      (err: unknown) => {
        setRemoving(false);
        setRemoveError(errorText(err, "Couldn't remove the account"));
      }
    );
  };

  const connectButton = primaryProvider ? (
    <Button
      variant="outline"
      size="sm"
      data-testid="cloud-connect-account"
      onClick={() => setConnecting({ provider: primaryProvider, replacing: null })}
    >
      <Plus aria-hidden="true" />
      Connect {primaryProvider.name} account
    </Button>
  ) : undefined;

  const unsupported = providers.length > 0 && usable.length === 0;

  return (
    <SettingsSection
      title="Cloud providers"
      description="Accounts that let Daintree create cloud machines as hosts, start them when you open them and stop them when you're done"
      action={accounts.length > 0 ? connectButton : undefined}
      id="hosts-cloud-providers"
    >
      <SettingsGroup>
        {loadError ? (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {loadError}
          </SettingsEmptyRow>
        ) : accounts.length === 0 ? (
          <SettingsEmptyRow action={unsupported ? undefined : connectButton}>
            {!loaded
              ? "Loading cloud accounts"
              : unsupported
                ? providers[0]!.unsupportedReason
                : "Connect a Boat account to create machines that start when you open them"}
          </SettingsEmptyRow>
        ) : (
          accounts.map((account) => {
            const provider = providerFor(account);
            const validation = account.validation;
            const rowError =
              rowErrors[account.id] ??
              (validation.status === "invalid" ? validation.detail : undefined);
            return (
              <SettingsRow
                key={account.id}
                label={account.displayName}
                description={
                  <>
                    {provider?.name ?? account.providerId} <FactSeparator /> {scopeLabel(account)}
                    {account.identity && (
                      <>
                        {" "}
                        <FactSeparator /> {account.identity}
                      </>
                    )}{" "}
                    <FactSeparator />{" "}
                    {account.hostCount > 0
                      ? pluralize(account.hostCount, "cloud host")
                      : "No hosts yet"}
                    {account.keyHint && (
                      <>
                        {" "}
                        <FactSeparator /> Key ending {account.keyHint}
                      </>
                    )}
                  </>
                }
                error={rowError ? <span role="alert">{rowError}</span> : undefined}
                control={
                  <div className="flex items-center gap-1.5" data-cloud-account={account.id}>
                    <Button
                      variant="outline"
                      size="sm"
                      loading={checking.has(account.id)}
                      aria-label={`Check ${account.displayName}`}
                      onClick={() => check(account)}
                    >
                      Check
                    </Button>
                    {provider && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Replace the key for ${account.displayName}`}
                        onClick={() => setConnecting({ provider, replacing: account })}
                      >
                        Replace key
                      </Button>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost-danger"
                          size="icon-sm"
                          aria-label={`Remove ${account.displayName} from this device`}
                          onClick={() => {
                            setRemoveError(null);
                            setRemoveTarget(account);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Remove account</TooltipContent>
                    </Tooltip>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsGroup>
      {connecting && (
        <ConnectCloudAccountDialog
          isOpen
          onClose={() => setConnecting(null)}
          provider={connecting.provider}
          replacing={connecting.replacing}
          onConnected={(account) => clearRowError(account.id)}
        />
      )}
      <ConfirmDialog
        isOpen={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        variant="destructive"
        title={`Remove '${removeTarget?.displayName ?? "account"}' from this device?`}
        description={`Its API key is deleted from this device. Nothing changes on ${removeTarget ? (providerFor(removeTarget)?.name ?? "the provider") : "the provider"}: the key keeps working there until you revoke it.`}
        confirmLabel="Remove account"
        onConfirm={confirmRemove}
        isConfirmLoading={removing}
      >
        {removeError && <InlineError role="alert">{removeError}</InlineError>}
      </ConfirmDialog>
    </SettingsSection>
  );
}
