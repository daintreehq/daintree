import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { useCloudMachineActions } from "@/components/Hosts/cloud/useCloudMachineActions";
import {
  canStartMachine,
  canStopMachine,
  cloudStatusLabel,
  formatHourly,
  lifetimeLabel,
  machineSpecLabel,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { CLOUD_LIFETIME_CHOICES } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsSelect } from "../SettingsSelect";

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

function clockTime(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** "30 minutes", "3 hours", "90 minutes": a lifetime none of the choices name. */
function secondsLabel(seconds: number): string {
  if (seconds % 3600 === 0) return lifetimeLabel(seconds / 3600);
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const LIFETIME_VALUES = CLOUD_LIFETIME_CHOICES.map((hours) =>
  hours === null ? "never" : String(hours)
);

/**
 * A cloud host's machine, on its details page: what the provider says it is
 * doing, Start and Stop, what it costs, when it stops by itself, and the
 * technical facts (machine id, address, host key) for support.
 */
export function CloudMachineSection({ hostId, hostName }: { hostId: HostId; hostName: string }) {
  const { snapshot } = useCloudHosts();
  const status = cloudStatusFor(snapshot, hostId);
  const machines = useCloudMachineActions();
  const [busy, setBusy] = useState<"refresh" | "retry" | "lifetime" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifetimeError, setLifetimeError] = useState<string | null>(null);
  if (!status) return null;
  const provider = snapshot.providers.find((entry) => entry.id === status.providerId);
  const providerName = provider?.name ?? status.providerId;
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
      ? [{ value: "current", label: secondsLabel(status.lifetimeSeconds), disabled: true }]
      : []),
    ...LIFETIME_VALUES.map((value) => ({
      value,
      label: lifetimeLabel(value === "never" ? null : Number(value)),
    })),
  ];
  const autoStop = clockTime(status.autoStopAt);

  const act = (kind: "refresh" | "retry", work: () => Promise<void>, fallback: string) => {
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
            <span data-testid="cloud-machine-state">
              {cloudStatusLabel(status)}
              {stateDetail && ` · ${stateDetail}`}
              {status.machine === "stopped" && status.stoppedAt && (
                <>
                  {" · "}
                  <TimeAgo prefix="Stopped " timestamp={Date.parse(status.stoppedAt)} />
                </>
              )}
            </span>
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
              {canStopMachine(status) && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={machines.isPending(hostId)}
                  onClick={() => machines.requestStop(hostId, hostName)}
                >
                  Stop
                </Button>
              )}
              {status.resourceId !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === "refresh"}
                  onClick={() =>
                    act(
                      "refresh",
                      () => cloudHostsClient.refreshHost(hostId),
                      "Couldn't ask about the machine"
                    )
                  }
                >
                  Refresh
                </Button>
              )}
            </div>
          }
        />
        <SettingsRow
          label="Account"
          description={`${providerName} · ${status.accountName}${status.ownership === "imported" ? " · Added from the account" : ""}`}
        />
        <SettingsRow
          label="Size"
          description={`${status.machineType ? `${status.machineType[0]!.toUpperCase()}${status.machineType.slice(1)} · ` : ""}${machineSpecLabel(status.vcpu, status.memoryGB)} · ${formatHourly(status.hourlyDollars)}`}
        />
        <SettingsSelect
          label="Stops by itself after"
          description={
            running
              ? autoStop
                ? `This run stops by itself ${autoStop}. A change applies from now`
                : "This run doesn't stop by itself. A change applies from now"
              : "Each start sets it: a guard against a machine left running"
          }
          value={lifetimeValue}
          onValueChange={setLifetime}
          options={lifetimeOptions}
          disabled={busy === "lifetime" || status.operation !== null}
          error={lifetimeError ?? undefined}
        />
        <SettingsRow
          label="Disk"
          description={
            status.dataExpired
              ? `${providerName} deleted its saved disk after its retention period`
              : status.lastSnapshotAt
                ? `Saved when it stops. Last saved ${clockTime(status.lastSnapshotAt)}`
                : "Saved when it stops"
          }
        />
        <SettingsRow
          label="Technical details"
          layout="stacked"
          description={
            <span className="select-text break-all font-mono text-2xs">
              {status.resourceId ? `Machine ${status.resourceId}` : "No machine yet"}
              {status.lastEndpoint && ` · SSH ${status.lastEndpoint}`}
              {status.hostKeyFingerprint && ` · Host key ${status.hostKeyFingerprint}`}
              {status.observedAt !== null && (
                <>
                  {" · "}
                  <TimeAgo prefix="Checked " timestamp={status.observedAt} />
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
