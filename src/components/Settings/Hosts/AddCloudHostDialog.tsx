import { useEffect, useRef, useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
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
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  cloudMachineLabel,
  type CloudProviderInfo,
  type CloudResourceSummary,
} from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { ConnectCloudAccountDialog } from "./ConnectCloudAccountDialog";
import { CloudProvisioningSelect, provisioningChoiceDescription } from "./CloudProvisioningSelect";
import { LIFETIME_VALUES, useCloudMachineForm } from "./useCloudMachineForm";
import {
  canStartMachine,
  credentialsNoun,
  formatHourly,
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
  // Accounts only on providers this machine can use; the machine comes from whichever pays.
  const accounts = snapshot.accounts.filter((entry) =>
    usable.some((provider) => provider.id === entry.providerId)
  );
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  const account = accounts.find((entry) => entry.id === accountId) ?? accounts[0] ?? null;
  const provider = account
    ? (usable.find((entry) => entry.id === account.providerId) ?? null)
    : (usable[0] ?? null);
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [resources, setResources] = useState<CloudResourceSummary[] | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  // Bumped by Retry: reads again without touching what's been filled in.
  const [resourcesTry, setResourcesTry] = useState(0);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<CloudProviderInfo | null>(null);
  /** The host this dialog added; its machine's progress is followed from the cloud snapshot. */
  const [added, setAdded] = useState<{ hostId: HostId; name: string } | null>(null);
  const [startRequested, setStartRequested] = useState(false);

  const status = cloudStatusFor(snapshot, added?.hostId);
  const accountKey = account?.id ?? null;
  const form = useCloudMachineForm(account, provider, added === null);
  const {
    catalog,
    currentCatalog,
    catalogError,
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

  // Hand over to setup once the machine runs.
  const ready = added !== null && status?.machine === "running" && status.operation === null;
  // A stopped import only gets here once someone starts it; a running one at once.
  const handedOver = useRef(false);
  useEffect(() => {
    if (!ready || !added || handedOver.current) return;
    handedOver.current = true;
    onReady(added);
  }, [ready, added, onReady]);

  const chosenResource = resources?.find((resource) => resource.resourceId === resourceId) ?? null;
  const trimmedName = name.trim();

  const create = () => {
    const request = form.request(trimmedName);
    if (!request) return;
    setBusy(true);
    setError(null);
    cloudHostsClient.createHost(request).then(
      ({ hostId }) => {
        setBusy(false);
        setAdded({ hostId, name: trimmedName });
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err, "Couldn't create the machine"));
      }
    );
  };

  const importMachine = () => {
    if (!account || !chosenResource) return;
    const hostName = trimmedName || chosenResource.name;
    setBusy(true);
    setError(null);
    cloudHostsClient
      .importHost({ accountId: account.id, resourceId: chosenResource.resourceId, name: hostName })
      .then(
        ({ hostId }) => {
          setBusy(false);
          setAdded({ hostId, name: hostName });
        },
        (err: unknown) => {
          setBusy(false);
          setError(errorText(err, "Couldn't add the machine"));
        }
      );
  };

  const startAdded = () => {
    if (!added) return;
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

  if (!provider) {
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
          {`Connect a cloud provider account first. Daintree uses its ${usable.length > 0 && usable.every((entry) => credentialsNoun(entry) === "key") ? "API key" : "credentials"} to create, start${usable.every((entry) => entry.capabilities.deletion) ? ", stop and delete" : " and stop"} machines; the account pays for them.`}
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
    const startable = status !== null && canStartMachine(status);
    // Unknown is no reason to offer Start: the way forward is asking again.
    const unknown = machine === "unknown" && !operation;
    const stoppedImport = mode === "import" && !startRequested && startable;
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
            {status.lastError.message}
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
    // Boat's review keeps its own words; every other model says it as the start confirm does.
    const reviewLifetime =
      lifetimeModel.kind === "renewable"
        ? lifetimeHours === null
          ? "It runs until you stop it."
          : `It stops by itself ${lifetimeLabel(lifetimeHours).toLowerCase()} after starting unless it's in use here.`
        : lifetimeSentence(lifetimeModel, lifetimeHours === null ? null : lifetimeHours * 3600);
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
                {(catalog?.machineTypes ?? []).map((type) => (
                  <RadioChoiceRow
                    key={type.id}
                    name="cloud-machine-size"
                    value={type.id}
                    checked={machineType === type.id}
                    disabled={!type.available || busy}
                    onChange={() => form.setMachineType(type.id)}
                    label={`${type.label} · ${machineSpecLabel(type.vcpu, type.memoryGB)}`}
                    description={
                      type.available
                        ? formatHourly(type.hourlyDollars)
                        : sentenceCase(type.reason ?? "Not available on this account")
                    }
                  />
                ))}
                {!catalog && <p className="text-sm text-text-secondary">Reading sizes…</p>}
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
                      ? `${provider.name} can't extend a limit while the machine runs; with none, it runs until you stop it.`
                      : `Counted from each start. ${provider.name} can't extend it while the machine runs, so it stops then even if its agents are still working.`}
                </FieldDescription>
              </Field>
            ) : (
              <p className="text-sm text-text-secondary" data-testid="add-cloud-host-lifetime-note">
                {providerStopSentence(lifetimeModel, provider.name)}
              </p>
            )}
            {chosenType && (
              <p className="text-xs text-text-secondary" data-testid="add-cloud-host-review">
                Billed to{" "}
                {account.billingScope.kind === "personal"
                  ? `${account.identity ?? account.displayName}'s personal account`
                  : account.billingScope.name}{" "}
                on {provider.name}
                {chosenType.hourlyDollars !== null &&
                  `, about $${chosenType.hourlyDollars.toFixed(3)} an hour while it runs`}
                . {reviewLifetime}{" "}
                {`Stopping ends what runs on it.${stoppedBillingSentence(provider) ? ` ${stoppedBillingSentence(provider)}` : ""} ${stopKeepsSentence(provider.capabilities.persistence)}`}
              </p>
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
                        "Adding it doesn't start it or change its auto-stop",
                        providerStopSentence(lifetimeModel, provider.name),
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
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    );
    primary =
      mode === "create"
        ? {
            label: "Create and connect",
            onClick: create,
            disabled:
              busy ||
              !trimmedName ||
              !chosenType?.available ||
              !currentCatalog ||
              provisioningProblem !== null,
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
    <>
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
      {connecting && (
        <ConnectCloudAccountDialog
          isOpen
          onClose={() => setConnecting(null)}
          provider={connecting}
          onConnected={(connected) => setAccountId(connected.id)}
        />
      )}
    </>
  );
}
