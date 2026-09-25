import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
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
import { useHostMetricsStore, type HostMetricsHistory } from "@/store/hostMetricsStore";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostList } from "../hostList";
import { buildHostMenuRows, clientPlatform, type HostMenuRow } from "../hostModel";
import { startHostMetricsFeed } from "./hostMetricsFeed";
import { isLive, rankPlacement, type PlacementChoice } from "./overviewModel";

interface WorktreePlacementRowProps {
  /** This window's project, which moves to another host through git. */
  projectId: string | null;
  /** Close the new-worktree dialog once the chosen host's switch dialog has opened. */
  onLeave: () => void;
  /** True while another host than the window's is chosen: nothing is created here then. */
  onElsewhereChange?: (elsewhere: boolean) => void;
}

export function suggestPlacement(
  rows: readonly HostMenuRow[],
  history: HostMetricsHistory
): PlacementChoice[] {
  return rankPlacement(
    rows.map((row) => ({
      hostId: row.hostId,
      name: row.name,
      summary: history.get(row.hostId)?.[0] ?? row.summary,
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
  const [handoff, setHandoff] = useState<
    { status: "idle" } | { status: "pending" } | { status: "failed"; hostName: string }
  >({ status: "idle" });
  const visible = isRemoteHostsSupported() && hasRemoteHosts(hostList);

  useEffect(() => (visible ? startHostMetricsFeed() : undefined), [visible]);
  const elsewhere = visible && chosen !== windowHostId;
  useEffect(() => onElsewhereChange?.(elsewhere), [elsewhere, onElsewhereChange]);

  if (!visible) return null;

  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: windowHostId,
    localSummary: history.get(LOCAL_HOST_ID)?.[0] ?? hostList.localSummary,
  });
  const ranked = suggestPlacement(rows, history);
  const best = ranked[0] ?? null;
  const chosenRow = rows.find((row) => row.hostId === chosen) ?? rows[0]!;

  // The dialog stays open until the host's switch dialog is up: closing first
  // would leave a failed handoff with neither dialog nor explanation.
  const continueOnHost = async () => {
    if (!projectId || handoff.status === "pending") return;
    const target = chosenRow;
    setHandoff({ status: "pending" });
    const result = await actionService.dispatch(
      "project.openOnHost",
      { hostId: target.hostId, projectId },
      { source: "user" }
    );
    if (result.ok) {
      setHandoff({ status: "idle" });
      onLeave();
      return;
    }
    logWarn("[Hosts] Handing the project to another host failed", { error: result.error });
    setHandoff({ status: "failed", hostName: target.name });
  };

  return (
    <FormRow
      label="Host"
      htmlFor="worktree-host"
      hint={
        handoff.status === "failed" ? (
          <span
            role="alert"
            className="text-xs text-status-error"
            data-testid="worktree-placement-error"
          >
            {`Couldn't open this project on ${handoff.hostName}. Check that it's connected and retry.`}
          </span>
        ) : (
          <span className="text-xs text-text-secondary" data-testid="worktree-placement-suggestion">
            {best
              ? `Least loaded: ${best.name} · ${best.reason}`
              : "No host has reported its load yet"}
          </span>
        )
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={chosenRow.hostId}
          onValueChange={(hostId) => {
            setChosen(hostId);
            setHandoff({ status: "idle" });
          }}
        >
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setChosen(best.hostId);
              setHandoff({ status: "idle" });
            }}
          >
            Use {best.name}
          </Button>
        )}
        {elsewhere && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void continueOnHost()}
            disabled={!projectId || handoff.status === "pending"}
            data-testid="worktree-placement-continue"
          >
            Continue on {chosenRow.name}…
          </Button>
        )}
      </div>
    </FormRow>
  );
}
