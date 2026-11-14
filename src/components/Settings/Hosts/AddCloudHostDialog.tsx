import { useEffect, useRef, useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
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
  CLOUD_LIFETIME_CHOICES,
  DEFAULT_CLOUD_LIFETIME_HOURS,
  cloudMachineLabel,
  type CloudCatalog,
  type CloudResourceSummary,
} from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { ConnectCloudAccountDialog } from "./ConnectCloudAccountDialog";
import {
  canStartMachine,
  formatHourly,
  hourlyShort,
  lifetimeLabel,
  machineSpecLabel,
  sentenceCase,
} from "@/components/Hosts/cloud/cloudHostLabels";

interface AddCloudHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The machine is running: carry on with the usual check, install and Host mode steps. */
  onReady: (host: { hostId: HostId; name: string }) => void;
}

type Mode = "create" | "import";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

const LIFETIME_VALUES = CLOUD_LIFETIME_CHOICES.map((hours) =>
  hours === null ? "never" : String(hours)
);

/**
 * Add a cloud host: create a new machine in a connected account, or add one
 * that already exists there. Nothing billable happens until the person
 * presses Create; an imported machine is never started from here unless they
 * choose to. Once the machine runs, the usual Add host steps (check, install,
 * Host mode, connect) take over through `onReady`.
 */
export function AddCloudHostDialog({ isOpen, onClose, onReady }: AddCloudHostDialogProps) {
  const { snapshot } = useCloudHosts();
  const accounts = snapshot.accounts;
  const provider = snapshot.providers.find((entry) => entry.unsupportedReason === null) ?? null;
  const [accountId, setAccountId] = useState<string | null>(accounts[0]?.id ?? null);
  const account = accounts.find((entry) => entry.id === accountId) ?? accounts[0] ?? null;
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [machineType, setMachineType] = useState<string | null>(null);
  const [lifetime, setLifetime] = useState(String(DEFAULT_CLOUD_LIFETIME_HOURS));
  const [catalog, setCatalog] = useState<CloudCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [resources, setResources] = useState<CloudResourceSummary[] | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  // Bumped by Retry: reads again without touching what's been filled in.
  const [catalogTry, setCatalogTry] = useState(0);
  const [resourcesTry, setResourcesTry] = useState(0);
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** The host this dialog added; its machine's progress is followed from the cloud snapshot. */
  const [added, setAdded] = useState<{ hostId: HostId; name: string } | null>(null);
  const [startRequested, setStartRequested] = useState(false);

  const status = cloudStatusFor(snapshot, added?.hostId);
  const accountKey = account?.id ?? null;

  useEffect(() => {
    if (!accountKey || added) return;
    let current = true;
    setCatalog(null);
    setCatalogError(null);
    cloudHostsClient.getCatalog(accountKey).then(
      (next) => {
        if (!current) return;
        setCatalog(next);
        const preferred =
          next.machineTypes.find((type) => type.id === "default" && type.available) ??
          next.machineTypes.find((type) => type.available) ??
          null;
        setMachineType((chosen) =>
          chosen && next.machineTypes.some((type) => type.id === chosen && type.available)
            ? chosen
            : (preferred?.id ?? null)
        );
      },
      (err: unknown) => {
        if (current) setCatalogError(errorText(err, "Couldn't read the machine sizes"));
      }
    );
    return () => {
      current = false;
    };
  }, [accountKey, added, catalogTry]);

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

  const chosenType = catalog?.machineTypes.find((type) => type.id === machineType) ?? null;
  const chosenResource = resources?.find((resource) => resource.resourceId === resourceId) ?? null;
  const trimmedName = name.trim();

  const create = () => {
    if (!account || !machineType) return;
    setBusy(true);
    setError(null);
    cloudHostsClient
      .createHost({
        accountId: account.id,
        name: trimmedName,
        machineType,
        lifetimeHours: lifetime === "never" ? null : Number(lifetime),
      })
      .then(
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
          Connect a {provider.name} account first. Daintree uses its API key to create, start and
          stop machines; the account pays for them.
        </p>
        <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
          Connect {provider.name} account
        </Button>
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
    body = (
      <div className="space-y-4" data-testid="add-cloud-host-progress">
        {stoppedImport ? (
          <p className="text-sm text-text-primary">
            {`It's in your host list. Its machine is ${cloudMachineLabel(machine).toLowerCase()}, and Daintree didn't start it.`}
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
                {`Boat usually has a machine running in under a minute. Closing this doesn't stop it: the host's row in Settings → Hosts follows it, and setup carries on from there.`}
              </p>
            </>
          )
        )}
        {stoppedImport && status && (
          <p className="text-sm text-text-secondary">
            {`Start it now to set up Daintree there${hourlyShort(status.hourlyDollars) ? `; it bills ${status.accountName} ${hourlyShort(status.hourlyDollars)} while it runs` : ""}. Or leave it stopped and start it from the host menu when you need it.`}
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
      secondary = { label: "Leave stopped", onClick: onClose };
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
    const lifetimeHours = lifetime === "never" ? null : Number(lifetime);
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
            {catalogError ? (
              <Callout
                severity="error"
                action={
                  <Button variant="outline" size="sm" onClick={() => setCatalogTry((n) => n + 1)}>
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
                    onChange={() => setMachineType(type.id)}
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
            <Field>
              <FieldLabel>Stops by itself after</FieldLabel>
              <Select value={lifetime} onValueChange={setLifetime} disabled={busy}>
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
                Counted from each start, and pushed back while a window here shows it or its agents
                are working. A guard against a machine left running, not a spending limit.
              </FieldDescription>
            </Field>
            {chosenType && (
              <p className="text-xs text-text-secondary" data-testid="add-cloud-host-review">
                Billed to{" "}
                {account.billingScope.kind === "personal"
                  ? `${account.identity ?? account.displayName}'s personal account`
                  : account.billingScope.name}{" "}
                on {provider.name}
                {chosenType.hourlyDollars !== null &&
                  `, about $${chosenType.hourlyDollars.toFixed(3)} an hour while it runs`}
                .{" "}
                {lifetimeHours === null
                  ? "It runs until you stop it."
                  : `It stops by itself ${lifetimeLabel(lifetimeHours).toLowerCase()} after starting unless it's in use here.`}{" "}
                Stopping keeps its home folder and ends what runs on it.
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
                            : `${cloudMachineLabel(resource.machine)} · ${machineSpecLabel(resource.vcpu, resource.memoryGB)}`
                    }
                  />
                ))}
              </RadioChoiceGroup>
            )}
            {chosenResource && (
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
                <FieldDescription>
                  Adding it doesn&apos;t start it or change its auto-stop
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
            disabled: busy || !trimmedName || !chosenType?.available,
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
        isOpen={isOpen && !connecting}
        onClose={onClose}
        size="md"
        dismissible={!busy}
        data-testid="add-cloud-host-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>
            {added
              ? `${mode === "create" ? "Creating" : "Adding"} ${added.name}`
              : `Add a cloud machine${provider ? ` on ${provider.name}` : ""}`}
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          {body}
          {added && error && <InlineError role="alert">{error}</InlineError>}
        </AppDialog.Body>
        <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} />
      </AppDialog>
      {connecting && provider && (
        <ConnectCloudAccountDialog
          isOpen
          onClose={() => setConnecting(false)}
          provider={provider}
          onConnected={(connected) => setAccountId(connected.id)}
        />
      )}
    </>
  );
}
