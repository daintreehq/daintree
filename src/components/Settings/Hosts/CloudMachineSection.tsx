import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { useNow } from "@/hooks/useNow";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { systemClient } from "@/clients/systemClient";
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
  providerStopSentence,
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
import { SettingsGroup, SettingsRow, SettingsRowActions } from "../SettingsGroup";
import { SettingsSelect } from "../SettingsSelect";
import { HostIdleTimeRow } from "./HostIdleTimeRow";
import { HostKeyReviewDetails } from "./CloudHostKeyReview";

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
  const [busy, setBusy] = useState<
    "retry" | "lifetime" | "trust" | "cleanup-retry" | "cleanup-keep" | null
  >(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lifetimeError, setLifetimeError] = useState<string | null>(null);
  // Kept with the fingerprint it was about: a different key on show is a different decision.
  const [trustError, setTrustError] = useState<{ fingerprint: string; message: string } | null>(
    null
  );
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
  // While its provider is missing nothing here can reach the machine, so why comes first,
  // beside what was last known: an unconfirmed create may still be a billable machine.
  const lastError = status.operation === null ? (status.lastError?.message ?? null) : null;
  const shownError =
    status.providerUnavailable !== null
      ? [...new Set([actionError, status.providerUnavailable, lastError])].filter(Boolean).join(" ")
      : (actionError ?? lastError);
  const tunnel = provider?.capabilities.tunnel ?? null;
  // Offered only beside the error that names the command, never beside another one.
  const tunnelMissing =
    tunnel !== null &&
    actionError === null &&
    status.providerUnavailable === null &&
    status.operation === null &&
    status.lastError?.code === "ssh-tunnel-command-missing";
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
  const review = status.hostKeyReview;

  // Names the fingerprint shown, so a key that changed again since is refused; then dials with it.
  const trustHostKey = (fingerprint: string) => {
    setBusy("trust");
    setTrustError(null);
    cloudHostsClient.trustHostKey(hostId, fingerprint).then(
      () => {
        setBusy(null);
        void remoteHostsClient.connect(hostId).catch(() => {});
      },
      (err: unknown) => {
        setBusy(null);
        setTrustError({ fingerprint, message: errorText(err, "Couldn't trust the host key") });
      }
    );
  };

  const asReported = stale && running && checkedAt ? `As last reported ${checkedAt}: ` : "";

  // When it stops by itself, in its provider's terms: only a renewable or fixed limit is chosen here.
  const lifetime = status.lifetime;
  let lifetimeRow: ReactNode;
  if (lifetime === null) {
    // Its provider isn't registered: what was last seen of this run, and no promise beyond it.
    lifetimeRow = (
      <SettingsRow
        label="Stops by itself"
        description={
          <span data-testid="cloud-machine-lifetime">
            {`${running && autoStop ? `${asReported}This run stops by itself ${autoStop}, as last reported. ` : ""}Unknown while ${providerName} isn't available.`}
          </span>
        }
      />
    );
  } else if (lifetime.kind === "none" || lifetime.kind === "idle-sleep") {
    lifetimeRow = (
      <SettingsRow
        label={lifetime.kind === "none" ? "Stops by itself" : "Sleeps when idle"}
        description={
          <span data-testid="cloud-machine-lifetime">
            {lifetime.kind === "none" && provider?.capabilities.lifetime.kind === "idle-sleep"
              ? // The provider sleeps idle machines, but this one has it turned off.
                "Sleeping when idle is off for this machine: it runs until you stop it."
              : providerStopSentence(lifetime, providerName)}
          </span>
        }
      />
    );
  } else if (lifetime.kind === "fixed-at-create") {
    const thisRun = running
      ? `${asReported}${
          autoStop
            ? `This run stops by itself ${autoStop}.`
            : status.lifetimeSeconds === null
              ? "This run doesn't stop by itself."
              : `${providerName} hasn't said when this run stops.`
        } `
      : "Counted from each start. ";
    const rule = lifetime.canChangeWhileStopped
      ? `${providerName} can't extend it while the machine runs; a change made while it's stopped applies the next time Daintree starts it.`
      : `${providerName} sets it when the machine is created, and can't extend or change it.`;
    // The limit asked for; with none asked for, a deadline the provider reports anyway speaks for itself.
    const limit =
      status.lifetimeSeconds !== null
        ? `${durationLabel(status.lifetimeSeconds)}. `
        : running && autoStop
          ? ""
          : "Never. ";
    lifetimeRow = lifetime.canChangeWhileStopped ? (
      <SettingsSelect
        label="Stops by itself after"
        description={<span data-testid="cloud-machine-lifetime">{thisRun + rule}</span>}
        value={lifetimeValue}
        onValueChange={setLifetime}
        options={lifetimeOptions}
        disabled={busy === "lifetime" || status.operation !== null || status.machine !== "stopped"}
        error={lifetimeError ?? undefined}
      />
    ) : (
      <SettingsRow
        label="Stops by itself after"
        description={
          <span data-testid="cloud-machine-lifetime">{`${limit}${thisRun}${rule}`}</span>
        }
      />
    );
  } else {
    lifetimeRow = (
      <SettingsSelect
        label="Stops by itself after"
        description={
          asReported +
          (running
            ? autoStop
              ? status.lifetimeSeconds === null
                ? `This run stops by itself ${autoStop}. A change applies from now.`
                : `This run stops by itself ${autoStop}${status.keptRunningAt !== null ? `, pushed back ${clockTime(new Date(status.keptRunningAt).toISOString())}` : ""}. Daintree pushes it back while a window here shows it or its agents are working; a change applies from now.`
              : "This run has no lifetime limit. A change applies from now."
            : "Counted from each start, and pushed back while a window here shows it or its agents are working. A guard against a machine left running, not a spending limit.")
        }
        value={lifetimeValue}
        onValueChange={setLifetime}
        options={lifetimeOptions}
        disabled={busy === "lifetime" || status.operation !== null}
        error={lifetimeError ?? undefined}
      />
    );
  }

  // What Daintree is doing to it, in its own words; the provider's raw state stays in diagnostics.
  const stateDetail = status.operation?.stage || null;

  const cleanup = status.worktreeCleanup;
  const cleanupAct = (
    kind: "cleanup-retry" | "cleanup-keep",
    work: () => Promise<void>,
    fallback: string
  ) => {
    setBusy(kind);
    setCleanupError(null);
    work().then(
      () => setBusy(null),
      (err: unknown) => {
        setBusy(null);
        setCleanupError(errorText(err, fallback));
      }
    );
  };
  const worktreeLabel = status.createdFor ? `'${status.createdFor.worktreeName}'` : "its worktree";
  const keepButton = (
    <Button
      variant="ghost"
      size="sm"
      loading={busy === "cleanup-keep"}
      disabled={busy !== null}
      onClick={() =>
        cleanupAct(
          "cleanup-keep",
          () => cloudHostsClient.dismissWorktreeCleanup(hostId),
          "Couldn't keep the machine"
        )
      }
    >
      Keep machine
    </Button>
  );
  const consoleButton = provider && (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void systemClient.openExternal(provider.dashboardUrl)}
    >
      <ExternalLink aria-hidden="true" />
      Open {providerName} console
    </Button>
  );
  let cleanupNotice: ReactNode = null;
  if (cleanup) {
    const verb = cleanup.choice === "delete" ? "delete" : "stop";
    const done = cleanup.choice === "delete" ? "deleted" : "stopped";
    const retryButton = (label: string) => (
      <Button
        variant="outline"
        size="sm"
        loading={busy === "cleanup-retry"}
        disabled={busy !== null}
        onClick={() =>
          cleanupAct(
            "cleanup-retry",
            () => cloudHostsClient.retryWorktreeCleanup(hostId),
            `Couldn't ${verb} the machine`
          )
        }
      >
        {label}
      </Button>
    );
    if (cleanup.phase === "failed") {
      cleanupNotice = (
        <Callout
          severity="error"
          className="mb-3"
          data-testid="cloud-machine-cleanup"
          title={`Couldn't ${verb} it with ${worktreeLabel}`}
          action={retryButton("Retry")}
        >
          <p role="alert">{cleanupError ?? cleanup.error?.message ?? "It didn't finish."}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {consoleButton}
            {keepButton}
          </div>
        </Callout>
      );
    } else if (cleanup.phase === "unconfirmed") {
      // Never a Retry here: nothing on this device can tell whether that worktree went.
      cleanupNotice = (
        <Callout
          severity="warning"
          className="mb-3"
          data-testid="cloud-machine-cleanup"
          title={`Not ${done} with ${worktreeLabel}`}
        >
          <p>
            {cleanupError ??
              `${cleanup.error?.message ?? "Daintree didn't hear whether the worktree was deleted."} If it was, ${verb} the machine here.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {consoleButton}
            {keepButton}
          </div>
        </Callout>
      );
    } else if (cleanup.phase === "waiting") {
      cleanupNotice = (
        <Callout
          severity="info"
          className="mb-3"
          data-testid="cloud-machine-cleanup"
          // Only a worktree on this device can be looked at again from here.
          action={cleanup.worktreeHostId === null ? retryButton("Check again") : undefined}
        >
          <p>{cleanupError ?? `It will be ${done} once ${worktreeLabel} is deleted.`}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{keepButton}</div>
        </Callout>
      );
    } else {
      cleanupNotice = (
        <Callout severity="info" className="mb-3" data-testid="cloud-machine-cleanup">
          {cleanup.error
            ? `It will be ${done} once ${providerName} is available again.`
            : `It's being ${done} with ${worktreeLabel}.`}
        </Callout>
      );
    }
  }

  return (
    <SettingsSection title="Cloud machine" id="host-cloud-machine">
      {cleanupNotice}
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
                    <TimeAgo
                      prefix={status.asleep ? "fell asleep " : "stopped "}
                      timestamp={Date.parse(status.stoppedAt)}
                    />
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
          errorAction={
            tunnelMissing ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void systemClient.openExternal(tunnel.installUrl)}
              >
                <ExternalLink aria-hidden="true" />
                Get {tunnel.command}
              </Button>
            ) : undefined
          }
          control={
            <div className="flex items-center gap-1.5">
              {status.resourceId === null &&
                status.operation === null &&
                status.lastError &&
                status.providerUnavailable === null && (
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
        {review && (
          <SettingsRow
            label={review.reason === "changed" ? "Host key changed" : "Confirm host key"}
            layout="stacked"
            description={<HostKeyReviewDetails review={review} providerName={providerName} />}
            error={
              trustError?.fingerprint === review.fingerprint ? (
                <span role="alert">{trustError.message}</span>
              ) : undefined
            }
            control={
              <SettingsRowActions>
                <Button
                  variant="outline"
                  size="sm"
                  loading={busy === "trust"}
                  onClick={() => trustHostKey(review.fingerprint)}
                >
                  {review.reason === "changed" ? "Trust new key" : "Trust this key"}
                </Button>
              </SettingsRowActions>
            }
          />
        )}
        <SettingsRow
          label="Account"
          description={`${providerName} · ${status.accountName}${status.ownership === "imported" ? " · Added from the account" : ""}`}
        />
        {provider?.capabilities.sshTrust === "provider-tunnel" && (
          <SettingsRow
            label="Identity"
            description={
              <span data-testid="cloud-machine-identity">
                {`Vouched for by ${providerName}'s tunnel instead of a pinned host key. The machine's key can change when ${providerName} rebuilds or moves it, so it isn't checked.`}
              </span>
            }
          />
        )}
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
        {lifetimeRow}
        <HostIdleTimeRow
          key={hostId}
          hostId={hostId}
          hostName={hostName}
          connected={connected}
          idle={liveSummary?.idle}
          sampledAt={liveSummary?.sampledAt ?? null}
          selfStopProblem={status.selfStopProblem ?? null}
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
              {tunnel && (
                <>
                  {" "}
                  <FactSeparator /> Tunnel {[tunnel.command, ...tunnel.args].join(" ")}
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
