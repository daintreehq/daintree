import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { useHostConnection } from "@/hooks/useHostConnection";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import { pluginViewHostId } from "./remotePluginView";
import { announcePluginRemovedFromHost } from "./pluginPanelRemoval";
import { describeIncompatibility } from "./pluginParityCopy";

export interface PluginNotOnHostPlaceholderProps {
  /** The plugin's id as the panel names it. */
  pluginId: string;
  /** The panel's kind, to tell a removal under an open panel from a restore. */
  kind?: string;
  /** Name to show until the host answers with the plugin's own. */
  pluginDisplayName?: string;
  onRemove?: () => void;
}

type RowState =
  | { status: "loading" }
  | { status: "ready"; row: PluginParityRow | null }
  | { status: "unavailable" };

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
}: PluginNotOnHostPlaceholderProps) {
  const hostId = pluginViewHostId();
  const { hostName } = useHostConnection();
  const host = hostName ?? "this host";
  const [rowState, setRowState] = useState<RowState>({ status: "loading" });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const row = rowState.status === "ready" ? rowState.row : null;
  const name = row?.displayName ?? pluginDisplayName ?? pluginId;

  useEffect(() => {
    if (hostId === null) return;
    let cancelled = false;
    window.electron.pluginParity.diff({ hostId }).then(
      (rows) => {
        if (cancelled) return;
        setRowState({
          status: "ready",
          row: rows.find((candidate) => candidate.pluginId === pluginId) ?? null,
        });
      },
      () => {
        if (!cancelled) setRowState({ status: "unavailable" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [hostId, pluginId]);

  const settled = rowState.status !== "loading";
  useEffect(() => {
    if (kind !== undefined && settled) announcePluginRemovedFromHost(kind, pluginId, name, host);
  }, [kind, settled, pluginId, name, host]);

  const canInstall = hostId !== null && row?.action === "install-on-host";

  const install = () => {
    if (hostId === null) return;
    setInstalling(true);
    setInstallError(null);
    window.electron.pluginParity.installOnHost({ hostId, pluginId }).then(
      // The host announces the plugin's panels once it loads, which swaps
      // this placeholder for the panel itself.
      () => setInstalling(false),
      (err: unknown) => {
        setInstalling(false);
        setInstallError(formatErrorMessage(err, `Couldn't install ${name} on ${host}`));
      }
    );
  };

  const reason = row?.incompatibility ? describeIncompatibility(row.incompatibility, host) : null;
  const description = installError
    ? installError
    : reason
      ? reason
      : canInstall
        ? `It's installed on this machine. Install it on ${host} to use this panel here.`
        : rowState.status === "loading"
          ? `Checking which plugins ${host} has`
          : `Install it on ${host} to use this panel here.`;

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
        title={`${name} isn't installed on ${host}`}
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
          canInstall || onRemove ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
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
                  Remove panel
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
