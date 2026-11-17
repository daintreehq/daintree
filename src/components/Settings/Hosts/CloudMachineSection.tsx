import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useNow } from "@/hooks/useNow";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { useCloudMachineActions } from "@/components/Hosts/cloud/useCloudMachineActions";
import {
  canStartMachine,
  canStopMachine,
  clockTime,
  cloudCostFacts,
  cloudProviderFor,
  cloudStateWord,
  diskSentence,
  durationLabel,
  formatHourly,
  isObservationStale,
  lifetimeLabel,
  machineSpecLabel,
  stoppedBillingSentence,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  CLOUD_LIFETIME_CHOICES,
  CLOUD_PROVISIONING_DIMENSIONS,
  type CloudHostCreatedFor,
} from "@shared/types/cloudHosts";
import type { HostId, HostMetricsSummary } from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsSelect } from "../SettingsSelect";
import { HostIdleTimeRow } from "./HostIdleTimeRow";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/** The worktree as it was named when the machine was made for it; it may since be gone. */
function createdForLabel(mark: CloudHostCreatedFor): string {
  const where = `${mark.worktreeName} in ${mark.projectName}`;
  return mark.hostName === null ? where : `${where} on ${mark.hostName}`;
}

const LIFETIME_VALUES = CLOUD_LIFETIME_CHOICES.map((hours) =>
  hours === null ? "never" : String(hours)
);

/**
 * A cloud host's machine, on its details page: what the provider says it is
 * doing, Start and Stop, what it costs, when it stops by itself, how long the
 * host waits once idle, and the technical facts (machine id, address, host
 * key) for support.
 */
