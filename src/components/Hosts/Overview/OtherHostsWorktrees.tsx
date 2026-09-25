import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { cn } from "@/lib/utils";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { hasRemoteHosts, useHostList } from "../hostList";
import { buildHostMenuRows, clientPlatform, type HostMenuRow } from "../hostModel";
import { switchToHost, isNewWindowClick } from "../hostSwitching";
import { isLive } from "./overviewModel";

type HostWorktrees =
  | { hostId: HostId; name: string; kind: "loaded"; entries: HostWorktreeEntry[] }
  | { hostId: HostId; name: string; kind: "failed"; message: string }
  | { hostId: HostId; name: string; kind: "unreachable"; status: string };

/** Every other host's worktrees, read once per disclosure. */
export async function loadOtherHostsWorktrees(
  rows: readonly HostMenuRow[]
): Promise<HostWorktrees[]> {
  return Promise.all(
    rows
      .filter((row) => !row.isCurrent)
      .map(async (row): Promise<HostWorktrees> => {
        if (!isLive(row)) {
          return {
            hostId: row.hostId,
            name: row.name,
            kind: "unreachable",
            status: "Not connected",
          };
        }
        try {
          const entries = await window.electron.hostMetrics.listWorktrees({ hostId: row.hostId });
          return { hostId: row.hostId, name: row.name, kind: "loaded", entries };
        } catch (error) {
          return {
            hostId: row.hostId,
            name: row.name,
            kind: "failed",
            message: formatErrorMessage(error, "Couldn't list its worktrees"),
          };
        }
      })
  );
}

interface OtherHostsWorktreesProps {
  /** Close the overview: a row opens its host in this window or a new one. */
  onNavigate: () => void;
}

/**
 * A read-only look at the worktrees on every other host, under this view's
 * own list. Nothing here acts on another host's worktree: a row only opens
 * that host's project, where the worktree's own actions live.
 */
export function OtherHostsWorktrees({ onNavigate }: OtherHostsWorktreesProps) {
  const hostList = useHostList();
  const [expanded, setExpanded] = useState(false);
  const [hosts, setHosts] = useState<HostWorktrees[] | null>(null);
  if (!isRemoteHostsSupported() || !hasRemoteHosts(hostList)) return null;

  const windowHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: windowHostId,
    localSummary: hostList.localSummary,
  });

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      setHosts(null);
      void loadOtherHostsWorktrees(rows).then(setHosts);
    }
  };

  const open = (entry: HostWorktreeEntry, newWindow: boolean) => {
    onNavigate();
    void switchToHost(entry.hostId, newWindow, entry.projectId);
  };

  return (
    <div className="shrink-0 border-t border-border-default" data-testid="other-hosts-worktrees">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-text-secondary",
          "transition-colors hover:bg-overlay-subtle hover:text-text-primary",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
        )}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
          aria-hidden="true"
        />
        All hosts
      </button>
      {expanded && (
        <div className="max-h-[30vh] overflow-y-auto pb-2">
          {hosts === null ? (
            <p className="px-3 py-1 text-xs text-text-secondary">Asking the other hosts…</p>
          ) : (
            hosts.map((host) => (
              <section key={host.hostId} aria-label={`Worktrees on ${host.name}`}>
                <div className="flex items-baseline gap-1.5 px-3 pt-2 pb-1">
                  <span className={PALETTE_SECTION_LABEL_CLASS}>{host.name}</span>
                  {host.kind === "loaded" && (
                    <span className="text-3xs tabular-nums text-text-secondary">
                      {host.entries.length}
                    </span>
                  )}
                </div>
                {host.kind === "unreachable" && (
                  <p className="px-3 text-xs text-text-secondary">{host.status}</p>
                )}
                {host.kind === "failed" && (
                  <p className="px-3 text-xs text-text-secondary">{host.message}</p>
                )}
                {host.kind === "loaded" && host.entries.length === 0 && (
                  <p className="px-3 text-xs text-text-secondary">No open projects</p>
                )}
                {host.kind === "loaded" && host.entries.length > 0 && (
                  <ul>
                    {host.entries.map((entry) => (
                      <li key={`${entry.projectId}:${entry.worktreeId}`}>
                        <button
                          type="button"
                          data-testid="other-host-worktree-row"
                          onClick={(event) => open(entry, isNewWindowClick(event))}
                          className={cn(
                            "flex w-full min-w-0 items-baseline gap-2 px-3 py-1 text-left text-xs",
                            "transition-colors hover:bg-overlay-subtle",
                            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
                          )}
                        >
                          <span className="min-w-0 truncate text-text-primary">
                            {entry.branch ?? entry.name}
                          </span>
                          <span className="min-w-0 truncate text-text-secondary">
                            {entry.projectName}
                            {entry.modifiedCount ? ` · ${entry.modifiedCount} changed` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
