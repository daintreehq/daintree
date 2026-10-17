import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { useRemoteHosts } from "@/hooks/useRemoteHosts";
import { remoteConnectionKind } from "@/lib/remoteHosts";
import { formatHostConnection, type HostConnection, type HostId } from "@shared/types/remoteHosts";
import HostModeGroup from "../HostModeGroup";
import { SettingsSection } from "../SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { AddHostDialog } from "./AddHostDialog";
import { HostDetail } from "./HostDetail";
import { connectionLabel, platformLabel, removeHostOutcome } from "./hostLabels";
import {
  onHostSettingsRequest,
  takePendingHostSettings,
  type HostSettingsRequest,
} from "./hostSettingsRequests";
import { onHostUpdateRequest, takePendingHostUpdate } from "./hostUpdateRequests";
import { onHostPluginsRequest, takePendingHostPlugins } from "./hostPluginRequests";
import { onHostCopySettingsRequest, takePendingHostCopySettings } from "./hostCopySettingsRequests";
import { clientErrorText } from "@/utils/clientAppError";

/** A to Z as people number machines (studio-2 before studio-10), like every other host list. */
const hostNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Settings → Hosts: the machines this one opens projects on, adding one, and
 * this machine's own Host mode. Device-owned: nothing here is per project.
 */
