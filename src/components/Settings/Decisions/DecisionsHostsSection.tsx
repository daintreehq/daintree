import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import type { DecisionsDevice } from "@shared/types/decisions";
import type { DecisionsHost } from "@shared/types/decisionsHosts";
import { deviceKind } from "./devicesCopy";
import { AUTO_ENROLL_SUBTITLE, hostEnrollmentText, RELAY_ONLY_HOST_TEXT } from "./hostsCopy";
import { useDecisionsHosts } from "./useDecisionsHosts";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";
import type { DecisionsRevokeTarget } from "./useDecisionsKeyActions";

export const HOSTS_SECTION_ID = "decisions-hosts";
const HOSTS_DESCRIPTION =
  "Remote Hosts you've connected to or enrolled, and whether each one's agents can ask you through your relay";

/** A Host as main lists it, with the relay's device for it when the relay lists one. */
interface HostRow {
  host: DecisionsHost;
  device: DecisionsDevice | null;
}

/**
 * Each Host once (#16222): main's Hosts, each joined to the relay's Remote
 * Host device it is known by (its enrollment's or its recorded device, else
 * the one the Host reports holding), and then every Remote Host device the
 * relay lists that no Host claims, so it stays revocable. Those wait for a
 * Hosts read that settled, or each would show alone until the Hosts land.
 */
export function joinHostsToDevices(
  hosts: readonly DecisionsHost[] | null,
  devices: readonly DecisionsDevice[] | null,
  hostsSettled: boolean
): { rows: HostRow[]; relayOnly: DecisionsDevice[] } {
  const relayHosts = (devices ?? []).filter((device) => deviceKind(device.role) === "host");
  const byId = new Map(relayHosts.map((device) => [device.deviceId, device]));
  const claimed = new Set<string>();
  const claim = (deviceId: string | undefined): DecisionsDevice | null => {
    if (deviceId === undefined || claimed.has(deviceId)) return null;
    const device = byId.get(deviceId);
    if (device === undefined) return null;
    claimed.add(deviceId);
    return device;
  };
  const rows: HostRow[] = (hosts ?? []).map((host) => ({
    host,
    device:
      claim(host.enrollment.state === "enrolled" ? host.enrollment.deviceId : undefined) ??
      claim(host.recordedDeviceId),
  }));
  for (const row of rows) {
    if (row.device !== null) continue;
    const runtime = row.host.runtime?.runtime;
    row.device = claim(runtime && runtime.state !== "not-enrolled" ? runtime.deviceId : undefined);
  }
  return {
    rows,
    relayOnly: hostsSettled ? relayHosts.filter((device) => !claimed.has(device.deviceId)) : [],
  };
}

/** When the relay last heard from a Remote Host's device. */
function RelaySeen({ device }: { device: DecisionsDevice }) {
  return (
    <span className="mt-1 block">
      {device.lastSeenAt ? (
        <TimeAgo timestamp={device.lastSeenAt} verbose prefix="Seen " />
      ) : (
        "Not seen since it was enrolled"
      )}
    </span>
  );
}

/**
 * Remote Hosts (#16021), their own section since #16222: automatic
 * enrollment's switch, and each connected or recorded Host once, with what
 * was last observed of it and, on the same row, Enroll when it would do
 * something and Revoke while the Host holds a device. A Remote Host device
 * the relay lists with no Host record here gets a row of its own, revocable
 * like the rest. `onEnrolledChange` runs when the set of enrolled Hosts
 * changes, so the relay's devices can be read again.
 */
