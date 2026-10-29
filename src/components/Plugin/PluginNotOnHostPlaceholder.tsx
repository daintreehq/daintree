import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { useHostConnection } from "@/hooks/useHostConnection";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import { pluginViewHostId } from "./remotePluginView";
import { announcePluginRemovedFromHost } from "./pluginPanelRemoval";
import { describeIncompatibility, pluginParityErrorText } from "./pluginParityCopy";

export interface PluginNotOnHostPlaceholderProps {
  /** The plugin's id as the panel names it. */
  pluginId: string;
  /** The panel's kind, to tell a removal under an open panel from a restore. */
  kind?: string;
  /** Name to show until the host answers with the plugin's own. */
  pluginDisplayName?: string;
  onRemove?: () => void;
  /** What the `onRemove` button says, for a host whose way out is not removing a panel. */
  removeLabel?: string;
}

type RowState =
  | { status: "loading" }
  | { status: "ready"; row: PluginParityRow | null }
  | { status: "unavailable"; error: unknown };

/**
 * A panel in a window on another machine whose plugin that host doesn't
 * have: a saved panel from before, or one whose plugin the host removed while
 * it was open. It offers to install this machine's copy there, and does
 * nothing until asked.
 */
export function PluginNotOnHostPlaceholder({
  pluginId,
  kind,
  pluginDisplayName,
  onRemove,
  removeLabel = "Remove panel",
}: PluginNotOnHostPlaceholderProps) {
  const hostId = pluginViewHostId();
  const { hostName } = useHostConnection();
  const host = hostName ?? "this host";
  const [rowState, setRowState] = useState<RowState>({ status: "loading" });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  /** Bumped to compare again: a Retry, or a finished install. */
  const [attempt, setAttempt] = useState(0);

  const row = rowState.status === "ready" ? rowState.row : null;
  const name = row?.displayName ?? pluginDisplayName ?? pluginId;

  useEffect(() => {
    if (hostId === null) return;
    let cancelled = false;
    window.electron.pluginParity.diff({ hostId }).then(
      (rows) => {
        if (cancelled) return;
        // A comparison after an install is the evidence from then on.
        setInstalled(false);
        setRowState({
          status: "ready",
          row: rows.find((candidate) => candidate.pluginId === pluginId) ?? null,
        });
      },
      (error: unknown) => {
        if (!cancelled) setRowState({ status: "unavailable", error });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [hostId, pluginId, attempt]);

  // Only a comparison that succeeded and found no copy on the host is evidence
  // of a removal; a host that couldn't answer proves nothing.
  const confirmedAbsent =
    rowState.status === "ready" && (rowState.row === null || rowState.row.hostVersion === null);
  useEffect(() => {
    if (kind !== undefined && confirmedAbsent) {
      announcePluginRemovedFromHost(kind, pluginId, name, host);
    }
  }, [kind, confirmedAbsent, pluginId, name, host]);

  // Not again once an install went in: the row is stale until the comparison reruns.
  const canInstall = hostId !== null && row?.action === "install-on-host" && !installed;

  const install = () => {
    if (hostId === null || installing) return;
    setInstalling(true);
    setInstallError(null);
    window.electron.pluginParity.installOnHost({ hostId, pluginId }).then(
      // The host announces the plugin's panels once it loads, which swaps
      // this placeholder for the panel itself. Until then, say it went in.
      () => {
        setInstalling(false);
        setInstalled(true);
        setAttempt((n) => n + 1);
      },
      (err: unknown) => {
        setInstalling(false);
        setInstallError(pluginParityErrorText(err, host, `Couldn't install ${name} on ${host}`));
      }
    );
  };

  const retry = () => {
    setRowState({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  const reason = row?.incompatibility ? describeIncompatibility(row.incompatibility, host) : null;
  const onHost = installed || (row !== null && row.hostVersion !== null);
  let title: string;
  let detail: string;
  if (rowState.status === "loading") {
    title = `${name} isn't available from ${host}`;
    detail = `Checking which plugins ${host} has`;
  } else if (rowState.status === "unavailable") {
    title = `Couldn't check ${name} on ${host}`;
    detail = pluginParityErrorText(
      rowState.error,
      host,
      `Couldn't compare this machine's plugins with ${host}'s.`
    );
  } else if (onHost) {
    // A copy is there. All that's seen is that the host didn't offer this panel.
    title = `${name}'s panel isn't available from ${host}`;
    const seen = installed
      ? `Installed on ${host}.`
      : `It's installed on ${host}, but ${host} hasn't offered this panel here.`;
    detail = reason ?? `${seen} If it doesn't appear, check the plugin in Plugins on ${host}.`;
  } else if (canInstall) {
    title = `${name} isn't installed on ${host}`;
    detail = reason
      ? `It's installed on this machine. ${reason}`
      : `It's installed on this machine. Install it on ${host} to use this panel here.`;
  } else if (reason) {
    title = `${name} can't run here from ${host}`;
    detail = reason;
  } else {
    // No row says nothing about this machine: project plugins are never compared.
    title = `${name} isn't available from ${host}`;
    detail = `Daintree has no copy of it here that it can install on ${host}.`;
  }
  const description = installError ?? detail;

  return (
    <div
      role="region"
      aria-label="Plugin not on this host"
      className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-surface-panel"
      data-testid="plugin-not-on-host"
    >
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<Puzzle />}
        title={title}
        description={
          installError ? (
            <span role="alert" className="text-status-error select-text">
              {description}
            </span>
          ) : (
            description
          )
        }
        action={
          canInstall || onRemove || rowState.status === "unavailable" ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {rowState.status === "unavailable" && (
                <Button variant="outline" size="sm" onClick={retry}>
                  Retry
                </Button>
              )}
              {canInstall && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={install}
                  disabled={installing}
                  aria-busy={installing || undefined}
                >
                  {`Install on ${host}`}
                </Button>
              )}
              {onRemove && (
                <Button variant="ghost" size="sm" onClick={onRemove}>
                  {removeLabel}
                </Button>
              )}
            </div>
          ) : undefined
        }
        className="my-auto"
      />
    </div>
  );
}
