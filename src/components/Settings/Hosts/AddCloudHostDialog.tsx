import { useContext, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/checkbox";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Field, FieldDescription, FieldLabel, InlineError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { InstallCommandHandoffContext } from "@/hooks/terminal/installCommandHandoffContext";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  cloudMachineLabel,
  type CloudProviderInfo,
  type CloudResourceSummary,
} from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { CloudOfferChoice } from "./CloudOfferChoice";
import { ConnectCloudAccountDialog } from "./ConnectCloudAccountDialog";
import { hasTunnelSetupCommands, TunnelSetupCommands } from "./TunnelSetupCommands";
import { awaitFirstConnect } from "./hostCopySettingsRequests";
import { CloudProvisioningSelect, provisioningChoiceDescription } from "./CloudProvisioningSelect";
import { LIFETIME_VALUES, useCloudMachineForm } from "./useCloudMachineForm";
import {
  canStartMachine,
  cloudProviderFor,
  credentialsNoun,
  DELETE_ONLY_LOSS,
  formatHourly,
  isDeleteOnly,
  stopKeepsSentence,
  stoppedBillingFact,
  stoppedBillingSentence,
  hourlyShort,
  lifetimeLabel,
  lifetimeSentence,
  machineSpecLabel,
  providerStopSentence,
  sentenceCase,
} from "@/components/Hosts/cloud/cloudHostLabels";

interface AddCloudHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The machine is running: carry on with the usual check, install and Host mode steps. */
  onReady: (host: { hostId: HostId; name: string }) => void;
}

type Mode = "create" | "import";

/**
 * What an account lets Daintree do with its machines, across every provider
 * it could be on: delete only where all of them can, and start and stop only
 * where its provider does, said so when some can't.
 */
function machineVerbs(providers: readonly CloudProviderInfo[]): string {
  const deletes = providers.every((entry) => entry.capabilities.deletion);
  const noStop = providers.filter((entry) => isDeleteOnly(entry)).length;
  if (noStop === 0) {
    return deletes ? "create, start, stop and delete machines" : "create, start and stop machines";
  }
  const ends = deletes ? "create and delete machines" : "create machines";
  return noStop === providers.length
    ? ends
    : `${ends}, and to start and stop them where their provider can`;
}