export default function HostsSettingsTab() {
  const { hosts, loaded, loadError, refresh } = useRemoteHosts();
  const [addOpen, setAddOpen] = useState(false);
  const [detailHostId, setDetailHostId] = useState<HostId | null>(null);
  const [forgetTarget, setForgetTarget] = useState<{
    id: HostId;
    name: string;
    connection: HostConnection;
  } | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);
  // Leaving a host's details puts focus back on the Details button it came
  // from (or, once removed, the list's Add host); entering from the keyboard
  // puts it on the header's way back.
  const returnFocusTo = useRef<{ hostId: HostId; visible: boolean } | null>(null);
  // Set when the details were opened from the keyboard; the detail page moves
  // focus to the header's way back once it has mounted, however late its host loads.
  const [focusBackFor, setFocusBackFor] = useState<HostId | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const confirmForget = () => {
    const target = forgetTarget;
    if (!target || forgetting) return;
    setForgetting(true);
    setForgetError(null);
    remoteHostsClient.forget(target.id).then(
      () => {
        setForgetting(false);
        // Only the dialog this answer belongs to closes.
        setForgetTarget((current) => (current?.id === target.id ? null : current));
      },
      (err: unknown) => {
        setForgetting(false);
        setForgetError(clientErrorText(err, "Couldn't remove the host"));
      }
    );
  };
  // Each "Update …" request remounts the detail so its update flow opens again.
  const [updateRequest, setUpdateRequest] = useState<{ hostId: HostId; seq: number } | null>(null);
  const [pluginsRequest, setPluginsRequest] = useState<{ hostId: HostId; seq: number } | null>(
    null
  );
  const [copyRequest, setCopyRequest] = useState<{ hostId: HostId; seq: number } | null>(null);

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
    const answer = (request: HostSettingsRequest) => {
      if (request.kind === "add") {
        setDetailHostId(null);
        setAddOpen(true);
      } else {
        setFocusBackFor(request.viaKeyboard === true ? request.hostId : null);
        setDetailHostId(request.hostId);
      }
    };
    const pending = takePendingHostSettings();
    if (pending) answer(pending);
    return onHostSettingsRequest(answer);
  }, []);

  useEffect(() => {
    if (detailHostId !== null) return undefined;
    const target = returnFocusTo.current;
    if (target === null) return undefined;
    returnFocusTo.current = null;
    const button =
      document.querySelector<HTMLElement>(`[data-host-details="${CSS.escape(target.hostId)}"]`) ??
      document.querySelector<HTMLElement>('[data-testid="hosts-add-host"]');
    button?.focus({ focusVisible: target.visible } as FocusOptions);
    return undefined;
  }, [detailHostId]);

  useEffect(() => {
    const open = (hostId: HostId) => {
      setDetailHostId(hostId);
      // The latest request decides what opens: an earlier update's would win otherwise.
      setUpdateRequest(null);
      setPluginsRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostPlugins();
    if (pending) open(pending);
    return onHostPluginsRequest(open);
  }, []);

  useEffect(() => {
    const open = (hostId: HostId) => {
      setAddOpen(false);
      setDetailHostId(hostId);
      setUpdateRequest(null);
      setPluginsRequest(null);
      setCopyRequest((prev) => ({ hostId, seq: (prev?.seq ?? 0) + 1 }));
    };
    const pending = takePendingHostCopySettings();
    if (pending) open(pending);
    return onHostCopySettingsRequest(open);
  }, []);

  const detail = detailHostId
    ? (hosts.find((entry) => entry.descriptor.id === detailHostId) ?? null)
    : null;
  if (detail) {
    const openUpdate = updateRequest?.hostId === detail.descriptor.id;
    const focusPlugins = !openUpdate && pluginsRequest?.hostId === detail.descriptor.id;
    const offerCopySettings =
      !openUpdate && !focusPlugins && copyRequest?.hostId === detail.descriptor.id;
    return (
      <HostDetail
        key={
          openUpdate
            ? `update-${detail.descriptor.id}-${updateRequest.seq}`
            : focusPlugins
              ? `plugins-${detail.descriptor.id}-${pluginsRequest.seq}`
              : offerCopySettings
                ? `copy-${detail.descriptor.id}-${copyRequest.seq}`
                : `detail-${detail.descriptor.id}`
        }
        entry={detail}
        focusBackOnMount={focusBackFor === detail.descriptor.id}
        openUpdate={openUpdate}
        focusPlugins={focusPlugins}
        offerCopySettings={offerCopySettings}
        onBack={(viaKeyboard) => {
          returnFocusTo.current = { hostId: detail.descriptor.id, visible: viaKeyboard === true };
          setFocusBackFor(null);
          setDetailHostId(null);
          setUpdateRequest(null);
          setPluginsRequest(null);
          setCopyRequest(null);
        }}
      />
    );
  }

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      data-testid="hosts-add-host"
      onClick={() => setAddOpen(true)}
    >
      Add host
    </Button>
  );

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Remote hosts"
        description={
          remoteConnectionKind() === "wsl"
            ? "Linux distributions in WSL on this PC that Daintree opens projects in, with their own git, terminals and agents"
            : "Macs and Linux machines this one opens projects on, over your own SSH"
        }
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
            [...hosts]
              .sort((a, b) => hostNameCollator.compare(a.descriptor.name, b.descriptor.name))
              .map(({ descriptor, connection }) => (
                <SettingsRow
                  key={descriptor.id}
                  label={descriptor.name}
                  description={
                    <>
                      {formatHostConnection(descriptor.connection)} ·{" "}
                      {descriptor.platform
                        ? platformLabel(descriptor.platform, null)
                        : "Not seen yet"}
                      <br />
                      {connectionLabel(connection)}
                    </>
                  }
                  control={
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Details for ${descriptor.name}`}
                        data-host-details={descriptor.id}
                        onClick={(event) => {
                          setFocusBackFor(event.detail === 0 ? descriptor.id : null);
                          setDetailHostId(descriptor.id);
                        }}
                      >
                        Details
                      </Button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost-danger"
                            size="icon-sm"
                            aria-label={`Remove ${descriptor.name} from this device`}
                            onClick={() => {
                              setForgetError(null);
                              setForgetTarget({
                                id: descriptor.id,
                                name: descriptor.name,
                                connection: descriptor.connection,
                              });
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Remove host</TooltipContent>
                      </Tooltip>
                    </div>
                  }
                />
              ))
          )}
        </SettingsGroup>
      </SettingsSection>

      <HostModeGroup />

      {addOpen && <AddHostDialog isOpen onClose={() => setAddOpen(false)} />}
      <ConfirmDialog
        isOpen={forgetTarget !== null}
        onClose={() => setForgetTarget(null)}
        variant="destructive"
        title={`Remove '${forgetTarget?.name ?? "host"}' from this device?`}
        description={`Its connection here closes, windows attached to it return to this machine, and its plugin permissions, history and browser data on this device are cleared. ${removeHostOutcome(forgetTarget?.connection, forgetTarget?.name ?? "the host").sentence}`}
        confirmLabel="Remove host"
        onConfirm={confirmForget}
        isConfirmLoading={forgetting}
      >
        {forgetError && (
          <p role="alert" className="text-xs text-status-error select-text">
            {forgetError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
