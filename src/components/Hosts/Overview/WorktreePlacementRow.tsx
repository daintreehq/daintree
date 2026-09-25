import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId, type HostMetricsSummary } from "@shared/types/remoteHosts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { actionService } from "@/services/ActionService";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { hasRemoteHosts, useHostList } from "../hostList";
import { buildHostMenuRows, clientPlatform, type HostMenuRow } from "../hostModel";
import { startHostMetricsFeed } from "./hostMetricsFeed";
import { isLive, rankPlacement, type PlacementChoice } from "./overviewModel";

interface WorktreePlacementRowProps {
  /** This window's project, which moves to another host through git. */
  projectId: string | null;
  /** Close the new-worktree dialog: the project continues on the chosen host. */
  onLeave: () => void;
  /** True while another host than the window's is chosen: nothing is created here then. */
  onElsewhereChange?: (elsewhere: boolean) => void;
}

export function suggestPlacement(
  rows: readonly HostMenuRow[],
  history: Record<HostId, HostMetricsSummary[]>
): PlacementChoice[] {
  return rankPlacement(
    rows.map((row) => ({
      hostId: row.hostId,
      name: row.name,
      summary: history[row.hostId]?.[0] ?? row.summary,
      reachable: isLive(row),
    }))
  );
}

/**
 * Where the new worktree goes. The window's host is preselected, so nothing
 * changes unless the user picks another; the least-loaded host is always
 * named beside it. Picking another host hands the project over through the
 * open-on-host flow rather than creating anything here. Shown only once a
 * host other than this machine exists.
 */
export function WorktreePlacementRow({
  projectId,
  onLeave,
  onElsewhereChange,
}: WorktreePlacementRowProps) {
  const hostList = useHostList();
  const history = useHostMetricsStore((state) => state.history);
  const windowHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const [chosen, setChosen] = useState<HostId>(windowHostId);
  const visible = isRemoteHostsSupported() && hasRemoteHosts(hostList);

  useEffect(() => (visible ? startHostMetricsFeed() : undefined), [visible]);
  const elsewhere = visible && chosen !== windowHostId;
  useEffect(() => onElsewhereChange?.(elsewhere), [elsewhere, onElsewhereChange]);

  if (!visible) return null;

  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: windowHostId,
    localSummary: history[LOCAL_HOST_ID]?.[0] ?? hostList.localSummary,
  });
  const ranked = suggestPlacement(rows, history);
  const best = ranked[0] ?? null;
  const chosenRow = rows.find((row) => row.hostId === chosen) ?? rows[0]!;

  const continueOnHost = () => {
    if (!projectId) return;
    onLeave();
    void actionService.dispatch(
      "project.openOnHost",
      { hostId: chosenRow.hostId, projectId },
      { source: "user" }
    );
  };

  return (
    <FormRow
      label="Host"
      htmlFor="worktree-host"
      hint={
        <span className="text-xs text-text-secondary" data-testid="worktree-placement-suggestion">
          {best
            ? `Least loaded: ${best.name} · ${best.reason}`
            : "No host has reported its load yet"}
        </span>
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <Select value={chosenRow.hostId} onValueChange={setChosen}>
          <SelectTrigger
            id="worktree-host"
            className="h-8 min-w-0 flex-1"
            data-testid="worktree-host-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rows.map((row) => (
              <SelectItem key={row.hostId} value={row.hostId} disabled={!isLive(row)}>
                {row.name}
                {row.hostId === windowHostId ? " (this window)" : ""}
                {best?.hostId === row.hostId ? " · least loaded" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {best && best.hostId !== chosenRow.hostId && (
          <Button variant="ghost" size="sm" onClick={() => setChosen(best.hostId)}>
            Use {best.name}
          </Button>
        )}
        {elsewhere && (
          <Button
            variant="outline"
            size="sm"
            onClick={continueOnHost}
            disabled={!projectId}
            data-testid="worktree-placement-continue"
          >
            Continue on {chosenRow.name}…
          </Button>
        )}
      </div>
    </FormRow>
  );
}
