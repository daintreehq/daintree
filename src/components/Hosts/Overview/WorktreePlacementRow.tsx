import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import type { PlacedWorktree } from "@shared/types/ipc/projectMatch";
import { onHostSwitchSettled } from "@/components/HostSwitch/hostSwitchRequests";
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

/** The new-worktree form as the dialog validated it; `path` is this host's absolute path. */
export interface PlacementDraft extends Omit<PlacedWorktree, "relativePath"> {
  path: string;
}

interface WorktreePlacementRowProps {
  /** This window's project, which moves to another host through git. */
  projectId: string | null;
  /** The project folder on this window's host, which the worktree path is taken relative to. */
  rootPath: string;
  /** The form, validated; null when it isn't valid (the dialog then shows why). */
  getDraft: () => PlacementDraft | null;
  /** Close the new-worktree dialog once the worktree exists on the chosen host. */
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

function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The worktree's path relative to the project folder, which carries to
 * another host's copy of the project (a sibling `-worktrees` folder stays a
 * sibling). Null when there is no path, or it isn't under the project's
 * parent: then the host puts it where its own pattern says.
 */
export function placedRelativePath(rootPath: string, worktreePath: string): string | null {
  const root = toPosix(rootPath);
  const target = toPosix(worktreePath);
  if (!root.startsWith("/") || !target.startsWith("/")) return null;
  const parent = root.slice(0, root.lastIndexOf("/"));
  if (target === root || !target.startsWith(`${parent}/`)) return null;
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  return `../${target.slice(parent.length + 1)}`;
}

/** The draft as the other host takes it. */
export function toPlacedWorktree(draft: PlacementDraft, rootPath: string): PlacedWorktree {
  const { path, ...rest } = draft;
  return { ...rest, relativePath: placedRelativePath(rootPath, path) };
}

/**
 * Where the new worktree goes. The window's host is preselected, so nothing
 * changes unless the user picks another; the least-loaded host is always
 * named beside it. Picking another host creates the worktree there instead:
 * the project goes through the open-on-host flow (matched or cloned there),
 * and the dialog on that host creates this form's branch, path and recipe.
 * This dialog stays open until that has happened. Shown only once a host
 * other than this machine exists.
 */
export function WorktreePlacementRow({
  projectId,
  rootPath,
  getDraft,
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

  // The dialog stays open until the worktree exists on the host: closing
  // first would leave a failed or abandoned handoff with nothing to retry from.
  const continueOnHost = async () => {
    if (!projectId || handoff.status === "pending") return;
    const draft = getDraft();
    if (!draft) return;
    const target = chosenRow;
    setHandoff({ status: "pending" });
    const result = await actionService.dispatch(
      "project.openOnHost",
      { hostId: target.hostId, projectId, worktree: toPlacedWorktree(draft, rootPath) },
      { source: "user" }
    );
    const requestId = result.ok
      ? (result.result as { requestId?: unknown } | undefined)?.requestId
      : undefined;
    if (result.ok && typeof requestId === "number") {
      onHostSwitchSettled(requestId, (settlement) => {
        setHandoff({ status: "idle" });
        if (settlement === "completed") onLeave();
      });
      return;
    }
    if (result.ok) {
      setHandoff({ status: "idle" });
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
            {handoff.status === "pending"
              ? `Creating on ${chosenRow.name}…`
              : `Create on ${chosenRow.name}…`}
          </Button>
        )}
      </div>
    </FormRow>
  );
}
