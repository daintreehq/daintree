import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  cloudStateWord,
  durationLabel,
  formatHourly,
  isObservationStale,
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
  const [busy, setBusy] = useState<"retry" | "lifetime" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifetimeError, setLifetimeError] = useState<string | null>(null);
  const now = useNow(status !== null);
  if (!status) return null;
  // An old reading is the last one, not the machine now: its facts say so.
  const stale = status.machine !== "unknown" && isObservationStale(status, now);
  const checkedAt =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
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
            <span data-testid="cloud-machine-state">
              {[
                stale
                  ? `Last reported ${cloudStateWord(status).toLowerCase()}`
                  : cloudStateWord(status),
                stateDetail,
                ...cloudCostFacts(status),
              ]
                .filter((fact): fact is string => Boolean(fact))
                .join(" · ")}
              {status.machine === "stopped" && status.stoppedAt && (
                <>
                  {" · "}
                  <TimeAgo prefix="stopped " timestamp={Date.parse(status.stoppedAt)} />
                </>
              )}
              {status.observedAt !== null && (
                <>
                  {" · "}
                  <TimeAgo
                    prefix={status.machine === "unknown" ? "last asked " : "checked "}
                    timestamp={status.observedAt}
                    now={now}
                  />
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
        <SettingsRow
          label="Size"
          description={`${status.machineType ? `${status.machineType[0]!.toUpperCase()}${status.machineType.slice(1)} · ` : ""}${machineSpecLabel(status.vcpu, status.memoryGB)} · ${formatHourly(status.hourlyDollars)}`}
        />
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
        <SettingsRow
          label="Disk"
          description={
            status.dataExpired
              ? `${providerName} deleted its saved disk after its retention period, so it can't start again`
              : `${status.lastSnapshotAt ? `Last saved ${clockTime(status.lastSnapshotAt)}` : "No completed save reported yet"}. Files in its home folder are saved when it stops and kept at least 14 days while it's stopped; /tmp, caches and memory aren't.`
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
            </span>
          }
        />
      </SettingsGroup>
      {machines.dialogs}
    </SettingsSection>
  );
}
