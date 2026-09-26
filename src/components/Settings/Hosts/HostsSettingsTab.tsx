import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRemoteHosts } from "@/hooks/useRemoteHosts";
import { formatHostConnection, type HostId } from "@shared/types/remoteHosts";
import HostModeGroup from "../HostModeGroup";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { AddHostDialog } from "./AddHostDialog";
import { HostDetail } from "./HostDetail";
import { buildLabel, connectionLabel, platformLabel } from "./hostLabels";
import { onHostUpdateRequest, takePendingHostUpdate } from "./hostUpdateRequests";
import { onHostPluginsRequest, takePendingHostPlugins } from "./hostPluginRequests";

/**
 * Settings → Hosts: the machines this one opens projects on, adding one, and
 * this machine's own Host mode. Device-owned: nothing here is per project.
 */
export default function HostsSettingsTab() {
  const { hosts, loaded, loadError, refresh } = useRemoteHosts();
  const [addOpen, setAddOpen] = useState(false);
  const [detailHostId, setDetailHostId] = useState<HostId | null>(null);
  // Each "Update …" request remounts the detail so its update flow opens again.
  const [updateRequest, setUpdateRequest] = useState<{ hostId: HostId; seq: number } | null>(null);
  const [pluginsRequest, setPluginsRequest] = useState<{ hostId: HostId; seq: number } | null>(
    null
  );

  useEffect(() => {
    const open = (hostId: HostId) => {
      setDetailHostId(hostId);
      setUpdateRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostUpdate();
    if (pending) open(pending);
    return onHostUpdateRequest(open);
  }, []);

  useEffect(() => {
    const open = (hostId: HostId) => {
      setDetailHostId(hostId);
      setPluginsRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostPlugins();
    if (pending) open(pending);
    return onHostPluginsRequest(open);
  }, []);

  const detail = detailHostId
    ? (hosts.find((entry) => entry.descriptor.id === detailHostId) ?? null)
    : null;
  if (detail) {
    const openUpdate = updateRequest?.hostId === detail.descriptor.id;
    const focusPlugins = !openUpdate && pluginsRequest?.hostId === detail.descriptor.id;
    return (
      <HostDetail
        key={
          openUpdate
            ? `update-${updateRequest.seq}`
            : focusPlugins
              ? `plugins-${pluginsRequest.seq}`
              : "detail"
        }
        entry={detail}
        openUpdate={openUpdate}
        focusPlugins={focusPlugins}
        onBack={() => {
          setDetailHostId(null);
          setUpdateRequest(null);
          setPluginsRequest(null);
        }}
      />
    );
  }

  const addButton = (
    <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
      Add host
    </Button>
  );

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Remote hosts"
        description="Macs and Linux machines this one opens projects on, over your own SSH"
        action={hosts.length > 0 ? addButton : undefined}
        id="hosts-list"
      >
        <SettingsGroup>
          {loadError ? (
            <SettingsEmptyRow
              action={
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Retry
                </Button>
              }
            >
              {loadError}
            </SettingsEmptyRow>
          ) : hosts.length === 0 ? (
            <SettingsEmptyRow action={addButton}>
              {loaded
                ? "Add a Mac or Linux machine to run projects and agents on it from here"
                : "Loading hosts"}
            </SettingsEmptyRow>
          ) : (
            hosts.map(({ descriptor, connection }) => (
              <SettingsRow
                key={descriptor.id}
                label={descriptor.name}
                description={
                  <>
                    {formatHostConnection(descriptor.connection)} ·{" "}
                    {platformLabel(descriptor.platform, descriptor.arch)} · {buildLabel(descriptor)}
                    <br />
                    {connectionLabel(connection)}
                  </>
                }
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Open ${descriptor.name}`}
                    onClick={() => setDetailHostId(descriptor.id)}
                  >
                    Details
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <HostModeGroup />

      {addOpen && <AddHostDialog isOpen onClose={() => setAddOpen(false)} />}
    </div>
  );
}
