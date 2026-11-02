import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { AUTO_ENROLL_SUBTITLE, hostEnrollmentText } from "./hostsCopy";
import { useDecisionsHosts } from "./useDecisionsHosts";

/**
 * Remote Hosts as Decisions devices (#16021), under Devices: automatic
 * enrollment's switch, and each connected or recorded Host with what was last
 * observed of it and, when it would do something, Enroll. An enrolled Host
 * is also in the device list above, where it is revoked like any device.
 * `onEnrolledChange` runs when the set of enrolled Hosts changes, so that
 * list can be read again.
 */
export function DecisionsHostsGroup({
  enabled,
  revision,
  locked = false,
  onEnrolledChange,
}: {
  /** A relay is set up, so there is an owner to enroll with. */
  enabled: boolean;
  /** The status push's revision: each one may carry an enrollment's progress. */
  revision: number;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
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

  if (!enabled) return null;

  return (
    <>
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
      <SettingsGroup label="Remote Hosts" id="decisions-hosts">
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
        {(hosts ?? []).map((host) => {
          const busy = enrolling.has(host.hostId);
          const weakOnly =
            host.enrollment.state === "failed" &&
            host.enrollment.failure.reason === "weak-storage-only";
          return (
            <SettingsRow
              key={host.hostId}
              id={`decisions-host-${host.hostId.replace(/[^A-Za-z0-9_-]/g, "-")}`}
              label={host.name}
              labelText={host.name}
              description={busy ? "Enrolling…" : hostEnrollmentText(host, autoEnroll)}
              control={
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
                ) : undefined
              }
            />
          );
        })}
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
    </>
  );
}
