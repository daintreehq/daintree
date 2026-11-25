import { useEffect, useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { InlineError } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import {
  cloudProviderName,
  cloudStateWord,
  credentialsNoun,
  isDeleteOnly,
  sentenceCase,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { pluralize } from "@/lib/pluralize";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type {
  CloudAccountSummary,
  CloudHostStatus,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { CloudProviderConsentDialog } from "./CloudProviderConsentDialog";
import { ConnectCloudAccountDialog } from "./ConnectCloudAccountDialog";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/** What removing an account does, in its provider's terms. */
function removeDescription(provider: CloudProviderInfo | null): string {
  const where = provider?.name ?? "the provider";
  return credentialsNoun(provider) === "key"
    ? `Its API key is deleted from this device. Nothing changes on ${where}: the key keeps working there until you revoke it.`
    : `Its credentials are deleted from this device. Nothing changes on ${where}: they keep working there until you revoke them.`;
}

function scopeLabel(account: CloudAccountSummary): string {
  return account.billingScope.kind === "personal" ? "Personal" : account.billingScope.name;
}

/**
 * The machines an account's hosts are, as last seen, while its provider can't
 * be asked (#17353): they may well still be running, and billing, there.
 */
function LastKnownMachines({ hosts, label }: { hosts: CloudHostStatus[]; label: string }) {
  return (
    <ul className="mt-1.5 space-y-0.5" aria-label={label}>
      {hosts.map((host) => (
        <li key={host.hostId}>
          <span className="text-text-primary">{host.machineName ?? "Unnamed machine"}</span>{" "}
          {/* What the provider last said, never what this device was in the middle of asking. */}
          <FactSeparator /> {cloudStateWord({ ...host, operation: null })} <FactSeparator />{" "}
          {host.observedAt === null ? (
            "Never checked"
          ) : host.observedAt > 0 ? (
            <TimeAgo prefix="Last checked " timestamp={host.observedAt} />
          ) : (
            "Check time unknown"
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → Hosts → Cloud providers: the provider accounts that let Daintree
 * create, start and stop machines as hosts. Removing one here only forgets
 * its credentials on this device; nothing changes at the provider.
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
  const [reviewing, setReviewing] = useState<CloudAccountSummary | null>(null);
  /** The account an Allow is out for, and what the last one said, so a late answer never reaches another review. */
  const [allowing, setAllowing] = useState<string | null>(null);
  const [allowErrors, setAllowErrors] = useState<Record<string, string>>({});
  const setAllowError = (accountId: string, message: string | null) =>
    setAllowErrors((current) => {
      const next = { ...current };
      if (message) next[accountId] = message;
      else delete next[accountId];
      return next;
    });

  const providers = snapshot.providers;
  const usable = providers.filter((provider) => provider.unsupportedReason === null);
  const accounts = snapshot.accounts;
  const providerFor = (account: CloudAccountSummary) =>
    providers.find((provider) => provider.id === account.providerId) ?? null;
  // As it is now: a plugin update while the dialog is open asks its consent again, and a
  // provider that's gone (its plugin turned off or uninstalled) takes its dialog with it.
  const connectingProvider = connecting
    ? (providers.find((provider) => provider.id === connecting.provider.id) ?? null)
    : null;
  const connectingGone = connecting !== null && connectingProvider === null;
  // The account and its plugin as they are now: a review ends once there's nothing left to allow.
  const reviewingAccount = reviewing
    ? (accounts.find((entry) => entry.id === reviewing.id) ?? null)
    : null;
  const reviewingProvider = reviewingAccount ? providerFor(reviewingAccount) : null;
  const reviewingPlugin =
    reviewingProvider?.plugin && !reviewingProvider.plugin.granted
      ? reviewingProvider.plugin
      : null;
  const reviewOver = reviewing !== null && reviewingPlugin === null && allowing !== reviewing.id;

  useEffect(() => {
    if (connectingGone) setConnecting(null);
  }, [connectingGone]);
  useEffect(() => {
    if (reviewOver) setReviewing(null);
  }, [reviewOver]);

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

  const allowReviewed = () => {
    if (!reviewingAccount || !reviewingPlugin) return;
    const accountId = reviewingAccount.id;
    setAllowing(accountId);
    setAllowError(accountId, null);
    cloudHostsClient.allowAccountProvider(accountId, reviewingPlugin.fingerprint).then(
      (account) => {
        setAllowing((current) => (current === accountId ? null : current));
        setReviewing((current) => (current?.id === accountId ? null : current));
        clearRowError(account.id);
      },
      (err: unknown) => {
        setAllowing((current) => (current === accountId ? null : current));
        setAllowError(accountId, errorText(err, "Couldn't allow the plugin"));
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

  // One provider connects straight away; several are a choice first.
  const connectButton =
    usable.length === 0 ? undefined : usable.length === 1 ? (
      <Button
        variant="outline"
        size="sm"
        data-testid="cloud-connect-account"
        onClick={() => setConnecting({ provider: usable[0]!, replacing: null })}
      >
        <Plus aria-hidden="true" />
        Connect account
      </Button>
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" data-testid="cloud-connect-account">
            <Plus aria-hidden="true" />
            Connect account
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {usable.map((provider) => (
            <DropdownMenuItem
              key={provider.id}
              onSelect={() => setConnecting({ provider, replacing: null })}
            >
              {provider.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const unsupported = providers.length > 0 && usable.length === 0;
  // Start and stop are promised only where a listed provider's machines have them.
  const noStop = usable.filter((provider) => isDeleteOnly(provider)).length;
  const allNoStop = noStop > 0 && noStop === usable.length;
  const uses = allNoStop
    ? "Accounts Daintree uses to create cloud machines as hosts and delete them when you're done"
    : `Accounts Daintree uses to create cloud machines as hosts, start and stop them when you ask${noStop > 0 ? " where their provider can" : ""}, and delete them when you're done`;

  return (
    <SettingsSection
      title="Cloud providers"
      description={uses}
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
                : `Connect a cloud provider account to create machines that run projects and agents, then ${allNoStop ? "delete" : "stop or delete"} them when you're done`}
          </SettingsEmptyRow>
        ) : (
          accounts.map((account) => {
            const provider = providerFor(account);
            const providerName = cloudProviderName(provider, account);
            // Paused until the person allows the plugin behind it as it is declared now.
            const needsReview = provider?.plugin !== undefined && !provider.plugin.granted;
            // A paused account's provider is still here to ask; only a gone one leaves the last known state.
            const unavailable = account.providerUnavailable !== null && !needsReview;
            const lastKnown = unavailable
              ? snapshot.hosts.filter((host) => host.accountId === account.id)
              : [];
            const consoleUrl = unavailable ? (account.pluginProvider?.dashboardUrl ?? null) : null;
            const noun = credentialsNoun(provider);
            const Noun = sentenceCase(noun);
            const validation = account.validation;
            const rowError =
              rowErrors[account.id] ??
              account.providerUnavailable ??
              (validation.status === "invalid" ? validation.detail : undefined);
            return (
              <SettingsRow
                key={account.id}
                label={account.displayName}
                description={
                  <>
                    {account.pluginProvider
                      ? `${providerName} from the ${account.pluginProvider.pluginName} plugin`
                      : providerName}{" "}
                    <FactSeparator /> {scopeLabel(account)}
                    {/* The sign-in, unless the row is already named after it. */}
                    {account.identity && account.identity !== account.displayName && (
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
                    )}{" "}
                    <FactSeparator />{" "}
                    {/* When the credentials last worked, as observed; never a guess that they still do. */}
                    {account.validation.status === "valid" ? (
                      <TimeAgo
                        prefix={`${Noun} worked `}
                        timestamp={account.validation.checkedAt}
                      />
                    ) : account.validation.status === "invalid" ? (
                      `${Noun} refused`
                    ) : account.validation.checkedAt !== null ? (
                      <TimeAgo prefix="Couldn't check " timestamp={account.validation.checkedAt} />
                    ) : (
                      "Not checked yet"
                    )}
                    {lastKnown.length > 0 && (
                      <LastKnownMachines
                        hosts={lastKnown}
                        label={`Machines on ${account.displayName}`}
                      />
                    )}
                  </>
                }
                error={rowError ? <span role="alert">{rowError}</span> : undefined}
                control={
                  <div className="flex items-center gap-1.5" data-cloud-account={account.id}>
                    {needsReview && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Review access for ${account.displayName}`}
                        onClick={() => {
                          setAllowError(account.id, null);
                          setReviewing(account);
                        }}
                      >
                        Review access
                      </Button>
                    )}
                    {/* Nothing can check the credentials without the provider; its console still lists the machines. */}
                    {consoleUrl ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void systemClient.openExternal(consoleUrl)}
                      >
                        <ExternalLink aria-hidden="true" />
                        Open {providerName} console
                      </Button>
                    ) : (
                      !unavailable && (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={checking.has(account.id)}
                          aria-label={`Check ${account.displayName}`}
                          onClick={() => check(account)}
                        >
                          Check
                        </Button>
                      )
                    )}
                    {provider && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Replace the ${noun} for ${account.displayName}`}
                        onClick={() => setConnecting({ provider, replacing: account })}
                      >
                        Replace {noun}
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
                      <TooltipContent side="bottom">{`Remove ${account.displayName} from this device`}</TooltipContent>
                    </Tooltip>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsGroup>
      {connecting && connectingProvider && (
        <ConnectCloudAccountDialog
          isOpen
          onClose={() => setConnecting(null)}
          provider={connectingProvider}
          replacing={connecting.replacing}
          onConnected={(account) => clearRowError(account.id)}
        />
      )}
      {reviewingAccount && reviewingProvider && reviewingPlugin && (
        <CloudProviderConsentDialog
          isOpen
          onClose={() => setReviewing(null)}
          provider={reviewingProvider}
          plugin={reviewingPlugin}
          purpose="review"
          onAllow={allowReviewed}
          busy={allowing === reviewingAccount.id}
          error={allowErrors[reviewingAccount.id] ?? null}
        />
      )}
      <ConfirmDialog
        isOpen={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        variant="destructive"
        title={`Remove '${removeTarget?.displayName ?? "account"}' from this device?`}
        description={removeDescription(removeTarget ? providerFor(removeTarget) : null)}
        confirmLabel="Remove account"
        onConfirm={confirmRemove}
        isConfirmLoading={removing}
      >
        {removeError && <InlineError role="alert">{removeError}</InlineError>}
      </ConfirmDialog>
    </SettingsSection>
  );
}