export function CloudMachineSection({
  hostId,
  hostName,
  connected,
  liveSummary,
}: {
  hostId: HostId;
  hostName: string;
  connected: boolean;
  /** The host's latest summary while its link is up; null otherwise. */
  liveSummary: HostMetricsSummary | null;
}) {
  const { snapshot } = useCloudHosts();
  const status = cloudStatusFor(snapshot, hostId);
  const machines = useCloudMachineActions();
  const [busy, setBusy] = useState<"retry" | "lifetime" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifetimeError, setLifetimeError] = useState<string | null>(null);
  const now = useNow(status !== null);
  if (!status) return null;
  // An old reading is the last one, not the machine now: its facts say so.
  const stale = status.machine !== "unknown" && isObservationStale(status, now);
  const checkedAt =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
  const provider = cloudProviderFor(snapshot.providers, status);
  const providerName = provider?.name ?? status.providerId;
  // Beside Stop, and beside a stopped machine: a provider that bills it stopped says so.
  const stoppedBilling =
    status.machine === "stopped" || canStopMachine(status)
      ? stoppedBillingSentence(provider)
      : null;
  const actionError = machines.errorFor(hostId) ?? error;
  const shownError =
    actionError ?? (status.operation === null ? (status.lastError?.message ?? null) : null);
  const presetValue =
    status.lifetimeSeconds === null
      ? "never"
      : status.lifetimeSeconds % 3600 === 0 &&
          LIFETIME_VALUES.includes(String(status.lifetimeSeconds / 3600))
        ? String(status.lifetimeSeconds / 3600)
        : null;
  // An imported machine may carry a lifetime none of the choices name: shown as it is.
  const lifetimeValue = presetValue ?? "current";
  const lifetimeOptions = [
    ...(presetValue === null && status.lifetimeSeconds !== null
      ? [{ value: "current", label: durationLabel(status.lifetimeSeconds), disabled: true }]
      : []),
    ...LIFETIME_VALUES.map((value) => ({
      value,
      label: lifetimeLabel(value === "never" ? null : Number(value)),
    })),
  ];
  const autoStop = clockTime(status.autoStopAt);

  const act = (kind: "retry", work: () => Promise<void>, fallback: string) => {
    setBusy(kind);
    setError(null);
    work().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err, fallback));
      }
    );
  };

  const setLifetime = (value: string) => {
    if (value === "current") return;
    setBusy("lifetime");
    setLifetimeError(null);
    cloudHostsClient.setLifetime(hostId, value === "never" ? null : Number(value)).then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setLifetimeError(errorText(err, "Couldn't change when it stops"));
      }
    );
  };
  const running = status.machine === "running";

  // What Daintree is doing to it, in its own words; the provider's raw state stays in diagnostics.
  const stateDetail = status.operation?.stage || null;

  return (
    <SettingsSection title="Cloud machine" id="host-cloud-machine">
      <SettingsGroup>
        <SettingsRow
          label="Machine"
          description={
            <>
              <span data-testid="cloud-machine-state">
                {[
                  stale
                    ? `Last reported ${cloudStateWord(status).toLowerCase()}`
                    : cloudStateWord(status),
                  stateDetail,
                  ...cloudCostFacts(status, provider),
                ]
                  .filter((fact): fact is string => Boolean(fact))
                  .join(" · ")}
                {status.machine === "stopped" && status.stoppedAt && (
                  <>
                    {" "}
                    <FactSeparator />{" "}
                    <TimeAgo prefix="stopped " timestamp={Date.parse(status.stoppedAt)} />
                  </>
                )}
                {status.observedAt !== null && (
                  <>
                    {" "}
                    <FactSeparator />{" "}
                    <TimeAgo
                      prefix={status.machine === "unknown" ? "last asked " : "checked "}
                      timestamp={status.observedAt}
                      now={now}
                    />
                  </>
                )}
              </span>
              {stoppedBilling && (
                <span className="block" data-testid="cloud-machine-stopped-billing">
                  {stoppedBilling}
                </span>
              )}
            </>
          }
          error={shownError ? <span role="alert">{shownError}</span> : undefined}
          control={
            <div className="flex items-center gap-1.5">
              {status.resourceId === null && status.operation === null && status.lastError && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === "retry"}
                  onClick={() =>
                    act(
                      "retry",
                      () => cloudHostsClient.retryCreate(hostId),
                      "Couldn't create the machine"
                    )
                  }
                >
                  Retry
                </Button>
              )}
              {canStartMachine(status) && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={machines.isPending(hostId)}
                  onClick={() => machines.start(hostId)}
                >
                  Start
                </Button>
              )}
              {status.resourceId !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={machines.isPending(hostId)}
                  // Shared with the rows and menu: a failed check yields to the next good reading.
                  onClick={() => machines.check(hostId)}
                >
                  Check status
                </Button>
              )}
              {canStopMachine(status) && (
                // Ends what runs there: destructive, and last.
                <Button
                  variant="ghost-danger"
                  size="sm"
                  loading={machines.isPending(hostId)}
                  onClick={() => machines.requestStop(hostId, hostName)}
                >
                  Stop
                </Button>
              )}
            </div>
          }
        />
        <SettingsRow
          label="Account"
          description={`${providerName} · ${status.accountName}${status.ownership === "imported" ? " · Added from the account" : ""}`}
        />
        {status.createdFor && (
          <SettingsRow
            label="Created for"
            description={
              <span data-testid="cloud-machine-created-for">
                {createdForLabel(status.createdFor)}
              </span>
            }
          />
        )}
        <SettingsRow
          label="Size"
          description={`${status.machineType ? `${status.machineType[0]!.toUpperCase()}${status.machineType.slice(1)} · ` : ""}${machineSpecLabel(status.vcpu, status.memoryGB)} · ${formatHourly(status.hourlyDollars)}`}
        />
        {CLOUD_PROVISIONING_DIMENSIONS.map((dimension) => {
          // As it was named at create, so it reads the same with the provider gone.
          const pick = status.provisioning?.[dimension];
          if (!pick) return null;
          return (
            <SettingsRow
              key={dimension}
              label={pick.label}
              description={
                <span data-testid={`cloud-machine-${dimension}`}>
                  {pick.id !== null && pick.id !== pick.value
                    ? `${pick.value} · ${pick.id}`
                    : pick.value}
                </span>
              }
            />
          );
        })}
        <SettingsSelect
          label="Stops by itself after"
          description={
            (stale && running && checkedAt ? `As last reported ${checkedAt}: ` : "") +
            (running
              ? autoStop
                ? status.lifetimeSeconds === null
                  ? `This run stops by itself ${autoStop}. A change applies from now.`
                  : `This run stops by itself ${autoStop}${status.keptRunningAt !== null ? `, pushed back ${clockTime(new Date(status.keptRunningAt).toISOString())}` : ""}. Daintree pushes it back while a window here shows it or its agents are working; a change applies from now.`
                : "This run doesn't stop by itself. A change applies from now."
              : "Counted from each start, and pushed back while a window here shows it or its agents are working. A guard against a machine left running, not a spending limit.")
          }
          value={lifetimeValue}
          onValueChange={setLifetime}
          options={lifetimeOptions}
          disabled={busy === "lifetime" || status.operation !== null}
          error={lifetimeError ?? undefined}
        />
        <HostIdleTimeRow
          key={hostId}
          hostId={hostId}
          hostName={hostName}
          connected={connected}
          idle={liveSummary?.idle}
          sampledAt={liveSummary?.sampledAt ?? null}
        />
        <SettingsRow
          label="Disk"
          description={
            status.dataExpired
              ? `${providerName} deleted its saved disk after its retention period, so it can't start again`
              : `${status.lastSnapshotAt ? `Last saved ${clockTime(status.lastSnapshotAt)}` : "No completed save reported yet"}.${provider ? ` ${diskSentence(provider.capabilities.persistence)}` : ""}`
          }
        />
        <SettingsRow
          label="Technical details"
          layout="stacked"
          description={
            <span className="select-text break-all font-mono text-2xs">
              {status.resourceId ? `Machine ${status.resourceId}` : "No machine yet"}
              {status.lastEndpoint && (
                <>
                  {" "}
                  <FactSeparator /> SSH {status.lastEndpoint}
                </>
              )}
              {status.hostKeyFingerprint && (
                <>
                  {" "}
                  <FactSeparator /> Host key {status.hostKeyFingerprint}
                </>
              )}
            </span>
          }
        />
      </SettingsGroup>
      {machines.dialogs}
    </SettingsSection>
  );
}