export function DecisionsHostsSection({
  enabled,
  revision,
  devicesRead,
  locked = false,
  actionsLocked = false,
  onRevoke,
  onEnrolledChange,
}: {
  /** A relay is set up, so there is an owner to enroll with. */
  enabled: boolean;
  /** The status push's revision: each one may carry an enrollment's progress. */
  revision: number;
  /** The relay's device list, every role; its Remote Host devices are joined to the Hosts. */
  devicesRead: UseDecisionsDevicesResult;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /** Nothing may change the key now: the switch is changing, or a key change is running. */
  actionsLocked?: boolean;
  onRevoke: (target: DecisionsRevokeTarget) => void;
  onEnrolledChange?: () => void;
}) {
  const {
    hosts,
    autoEnroll,
    loadError,
    savingAuto,
    actionFailure,
    enrolling,
    setAutoEnroll,
    enroll,
    reload,
  } = useDecisionsHosts(enabled, revision);

  // A Host with no keychain, offered the fixed-key storage: asked once more, by name, before it's used.
  const [weakHost, setWeakHost] = useState<{ hostId: string; name: string } | null>(null);

  const enrolledKey =
    hosts === null
      ? null
      : hosts
          .flatMap((host) =>
            host.enrollment.state === "enrolled" ? [host.enrollment.deviceId] : []
          )
          .sort()
          .join(",");
  const seenKey = useRef<string | null>(null);
  useEffect(() => {
    if (enrolledKey === null) return;
    const before = seenKey.current;
    seenKey.current = enrolledKey;
    if (before !== null && before !== enrolledKey) onEnrolledChange?.();
  }, [enrolledKey, onEnrolledChange]);

  if (!enabled) {
    return (
      <SettingsSection title="Remote Hosts" description={HOSTS_DESCRIPTION} id={HOSTS_SECTION_ID}>
        <SettingsGroup>
          <SettingsEmptyRow>Connect a relay above, then enroll Remote Hosts here</SettingsEmptyRow>
        </SettingsGroup>
      </SettingsSection>
    );
  }

  const { rows, relayOnly } = joinHostsToDevices(
    hosts,
    devicesRead.devices,
    hosts !== null || loadError !== null
  );
  const listed = rows.length > 0 || relayOnly.length > 0;
  const refreshing = devicesRead.loading;

  const headerActions = listed ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            if (refreshing) return;
            reload();
            devicesRead.reload();
          }}
          // Busy, not unavailable: the rotating glyph says so, and the button keeps focus.
          aria-busy={refreshing || undefined}
          aria-disabled={refreshing || undefined}
          aria-label="Refresh Remote Hosts"
        >
          <SpinningIcon icon={RefreshCw} active={refreshing} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Refresh Remote Hosts</TooltipContent>
    </Tooltip>
  ) : undefined;

  const revokeButton = (target: DecisionsRevokeTarget, descriptionId: string | undefined) => (
    <Button
      type="button"
      variant="ghost-danger"
      size="sm"
      disabled={actionsLocked}
      aria-label={`Revoke ${target.label}`}
      aria-describedby={descriptionId}
      onClick={() => onRevoke(target)}
    >
      Revoke
    </Button>
  );

  return (
    <SettingsSection
      title="Remote Hosts"
      description={HOSTS_DESCRIPTION}
      id={HOSTS_SECTION_ID}
      action={headerActions}
    >
      {loadError !== null && (
        <SettingsLoadErrorBanner
          title={
            hosts === null ? "Couldn't read the Remote Hosts" : "Couldn't refresh the Remote Hosts"
          }
          message={
            hosts === null ? loadError : `${loadError} The list below is from the last read.`
          }
          onRetry={reload}
        />
      )}
      {actionFailure !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't change a Remote Host"
          message={actionFailure.message}
          onRetry={actionFailure.retry}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          id="decisions-auto-enroll-hosts"
          title="Enroll Remote Hosts automatically"
          subtitle={AUTO_ENROLL_SUBTITLE}
          isEnabled={autoEnroll}
          onChange={() => setAutoEnroll(!autoEnroll)}
          disabled={locked || savingAuto || hosts === null}
          isModified={!autoEnroll}
          onReset={() => setAutoEnroll(true)}
        />
        {hosts !== null && !listed && (
          <SettingsEmptyRow>Connect to a Remote Host to enroll it here</SettingsEmptyRow>
        )}
        {rows.map(({ host, device }) => {
          const busy = enrolling.has(host.hostId);
          const weakOnly =
            host.enrollment.state === "failed" &&
            host.enrollment.failure.reason === "weak-storage-only";
          // Revoke while the relay lists its device, or main last saw it enrolled:
          // what the relay makes of it is said once it answers.
          const deviceId =
            device?.deviceId ??
            (host.enrollment.state === "enrolled" ? host.enrollment.deviceId : null);
          // Only a saved record keeps a revoked Host from enrolling again: main
          // shows `enrolled` even when saving that record failed.
          const recordedHost = deviceId !== null && host.recordedDeviceId === deviceId;
          const target: DecisionsRevokeTarget | null =
            deviceId === null
              ? null
              : { deviceId, label: host.name, role: "desktop-host", recordedHost };
          const enrollControl =
            weakOnly && host.canEnroll && !busy ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => setWeakHost({ hostId: host.hostId, name: host.name })}
              >
                Enroll with weaker storage…
              </Button>
            ) : host.canEnroll || busy ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked || busy}
                onClick={() => enroll(host.hostId)}
              >
                Enroll
              </Button>
            ) : null;
          const both = enrollControl !== null && target !== null;
          return (
            <SettingsRow
              key={host.hostId}
              id={`decisions-host-${host.hostId.replace(/[^A-Za-z0-9_-]/g, "-")}`}
              label={host.name}
              labelText={host.name}
              layout={both ? "stacked" : "inline"}
              description={
                <>
                  {busy ? "Enrolling…" : hostEnrollmentText(host, autoEnroll)}
                  {device && <RelaySeen device={device} />}
                </>
              }
              control={
                enrollControl === null && target === null
                  ? undefined
                  : ({ descriptionId }) => {
                      const revoke = target === null ? null : revokeButton(target, descriptionId);
                      return enrollControl !== null && revoke !== null ? (
                        <SettingsRowActions>
                          {enrollControl}
                          {revoke}
                        </SettingsRowActions>
                      ) : (
                        (enrollControl ?? revoke)
                      );
                    }
              }
            />
          );
        })}
        {relayOnly.map((device) => (
          <SettingsRow
            key={device.deviceId}
            id={`decisions-host-device-${device.deviceId.replace(/[^A-Za-z0-9_-]/g, "-")}`}
            label={device.label}
            labelText={device.label}
            description={
              <>
                {RELAY_ONLY_HOST_TEXT}
                <RelaySeen device={device} />
              </>
            }
            control={({ descriptionId }) =>
              revokeButton(
                { deviceId: device.deviceId, label: device.label, role: device.role },
                descriptionId
              )
            }
          />
        ))}
      </SettingsGroup>
      <ConfirmDialog
        isOpen={weakHost !== null}
        onClose={() => setWeakHost(null)}
        variant="default"
        title={`Use the weaker key storage on ${weakHost?.name ?? "this Host"}?`}
        description={`${weakHost?.name ?? "This Host"} has no keychain, so its Decisions keys would be kept under a fixed key. That keeps them only from someone who can't read its files: anyone who can could read your agents' questions and answers. It applies to this Host alone.`}
        confirmLabel="Use weaker storage"
        onConfirm={() => {
          if (weakHost) enroll(weakHost.hostId, true);
          setWeakHost(null);
        }}
      />
    </SettingsSection>
  );
}
