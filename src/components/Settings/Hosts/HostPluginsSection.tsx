import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { PluginParityGroup, PluginParityRow } from "@shared/types/ipc/pluginParity";
import type { HostId } from "@shared/types/remoteHosts";
import { usePluginParity } from "@/components/Plugin/usePluginParity";
import {
  describeIncompatibility,
  pluginParityErrorText,
} from "@/components/Plugin/pluginParityCopy";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";

interface HostPluginsSectionProps {
  hostId: HostId;
  hostName: string;
  connected: boolean;
}

const GROUPS: ReadonlyArray<{
  group: Exclude<PluginParityGroup, "same">;
  label: (host: string) => string;
}> = [
  { group: "only-here", label: () => "Only on this machine" },
  { group: "version-differs", label: () => "Different versions" },
  { group: "incompatible", label: (host) => `Can't run as they are on ${host}` },
  { group: "only-on-host", label: (host) => `Only on ${host}` },
];

function rowDescription(row: PluginParityRow, host: string): string {
  if (row.incompatibility) {
    const versions =
      row.localVersion && row.hostVersion && row.localVersion !== row.hostVersion
        ? ` ${host} has ${row.hostVersion} · you have ${row.localVersion}.`
        : "";
    return `${describeIncompatibility(row.incompatibility, host)}${versions}`;
  }
  switch (row.group) {
    case "only-here":
      return `Version ${row.localVersion ?? "unknown"} · not installed on ${host}`;
    case "only-on-host":
      return `Version ${row.hostVersion ?? "unknown"} · works in ${host}'s windows; its views load from there`;
    default:
      return `${host} has ${row.hostVersion ?? "unknown"} · you have ${row.localVersion ?? "unknown"}`;
  }
}

/**
 * Settings → Hosts → a host → Plugins: this machine's plugins against the
 * host's. In a window on the host, the host's plugins are the ones that run,
 * so each difference says what it means there and offers the one fix that
 * applies. Nothing is copied unless the person asks, one plugin at a time.
 */
export function HostPluginsSection({ hostId, hostName, connected }: HostPluginsSectionProps) {
  const { state, refresh } = usePluginParity(hostId, connected, hostName);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const act = (row: PluginParityRow) => {
    if (busy !== null || row.action === null) return;
    setBusy(row.pluginId);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.pluginId];
      return next;
    });
    const payload = { hostId, pluginId: row.pluginId };
    const call =
      row.action === "update-on-host"
        ? window.electron.pluginParity.updateOnHost(payload)
        : window.electron.pluginParity.installOnHost(payload);
    call.then(
      () => {
        setBusy(null);
        refresh();
      },
      (err: unknown) => {
        setBusy(null);
        setRowErrors((prev) => ({
          ...prev,
          [row.pluginId]: pluginParityErrorText(
            err,
            hostName,
            row.action === "update-on-host"
              ? `Couldn't update ${row.displayName} on ${hostName}`
              : `Couldn't install ${row.displayName} on ${hostName}`
          ),
        }));
      }
    );
  };

  const section = (children: ReactNode) => (
    <SettingsSection
      id="host-plugins"
      title="Plugins"
      description={`Windows on ${hostName} run ${hostName}'s plugins. Nothing is copied between machines unless you ask`}
    >
      {children}
    </SettingsSection>
  );

  if (!connected) {
    return section(
      <SettingsGroup>
        <SettingsEmptyRow>
          Connect to this host to compare its plugins with this machine&apos;s
        </SettingsEmptyRow>
      </SettingsGroup>
    );
  }
  if (state.status === "error") {
    return section(
      <SettingsGroup>
        <SettingsEmptyRow
          action={
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {state.message}
        </SettingsEmptyRow>
      </SettingsGroup>
    );
  }
  if (state.status !== "ready") {
    return section(
      <SettingsGroup>
        <SettingsEmptyRow>Comparing plugins with {hostName}</SettingsEmptyRow>
      </SettingsGroup>
    );
  }

  const same = state.rows.filter((row) => row.group === "same").length;
  const groups = GROUPS.map(({ group, label }) => ({
    label: label(hostName),
    rows: state.rows.filter((row) => row.group === group),
  })).filter((entry) => entry.rows.length > 0);

  if (groups.length === 0) {
    return section(
      <SettingsGroup>
        <SettingsEmptyRow>
          {same === 0
            ? "Neither machine has plugins installed"
            : `Both machines have the same ${same === 1 ? "plugin" : `${same} plugins`}`}
        </SettingsEmptyRow>
      </SettingsGroup>
    );
  }

  return section(
    <div className="space-y-4">
      {groups.map(({ label, rows }) => (
        <SettingsGroup key={label} label={label}>
          {rows.map((row) => (
            <SettingsRow
              key={row.pluginId}
              label={row.displayName}
              description={rowDescription(row, hostName)}
              error={rowErrors[row.pluginId]}
              control={
                row.action ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => act(row)}
                    disabled={busy !== null}
                    aria-busy={busy === row.pluginId || undefined}
                  >
                    {row.action === "update-on-host"
                      ? `Update on ${hostName}`
                      : `Install on ${hostName}`}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </SettingsGroup>
      ))}
      {same > 0 && (
        <SettingsGroup>
          <SettingsRow
            label="Matching plugins"
            description={`${same} ${same === 1 ? "plugin is" : "plugins are"} the same version on both machines`}
          />
        </SettingsGroup>
      )}
    </div>
  );
}