/** One clause stays a bare line; several are sentences, each ended once. */
function importNote(...parts: Array<string | null>): string {
  const clauses = parts
    .filter((part): part is string => !!part)
    .map((part) => part.replace(/\.$/, ""));
  return clauses.length > 1 ? `${clauses.join(". ")}.` : (clauses[0] ?? "");
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Add a cloud host: create a new machine in a connected account, or add one
 * that already exists there. Nothing billable happens until the person
 * presses Create; an imported machine is never started from here unless they
 * choose to. Once the machine runs, the usual Add host steps (check, install,
 * Host mode, connect) take over through `onReady`.
 */
/** "Boat usually has a machine running in about a minute. ", or nothing when the provider doesn't say. */
function typicalStart(provider: CloudProviderInfo): string {
  const seconds = provider.capabilities.typicalStartSeconds;
  if (seconds === null) return "";
  const span = seconds <= 60 ? "about a minute" : `about ${Math.round(seconds / 60)} minutes`;
  return `${provider.name} usually has a machine running in ${span}. `;
}

export function AddCloudHostDialog({ isOpen, onClose, onReady }: AddCloudHostDialogProps) {
  const { snapshot } = useCloudHosts();
  const usable = snapshot.providers.filter((entry) => entry.unsupportedReason === null);
  // Accounts only on providers this machine can use and may hand the credentials to now;
  // the machine comes from whichever pays.
  const accounts = snapshot.accounts.filter(
    (entry) =>
      entry.providerUnavailable === null &&
      usable.some((provider) => provider.id === entry.providerId)
  );
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  const account = accounts.find((entry) => entry.id === accountId) ?? accounts[0] ?? null;
  const provider = account
    ? (usable.find((entry) => entry.id === account.providerId) ?? null)
    : (usable[0] ?? null);
  const [mode, setMode] = useState<Mode>("create");
  // Per mode, so a choice made for a new machine never carries over to an existing one.
  const [mcpServerOnConnect, setMcpServerOnConnect] = useState<Record<Mode, boolean>>({
    create: true,
    import: false,
  });
  const [name, setName] = useState("");
  const [resources, setResources] = useState<CloudResourceSummary[] | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  // Bumped by Retry: reads again without touching what's been filled in.
  const [resourcesTry, setResourcesTry] = useState(0);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inheritedHandoff = useContext(InstallCommandHandoffContext);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<CloudProviderInfo | null>(null);
  // As it is now: a plugin update while the dialog is open asks its consent again, and a
  // provider that's gone takes its dialog with it, showing this one again.
  const connectingProvider = connecting
    ? (snapshot.providers.find((entry) => entry.id === connecting.id) ?? null)
    : null;
  const connectingGone = connecting !== null && connectingProvider === null;
  useEffect(() => {
    if (connectingGone) setConnecting(null);
  }, [connectingGone]);
  /** The host this dialog added; its machine's progress is followed from the cloud snapshot. */
  const [added, setAdded] = useState<{ hostId: HostId; name: string } | null>(null);
  const [startRequested, setStartRequested] = useState(false);
  // What this device's PATH said of the provider's tunnel command, for the choice `key` names:
  // an answer for another account, provider or command counts as none yet. `pending` while
  // the same choice is asked again (Check again, a refused create).
  const [tunnelLookup, setTunnelLookup] = useState<{
    key: string;
    found: boolean;
    error: string | null;
    pending: boolean;
  } | null>(null);
  // Bumped by Check again, and by a refused create: the command may have come or gone since.
  const [tunnelTry, setTunnelTry] = useState(0);

  const status = cloudStatusFor(snapshot, added?.hostId);
  // The provider the added host is bound to, which the form's choice may since have left.
  const addedProvider = cloudProviderFor(snapshot.providers, status);
  const accountKey = account?.id ?? null;
  const form = useCloudMachineForm(account, provider, added === null);
  const {
    currentCatalog,
    catalogError,
    machineTypes,
    machineType,
    chosenType,
    lifetime,
    lifetimeChosen,
    lifetimeHours,
    dimensions,
    provisioningProblem,
  } = form;

  useEffect(() => {
    if (!accountKey || mode !== "import" || added) return;
    let current = true;
    setResources(null);
    setResourcesError(null);
    cloudHostsClient.listResources(accountKey).then(
      (next) => {
        if (current) setResources(next);
      },
      (err: unknown) => {
        if (current) setResourcesError(errorText(err, "Couldn't list the machines"));
      }
    );
    return () => {
      current = false;
    };
  }, [accountKey, mode, added, resourcesTry]);

  // A machine made on a provider reached through its own command waits on finding that command
  // here: one this device can't reach would run, and bill, while the person installs it.
  const tunnel = provider?.capabilities.tunnel ?? null;
  const tunnelProviderId = provider?.id ?? null;
  const tunnelProviderName = provider?.name ?? null;
  const tunnelCommand = tunnel?.command ?? null;
  const tunnelKey =
    isOpen && mode === "create" && added === null && accountKey !== null && tunnelCommand !== null
      ? `${accountKey}\n${tunnelProviderId}\n${tunnelCommand}`
      : null;
  useEffect(() => {
    if (tunnelKey === null || tunnelProviderId === null) {
      // Nothing carries over: coming back to create looks again.
      setTunnelLookup(null);
      return undefined;
    }
    // The same choice asked again keeps what was said in view, so its Check again keeps focus;
    // an answer for any other choice is gone before this one is asked, however it was keyed.
    setTunnelLookup((previous) =>
      previous?.key === tunnelKey ? { ...previous, pending: true } : null
    );
    let current = true;
    cloudHostsClient.findTunnel(tunnelProviderId).then(
      (result) => {
        if (!current) return;
        // An answer about a declaration other than the one shown says nothing of it.
        setTunnelLookup(
          result !== null && result.command === tunnelCommand
            ? { key: tunnelKey, found: result.found, error: null, pending: false }
            : {
                key: tunnelKey,
                found: false,
                error: `${tunnelProviderName} changed while Daintree looked for ${tunnelCommand}. Check again.`,
                pending: false,
              }
        );
      },
      (err: unknown) => {
        if (!current) return;
        setTunnelLookup({
          key: tunnelKey,
          found: false,
          error: errorText(err, `Couldn't look for ${tunnelCommand} on this device`),
          pending: false,
        });
      }
    );
    return () => {
      current = false;
    };
  }, [tunnelKey, tunnelTry, tunnelProviderId, tunnelProviderName, tunnelCommand]);
  const tunnelAnswer =
    tunnelLookup !== null && tunnelLookup.key === tunnelKey ? tunnelLookup : null;
  const tunnelState: "none" | "checking" | "found" | "missing" | "failed" =
    tunnelKey === null
      ? "none"
      : tunnelAnswer === null
        ? "checking"
        : tunnelAnswer.error !== null
          ? "failed"
          : tunnelAnswer.found
            ? "found"
            : "missing";
  const tunnelPending = tunnelAnswer?.pending ?? false;
  const tunnelReady = tunnelState === "none" || (tunnelState === "found" && !tunnelPending);
  const checkTunnelAgain = () => setTunnelTry((n) => n + 1);

  // Hand over to setup once the machine runs; never while an order waits on a choice, nor
  // while the machine's failure is shown (a lease on terms nobody chose still runs). A missed
  // poll or a slow start, which a running machine has got past, doesn't hold it back.
  const ready =
    added !== null &&
    status?.machine === "running" &&
    status.operation === null &&
    !status.pendingCreate &&
    status.lastError?.code !== "failed";
  // A stopped import only gets here once someone starts it; a running one at once.
  const handedOver = useRef(false);
  useEffect(() => {
    if (!ready || !added || handedOver.current) return;
    handedOver.current = true;
    onReady(added);
  }, [ready, added, onReady]);

  // Not yet in the snapshot is the moment after the add answered; gone after being seen is
  // a host removed meanwhile, which no progress here will ever follow.
  const [seenHostId, setSeenHostId] = useState<HostId | null>(null);
  const addedHostId = added?.hostId ?? null;
  const addedHostShown = status !== null;
  useEffect(() => {
    if (addedHostId !== null && addedHostShown) setSeenHostId(addedHostId);
  }, [addedHostId, addedHostShown]);
  const hostGone = addedHostId !== null && seenHostId === addedHostId && status === null;

  const chosenResource = resources?.find((resource) => resource.resourceId === resourceId) ?? null;
  const trimmedName = name.trim();

  const create = () => {
    const request = form.request(trimmedName);
    if (!request || !tunnelReady) return;
    setBusy(true);
    setError(null);
    cloudHostsClient.createHost({ ...request, mcpServerOnConnect: mcpServerOnConnect.create }).then(
      ({ hostId }) => {
        setBusy(false);
        // Armed as the host is recorded, not on handover: closing this dialog doesn't
        // stop setup, and the first connection, wherever it happens, takes the offer.
        awaitFirstConnect(hostId);
        setAdded({ hostId, name: trimmedName });
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err, "Couldn't create the machine"));
        // Main looks again before anything is made; whatever it found, this looks again too.
        if (tunnel) checkTunnelAgain();
      }
    );
  };

  const importMachine = () => {
    if (!account || !chosenResource) return;
    const hostName = trimmedName || chosenResource.name;
    setBusy(true);
    setError(null);
    cloudHostsClient
      .importHost({
        accountId: account.id,
        resourceId: chosenResource.resourceId,
        name: hostName,
        mcpServerOnConnect: mcpServerOnConnect.import,
      })
      .then(
        ({ hostId }) => {
          setBusy(false);
          awaitFirstConnect(hostId);
          setAdded({ hostId, name: hostName });
        },
        (err: unknown) => {
          setBusy(false);
          setError(errorText(err, "Couldn't add the machine"));
        }
      );
  };

  const startAdded = () => {
    if (!added || isDeleteOnly(addedProvider)) return;
    setStartRequested(true);
    setError(null);
    cloudHostsClient.startHost(added.hostId).catch((err: unknown) => {
      setStartRequested(false);
      setError(errorText(err, "Couldn't start the machine"));
    });
  };

  const checkAdded = () => {
    if (!added) return;
    setError(null);
    cloudHostsClient.refreshHost(added.hostId).catch((err: unknown) => {
      setError(errorText(err, "Couldn't ask about the machine"));
    });
  };

  const retry = () => {
    if (!added) return;
    setError(null);
    cloudHostsClient.retryCreate(added.hostId).catch((err: unknown) => {
      setError(errorText(err, "Couldn't create the machine"));
    });
  };

  let body: React.ReactNode;
  let primary: DialogAction | undefined;
  let secondary: DialogAction = { label: "Cancel", onClick: onClose, disabled: busy };

  if (added && status?.pendingCreate) {
    // Ahead of every other state, the form's prerequisites too: nothing goes on until the
    // person chooses, and closing this leaves the order open on the host's details.
    body = (
      <div className="space-y-4" data-testid="add-cloud-host-offers">
        <p className="text-sm text-text-primary">
          Bidders answer the order with offers. Lease one to create the machine at its price.
        </p>
        <CloudOfferChoice
          key={status.pendingCreate.order.id}
          hostId={added.hostId}
          choice={status.pendingCreate}
          name="add-cloud-host-offer"
          surface="dialog"
          problem={status.providerUnavailable ?? status.lastError?.message ?? null}
        />
        <p className="text-xs text-text-secondary">
          {`You can close this and choose an offer later in Settings → Hosts → ${added.name}.`}
        </p>
      </div>
    );
    secondary = { label: "Close", onClick: onClose };
  } else if (added && hostGone) {
    body = (
      <p className="text-sm text-text-primary" data-testid="add-cloud-host-gone">
        {`${added.name} is no longer in your host list.`}
      </p>
    );
    secondary = { label: "Close", onClick: onClose };
  } else if (!provider) {
    body = (
      <Callout severity="info">
        {snapshot.providers[0]?.unsupportedReason ??
          "No cloud provider is available on this machine."}
      </Callout>
    );
  } else if (!account) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {`Connect a cloud provider account first. Daintree uses its ${usable.length > 0 && usable.every((entry) => credentialsNoun(entry) === "key") ? "API key" : "credentials"} to ${machineVerbs(usable)}; the account pays for them.`}
        </p>
        <div className="flex flex-wrap gap-2">
          {usable.map((entry) => (
            <Button key={entry.id} variant="outline" size="sm" onClick={() => setConnecting(entry)}>
              Connect {entry.name} account
            </Button>
          ))}
        </div>
      </div>
    );
    primary = undefined;
  } else if (added) {
    const machine = status?.machine ?? "not-created";
    const operation = status?.operation ?? null;
    const failed = status?.lastError && !operation;
    const startable = status !== null && canStartMachine(status, addedProvider);
    // Unknown is no reason to offer Start: the way forward is asking again.
    const unknown = machine === "unknown" && !operation;
    const stoppedImport = mode === "import" && !startRequested && startable;
    // Nothing brings back a machine whose provider has no stop: say what it is, not progress.
    const settledDown =
      !failed &&
      !operation &&
      isDeleteOnly(addedProvider) &&
      (machine === "stopped" || machine === "error");
    // The provider the machine is bound to, which a create refused for its tunnel command names.
    const addedTunnelMissing =
      failed && status?.lastError?.code === "ssh-tunnel-command-missing"
        ? (cloudProviderFor(snapshot.providers, status)?.capabilities.tunnel ?? null)
        : null;
    const parked = status?.asleep ? "asleep" : "stopped";
    body = (
      <div className="space-y-4" data-testid="add-cloud-host-progress">
        {stoppedImport ? (
          <p className="text-sm text-text-primary">
            {`It's in your host list. Its machine is ${status?.asleep ? "asleep" : cloudMachineLabel(machine).toLowerCase()}, and Daintree didn't start it.`}
          </p>
        ) : unknown ? (
          <p className="text-sm text-text-primary">
            {`It's in your host list, but Daintree couldn't check its machine's state. It may still be running and billing ${status?.accountName ?? "its account"}.`}
          </p>
        ) : settledDown ? (
          <p className="text-sm text-text-primary">
            {`It's in your host list. Its machine reports ${cloudMachineLabel(machine).toLowerCase()}, and machines on ${addedProvider?.name ?? "its provider"} can't be started again. ${DELETE_ONLY_LOSS}`}
          </p>
        ) : (
          !failed && (
            <>
              {/* The step under way is the headline; the bar only says that something is. */}
              <p className="text-sm font-medium text-text-primary" aria-live="polite">
                {operation?.stage || cloudMachineLabel(machine)}
              </p>
              <ProgressBar
                label="Machine progress"
                valueText={operation?.stage || cloudMachineLabel(machine)}
              />
              <p className="text-xs text-text-secondary">
                {`${typicalStart(provider)}Closing this doesn't stop it: the host's row in Settings → Hosts follows it, and setup carries on from there.`}
              </p>
            </>
          )
        )}
        {stoppedImport && status && (
          <p className="text-sm text-text-secondary">
            {`Start it now to set up Daintree there${hourlyShort(status.hourlyDollars) ? `; it bills ${status.accountName} ${hourlyShort(status.hourlyDollars)} while it runs` : ""}. Or leave it ${parked} and start it from the host menu when you need it.${stoppedBillingSentence(provider) ? ` ${stoppedBillingSentence(provider)}` : ""}`}
          </p>
        )}
        {failed && status?.lastError && (
          <Callout severity="error" title="The machine isn't ready">
            <p>{status.lastError.message}</p>
            {addedTunnelMissing && (
              <div className="mt-3">
                <TunnelSetupCommands tunnel={addedTunnelMissing} from="install" />
              </div>
            )}
          </Callout>
        )}
      </div>
    );
    if (stoppedImport) {
      primary = { label: "Start machine", onClick: startAdded };
      secondary = { label: `Leave ${parked}`, onClick: onClose };
    } else if (unknown) {
      primary = { label: "Check status", onClick: checkAdded };
      secondary = { label: "Close", onClick: onClose };
    } else if (settledDown) {
      secondary = { label: "Close", onClick: onClose };
    } else if (failed && status?.resourceId === null) {
      primary = { label: "Retry", onClick: retry };
      secondary = { label: "Close", onClick: onClose };
    } else if (failed && startable) {
      primary = { label: "Start machine", onClick: startAdded };
      secondary = { label: "Close", onClick: onClose };
    } else if (failed) {
      // Whatever it is doing now, starting isn't the answer: the row follows it.
      secondary = { label: "Close", onClick: onClose };
    } else {
      // Closing leaves the machine coming up; the host's row follows it.
      secondary = { label: "Close", onClick: onClose };
    }
  } else {
    const lifetimeModel = provider.capabilities.lifetime;
    // Priced only by the offers an order draws, so no size carries a list price here.
    const offerBased = provider.createMode === "offers";
    // Boat's review keeps its own words; every other model says it as the start confirm does.
    const reviewLifetime =
      lifetimeModel.kind === "renewable"
        ? lifetimeHours === null
          ? "It runs until you stop it."
          : `It stops by itself ${lifetimeLabel(lifetimeHours).toLowerCase()} after starting unless it's in use here.`
        : lifetimeSentence(
            lifetimeModel,
            lifetimeHours === null ? null : lifetimeHours * 3600,
            provider
          );
    body = (
      <div className="space-y-5">
        {accounts.length > 1 && (
          <Field>
            <FieldLabel>Account</FieldLabel>
            <Select
              value={account.id}
              onValueChange={(value) => setAccountId(value)}
              disabled={busy}
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.displayName}
                    {usable.length > 1 && (
                      <>
                        {" "}
                        <FactSeparator />{" "}
                        {usable.find((p) => p.id === entry.providerId)?.name ?? entry.providerId}
                      </>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        <SegmentedRadioGroup<Mode>
          aria-label="New or existing machine"
          value={mode}
          onChange={setMode}
          disabled={busy}
          testId="add-cloud-host-mode"
          options={[
            { value: "create", label: "New machine" },
            { value: "import", label: "Existing machine" },
          ]}
        />
        {mode === "create" ? (
          <>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={name}
                placeholder="build-host"
                disabled={busy}
                data-testid="add-cloud-host-name"
                onChange={(e) => setName(e.target.value)}
              />
              <FieldDescription>What the host menu and window titles call it</FieldDescription>
            </Field>
            {currentCatalog &&
              dimensions.map((dimension) => {
                const description = provisioningChoiceDescription(form, dimension);
                return (
                  <Field key={dimension}>
                    <FieldLabel>{currentCatalog.provisioning[dimension]!.label}</FieldLabel>
                    <CloudProvisioningSelect
                      form={form}
                      provider={provider}
                      dimension={dimension}
                      disabled={busy}
                      inField
                      className="w-72"
                      data-testid={`add-cloud-host-${dimension}`}
                    />
                    {description && <FieldDescription>{description}</FieldDescription>}
                  </Field>
                );
              })}
            {provisioningProblem && (
              <p
                className="text-sm text-text-secondary"
                data-testid="add-cloud-host-provisioning-problem"
              >
                {provisioningProblem}
              </p>
            )}
            {catalogError ? (
              <Callout
                severity="error"
                action={
                  <Button variant="outline" size="sm" onClick={form.retryCatalog}>
                    Retry
                  </Button>
                }
              >
                {catalogError}
              </Callout>
            ) : (
              <RadioChoiceGroup legend="Size">
                {offerBased && (
                  <p
                    className="text-xs text-text-secondary"
                    data-testid="add-cloud-host-offer-pricing"
                  >
                    {`No list price: once the machine is ordered, ${provider.name}'s bidders quote one in their offers, and you choose between them.`}
                  </p>
                )}
                {machineTypes.map((type) => (
                  <RadioChoiceRow
                    key={type.id}
                    name="cloud-machine-size"
                    value={type.id}
                    checked={machineType === type.id}
                    disabled={!type.available || busy}
                    onChange={() => form.setMachineType(type.id)}
                    label={`${type.label} · ${machineSpecLabel(type.vcpu, type.memoryGB)}`}
                    description={
                      !type.available
                        ? sentenceCase(type.reason ?? "Not available on this account")
                        : offerBased
                          ? undefined
                          : formatHourly(type.hourlyDollars)
                    }
                  />
                ))}
                {!currentCatalog && <p className="text-sm text-text-secondary">Reading sizes…</p>}
              </RadioChoiceGroup>
            )}
            {lifetimeChosen ? (
              <Field>
                <FieldLabel>Stops by itself after</FieldLabel>
                <Select value={lifetime} onValueChange={form.setLifetime} disabled={busy}>
                  <SelectTrigger className="w-52" data-testid="add-cloud-host-lifetime">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIFETIME_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {lifetimeLabel(value === "never" ? null : Number(value))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {lifetimeModel.kind === "renewable"
                    ? "Counted from each start, and pushed back while a window here shows it or its agents are working. A guard against a machine left running, not a spending limit."
                    : lifetimeHours === null
                      ? `${provider.name} can't extend a limit while the machine runs; with none, nothing on ${provider.name}'s side stops it.`
                      : `Counted from each start. ${provider.name} can't extend it while the machine runs, so it stops then even if its agents are still working.`}
                </FieldDescription>
              </Field>
            ) : (
              <p className="text-sm text-text-secondary" data-testid="add-cloud-host-lifetime-note">
                {providerStopSentence(lifetimeModel, provider.name, provider.stopMode)}
              </p>
            )}
            {chosenType?.available && (
              <p className="text-xs text-text-secondary" data-testid="add-cloud-host-review">
                Billed to{" "}
                {account.billingScope.kind === "personal"
                  ? `${account.identity ?? account.displayName}'s personal account`
                  : account.billingScope.name}{" "}
                on {provider.name}
                {!offerBased &&
                  chosenType.hourlyDollars !== null &&
                  `, about $${chosenType.hourlyDollars.toFixed(3)} an hour while it runs`}
                {offerBased && ", at the price of the offer you lease"}. {reviewLifetime}{" "}
                {isDeleteOnly(provider)
                  ? DELETE_ONLY_LOSS
                  : `Stopping ends what runs on it.${stoppedBillingSentence(provider) ? ` ${stoppedBillingSentence(provider)}` : ""} ${stopKeepsSentence(provider.capabilities.persistence)}`}
              </p>
            )}
            {tunnel && tunnelState !== "none" && (
              // Mounted with the form, so each change to what was found is announced.
              <div aria-live="polite" data-testid="add-cloud-host-tunnel">
                {tunnelState === "checking" && (
                  <p
                    className="text-xs text-text-secondary"
                    data-testid="add-cloud-host-tunnel-checking"
                  >
                    {`Looking for ${tunnel.command} on this device…`}
                  </p>
                )}
                {tunnelState === "found" && (
                  // Found after an install opened in a terminal: signing in is the step left.
                  <div className="space-y-2">
                    <p
                      className="text-xs text-text-secondary"
                      data-testid="add-cloud-host-tunnel-found"
                    >
                      {`Daintree reaches ${provider.name} machines through the ${tunnel.command} command on this device, which has to be signed in.`}
                    </p>
                    <TunnelSetupCommands tunnel={tunnel} from="sign-in" />
                  </div>
                )}
                {tunnelState === "missing" && (
                  <Callout severity="warning" data-testid="add-cloud-host-tunnel-missing">
                    <p>
                      {`${provider.name} machines are reached through its ${tunnel.command} command, which isn't installed on this device or isn't on Daintree's PATH. Install it and sign in to it, then check again.`}
                    </p>
                    {hasTunnelSetupCommands(tunnel, "install") && (
                      <div className="mt-3">
                        <TunnelSetupCommands tunnel={tunnel} from="install" />
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!tunnel.installCommand && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void systemClient.openExternal(tunnel.installUrl)}
                        >
                          <ExternalLink aria-hidden="true" />
                          Get {tunnel.command}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        loading={tunnelPending}
                        onClick={checkTunnelAgain}
                      >
                        Check again
                      </Button>
                    </div>
                  </Callout>
                )}
                {tunnelState === "failed" && (
                  <Callout
                    severity="error"
                    data-testid="add-cloud-host-tunnel-failed"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        loading={tunnelPending}
                        onClick={checkTunnelAgain}
                      >
                        Check again
                      </Button>
                    }
                  >
                    {tunnelAnswer?.error}
                  </Callout>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {resourcesError ? (
              <Callout
                severity="error"
                action={
                  <Button variant="outline" size="sm" onClick={() => setResourcesTry((n) => n + 1)}>
                    Retry
                  </Button>
                }
              >
                {resourcesError}
              </Callout>
            ) : resources === null ? (
              <p className="text-sm text-text-secondary">Listing machines…</p>
            ) : resources.length === 0 ? (
              <p className="text-sm text-text-secondary">
                {account.displayName} has no machines yet. Create a new one instead.
              </p>
            ) : (
              <RadioChoiceGroup legend="Machine">
                {resources.map((resource) => (
                  <RadioChoiceRow
                    key={resource.resourceId}
                    name="cloud-machine"
                    value={resource.resourceId}
                    checked={resourceId === resource.resourceId}
                    disabled={
                      resource.boundHostId !== null ||
                      resource.restricted ||
                      resource.dataExpired ||
                      busy
                    }
                    onChange={() => {
                      setResourceId(resource.resourceId);
                      if (!name.trim()) setName(resource.name);
                    }}
                    label={resource.name || resource.resourceId}
                    description={
                      resource.boundHostId !== null
                        ? "Already in your host list"
                        : resource.restricted
                          ? "A teammate's private machine"
                          : resource.dataExpired
                            ? "Its saved disk was deleted"
                            : [
                                resource.asleep ? "Asleep" : cloudMachineLabel(resource.machine),
                                machineSpecLabel(resource.vcpu, resource.memoryGB),
                                stoppedBillingFact(resource, provider),
                              ]
                                .filter(Boolean)
                                .join(" · ")
                    }
                  />
                ))}
              </RadioChoiceGroup>
            )}
            {chosenResource && (
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
                <FieldDescription data-testid="add-cloud-host-import-note">
                  {lifetimeModel.kind === "idle-sleep"
                    ? // Each machine's own setting decides whether it sleeps; this one's may be off.
                      `Adding it doesn't start it or change whether ${provider.name} puts it to sleep when idle.`
                    : importNote(
                        isDeleteOnly(provider)
                          ? "Adding it doesn't change it"
                          : "Adding it doesn't start it or change its auto-stop",
                        providerStopSentence(lifetimeModel, provider.name, provider.stopMode),
                        isDeleteOnly(provider) ? DELETE_ONLY_LOSS : null,
                        // Nothing can hand this device's key to a machine that didn't take it when it was made.
                        provider.capabilities.provisioning.sshKey === "at-create"
                          ? `${provider.name} takes an SSH key only when a machine is created, so Daintree connects only to one that already accepts this account's key from this device`
                          : null
                      )}
                </FieldDescription>
              </Field>
            )}
          </>
        )}
        {(mode === "create" || chosenResource) && (
          <Field orientation="horizontal" disabled={busy}>
            <Checkbox
              checked={mcpServerOnConnect[mode]}
              disabled={busy}
              data-testid="add-cloud-host-mcp-server"
              onCheckedChange={(checked) =>
                setMcpServerOnConnect((current) => ({ ...current, [mode]: checked === true }))
              }
            />
            <FieldLabel>Turn on its MCP server</FieldLabel>
            <FieldDescription>
              Lets your assistant run tools there through Daintree once it connects. Its HTTP
              listener binds to 127.0.0.1 only; turn it off on the host in Settings → Integrations →
              MCP server.
            </FieldDescription>
          </Field>
        )}
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    );
    primary =
      mode === "create"
        ? {
            // Create only places the order there: the machine comes from the offer leased.
            label: offerBased ? "Get offers" : "Create and connect",
            onClick: create,
            disabled:
              busy ||
              !trimmedName ||
              !chosenType?.available ||
              !currentCatalog ||
              provisioningProblem !== null ||
              !tunnelReady,
            loading: busy,
          }
        : {
            label: "Add machine",
            onClick: importMachine,
            disabled: busy || !chosenResource,
            loading: busy,
          };
  }

  return (
    <InstallCommandHandoffContext.Provider
      // A command opens in a terminal once Settings closes; never while a create or import is
      // sent. Dismissed first, so a close Settings holds shows why, and nothing starts meanwhile.
      value={
        busy || !inheritedHandoff
          ? null
          : (open) => {
              onClose();
              inheritedHandoff(open);
            }
      }
    >
      <AppDialog
        isOpen={isOpen && connecting === null}
        onClose={onClose}
        size="md"
        dismissible={!busy}
        data-testid="add-cloud-host-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>
            {added
              ? `${mode === "create" ? "Creating" : "Adding"} ${added.name}`
              : `Add a cloud machine${provider && (account || usable.length === 1) ? ` on ${provider.name}` : ""}`}
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          {body}
          {added && error && <InlineError role="alert">{error}</InlineError>}
        </AppDialog.Body>
        <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} />
      </AppDialog>
      {connectingProvider && (
        <ConnectCloudAccountDialog
          isOpen
          onClose={() => setConnecting(null)}
          provider={connectingProvider}
          onConnected={(connected) => setAccountId(connected.id)}
        />
      )}
    </InstallCommandHandoffContext.Provider>
  );
}
