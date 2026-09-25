import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyableCommand } from "@/components/Setup/CopyableCommand";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import {
  SettingsDependents,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { useHostMode } from "@/hooks/useHostMode";
import { isMac } from "@/lib/platform";
import type { HostModeStatusRow } from "@shared/types/ipc/hostMode";

function rowById(rows: readonly HostModeStatusRow[] | undefined, id: HostModeStatusRow["id"]) {
  return rows?.find((row) => row.id === id) ?? null;
}

/** Only what needs the user's attention gets a glyph; a healthy row stays neutral. */
function StateMark({ state }: { state: HostModeStatusRow["state"] }) {
  if (state !== "warning" && state !== "unavailable") return null;
  return (
    <>
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-status-warning" aria-hidden="true" />
      <span className="sr-only">{state === "warning" ? "Needs attention" : "Unavailable"}</span>
    </>
  );
}

function RowDetail({ row }: { row: HostModeStatusRow }) {
  return (
    <>
      <span className="break-words">{row.detail}</span>
      {row.command && (
        <span className="mt-2 block">
          <CopyableCommand command={row.command} wrap />
        </span>
      )}
    </>
  );
}

function StatusRow({
  label,
  row,
  control,
}: {
  label: string;
  row: HostModeStatusRow | null;
  control?: ReactNode;
}) {
  if (!row) return null;
  return (
    <SettingsRow
      label={label}
      accessory={<StateMark state={row.state} />}
      description={<RowDetail row={row} />}
      control={control}
      id={`host-mode-${row.id}`}
    />
  );
}

/**
 * "This machine as a host": the switch that lets other machines' Daintree
 * windows use this one over SSH, start at login (only when the user turns it
 * on), and what was observed about the socket, the keychain, sleep and the
 * machines attached right now.
 */
export default function HostModeGroup() {
  const host = useHostMode();
  if (!host.supported) return null;

  const { status, pending, saveFailure } = host;
  const enabled = pending?.enabled ?? status?.enabled ?? false;
  const startAtLogin = pending
    ? pending.enabled && (pending.startAtLogin ?? status?.startAtLogin ?? false)
    : (status?.startAtLogin ?? false);
  const locked = status === null || pending !== null;
  const rows = status?.rows;
  const startRow = rowById(rows, "start-at-login");
  const mac = isMac();
  const showStatus = status !== null && status.enabled && pending === null;

  const startAtLoginDescription =
    showStatus && startRow ? (
      <RowDetail row={startRow} />
    ) : mac ? (
      "Adds a Daintree LaunchAgent so this machine hosts, with no window, once you log in"
    ) : (
      "Adds a Daintree systemd user unit so this machine hosts, with no window, from login or boot"
    );

  return (
    <SettingsSection
      title="This machine as a host"
      description="Daintree windows on your other machines can open this machine's projects and run its agents over SSH"
      id="host-mode"
    >
      {status === null && host.loadError !== null && (
        <SettingsLoadErrorBanner
          title="Couldn't read Host mode status"
          message={host.loadError}
          onRetry={() => void host.reload()}
        />
      )}
      <SettingsGroup>
        <SettingsSwitchCard
          title="Allow this machine to be a host"
          subtitle="Listens on a socket only you can open; other machines reach it through SSH"
          isEnabled={enabled}
          onChange={() => void host.setEnabled({ enabled: !enabled })}
          disabled={locked}
        />
        <SettingsDependents
          disabled={!locked && !enabled}
          reason="Turn on hosting to start it at login"
        >
          <SettingsRow
            label="Start at login"
            accessory={showStatus && startRow ? <StateMark state={startRow.state} /> : undefined}
            description={startAtLoginDescription}
            id="host-mode-start-at-login"
            control={({ labelId, descriptionId, disabled }) => (
              <SettingsSwitch
                checked={startAtLogin}
                onCheckedChange={(next) =>
                  void host.setEnabled({ enabled: true, startAtLogin: next })
                }
                disabled={disabled || locked || !enabled}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              />
            )}
          />
          {showStatus && (
            <>
              <StatusRow label="Socket" row={rowById(rows, "socket")} />
              <StatusRow
                label={mac ? "Keychain" : "Keyring"}
                row={rowById(rows, "keychain")}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={host.checkingKeychain}
                    onClick={() => void host.runKeychainPreflight()}
                  >
                    {host.checkingKeychain ? "Checking…" : "Check"}
                  </Button>
                }
              />
              <StatusRow label="Sleep" row={rowById(rows, "sleep")} />
              <StatusRow label="Attached machines" row={rowById(rows, "drivers")} />
            </>
          )}
        </SettingsDependents>
      </SettingsGroup>
      {saveFailure && (
        <SettingsLoadErrorBanner
          title={
            saveFailure.payload.enabled
              ? "Couldn't turn on Host mode"
              : "Couldn't turn off Host mode"
          }
          message={saveFailure.message}
          onRetry={() => void host.setEnabled(saveFailure.payload)}
        />
      )}
    </SettingsSection>
  );
}

export { HostModeGroup };
