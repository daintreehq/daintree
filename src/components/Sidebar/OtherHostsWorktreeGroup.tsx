import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostId } from "@shared/types/remoteHosts";
import { PilotRunState } from "@/components/Pilot/PilotRunState";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { isNewWindowClick, switchToHost } from "@/components/Hosts/hostSwitching";
import { useOtherHostsWorktrees } from "@/components/Hosts/otherHostsWorktrees";
import { bandLabel } from "@/lib/fleetAttention";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";

interface OtherHostsWorktreeGroupProps {
  /** The project this view shows; its worktrees on other hosts are listed. */
  projectId: string | null;
}

function observedLabel(entry: HostWorktreeEntry): string | null {
  if (!entry.observed) return null;
  return bandLabel(entry.observed.band, { agentState: entry.observed.agentState ?? undefined });
}

function describe(entry: HostWorktreeEntry, hostName: string): string {
  const label = observedLabel(entry);
  const state = label ? `, ${label.toLowerCase()} (observed)` : "";
  return `${entry.branch ?? entry.name} on ${hostName}${state}`;
}

/**
 * This project's worktrees on other hosts, under the local ones. Observation
 * only: a row opens that host's project (this window, or a new one on
 * Cmd/Ctrl-click), where its terminals, git and files live. Each row shows the
 * band that host observed, named with the host, never one decided here.
 */
export function OtherHostsWorktreeGroup({ projectId }: OtherHostsWorktreeGroupProps) {
  const hosts = useOtherHostsWorktrees(projectId);
  if (hosts.length === 0) return null;

  const open = (hostId: HostId, entry: HostWorktreeEntry, newWindow: boolean) => {
    void switchToHost(hostId, newWindow, entry.projectId);
  };
  const newWindowHint = `${isMac() ? "Cmd" : "Ctrl"}-click to open in a new window`;

  return (
    <section
      aria-label="On other hosts"
      className="shrink-0 border-t border-border-default"
      data-testid="other-hosts-worktree-group"
    >
      <div className="px-3 pt-2 pb-1">
        <span className={PALETTE_SECTION_LABEL_CLASS}>On other hosts</span>
      </div>
      <ul className="max-h-[30vh] overflow-y-auto pb-2">
        {hosts.flatMap((host) =>
          host.entries.map((entry) => (
            <li key={`${host.hostId}:${entry.projectId}:${entry.worktreeId}`}>
              <button
                type="button"
                data-testid="other-hosts-worktree-row"
                aria-label={describe(entry, host.hostName)}
                title={newWindowHint}
                onClick={(event) => open(host.hostId, entry, isNewWindowClick(event))}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-xs",
                  "transition-colors hover:bg-overlay-subtle",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
                )}
              >
                <span aria-hidden="true" className="flex size-3.5 shrink-0 items-center">
                  {entry.observed && (
                    <PilotRunState
                      band={entry.observed.band}
                      agentState={entry.observed.agentState ?? undefined}
                    />
                  )}
                </span>
                <span aria-hidden="true" className="min-w-0 truncate text-text-primary">
                  {entry.branch ?? entry.name}
                </span>
                <span
                  aria-hidden="true"
                  className="ml-auto min-w-0 max-w-1/2 truncate text-text-secondary"
                >
                  {[observedLabel(entry), host.hostName].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
