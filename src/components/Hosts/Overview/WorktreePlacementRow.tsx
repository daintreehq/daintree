import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import type { PlacedWorktree } from "@shared/types/ipc/projectMatch";
import { onHostSwitchSettled } from "@/components/HostSwitch/hostSwitchRequests";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isRemoteShellSupported } from "@/lib/remoteHosts";
import { actionService } from "@/services/ActionService";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useHostMetricsStore, type HostMetricsHistory } from "@/store/hostMetricsStore";
import { cn } from "@/lib/utils";
import { logWarn } from "@/utils/logger";
import { hasRemoteHosts, useHostFigures, useHostList } from "../hostList";
import {
  buildHostMenuRows,
  clientPlatform,
  describeHostMenuState,
  hostAgentCliNames,
  localHostLabel,
  type HostMenuRow,
} from "../hostModel";
import { isNewWindowClick } from "../hostSwitching";
import { useProjectHosts } from "../projectHosts";
import {
  CHECKING,
  describePlacementProjectFacts,
  type PlacementProjectFacts,
} from "./placementProjectFacts";
import { compareHostCapacity, isLive, type PlacementComparison } from "./overviewModel";

/** The new-worktree form as the dialog validated it; `path` is this host's absolute path. */
export interface PlacementDraft extends Omit<PlacedWorktree, "relativePath"> {
  path: string;
}

/**
 * Where an attempt to create the worktree on another host stands: pending
 * while that host's dialog has it, failed when it couldn't be handed over,
 * cancelled when that dialog closed without creating anything.
 */
export type PlacementStatus = "idle" | "pending" | "failed" | "cancelled";

/**
 * Another host chosen for the worktree, for the dialog to answer with: its
 * primary creates the worktree there instead of here.
 */
export interface PlacementCommit {
  hostId: HostId;
  hostName: string;
  /**
   * This window's own host as the host menu names it ("This Mac", or a host's
   * name): where the choices the chosen host won't use are kept.
   */
  homeName: string;
  status: PlacementStatus;
  /** The link's own words while the host can't take it ("Not connected"); null while it can. */
  unavailable: string | null;
  /** The worktree's path relative to the project, as the host lays it out; null when the host picks. */
  relativePath: string | null;
  /** Create the form's worktree there; a Cmd/Ctrl-click opens the host in a new window. */
  submit: (click?: Pick<MouseEvent, "metaKey" | "ctrlKey">) => void;
}

interface WorktreePlacementRowProps {
  /** This window's project, which moves to another host through git. */
  projectId: string | null;
  /** The project folder on this window's host, which the worktree path is taken relative to. */
  rootPath: string;
  /** The form's path on this window's host, which carries to another host relative to the project. */
  worktreePath: string;
  /** The form, validated; null when it isn't valid (the dialog then shows why). */
  getDraft: () => PlacementDraft | null;
  /** Close the new-worktree dialog once the worktree exists on the chosen host. */
  onLeave: () => void;
  /**
   * Another host chosen, while one is: nothing is created here then, and the
   * dialog's primary creates it on that host. Null for the window's own host.
   */
  onCommitChange?: (commit: PlacementCommit | null) => void;
}

export function suggestPlacement(
  rows: readonly HostMenuRow[],
  history: HostMetricsHistory
): PlacementComparison {
  return compareHostCapacity(
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

/** A host that can't be picked, in its link's own words: "Not connected · Last seen 3 hours ago". */
function describeUnavailable(row: HostMenuRow): string {
  const { state, note } = describeHostMenuState(row);
  return [state ?? "Not connected", note].filter(Boolean).join(" · ");
}

/**
 * Facts set apart by the house dot, each kept whole so a line only breaks
 * between them. Every fact carries its dot in front, and the run is shifted
 * left by one dot's width and clipped, so the dot that would open a line is
 * cut off and none is left dangling at a line's end.
 */
function FactRun({ parts }: { parts: readonly string[] }) {
  return (
    <span className="block overflow-hidden">
      <span className="-ml-3 flex flex-wrap">
        {parts.map((part) => (
          <span key={part} className="whitespace-nowrap">
            <span className="inline-block w-3 text-center">
              <FactSeparator />
            </span>
            {part}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * Where the new worktree goes. The window's host is preselected, so nothing
 * changes unless the user picks another; the chosen host's reported facts sit
 * under it, and the one with the most free cores and memory is named when
 * there is one. Picking another host hands the dialog's primary to it (see
 * {@link PlacementCommit}): the project goes through the open-on-host flow
 * (matched or cloned there), and the dialog on that host creates this form's
 * branch, path and recipe. This dialog stays open until that has happened.
 * Shown only once a host other than this machine exists.
 */
export function WorktreePlacementRow({
  projectId,
  rootPath,
  worktreePath,
  getDraft,
  onLeave,
  onCommitChange,
}: WorktreePlacementRowProps) {
  const hostStatus = useHostList();
  const visible = isRemoteShellSupported() && hasRemoteHosts(hostStatus);
  // Each host's load is compared here, so its figures are followed while it shows.
  const hostList = useHostFigures(visible);
  const history = useHostMetricsStore((state) => state.history);
  const windowHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const [chosen, setChosen] = useState<HostId>(windowHostId);
  const [status, setStatus] = useState<PlacementStatus>("idle");
  const projectHosts = useProjectHosts(projectId);
  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: windowHostId,
    localSummary: history.get(LOCAL_HOST_ID)?.[0] ?? hostList.localSummary,
  });
  const chosenRow = rows.find((row) => row.hostId === chosen) ?? rows[0]!;
  const elsewhere = visible && chosen !== windowHostId;
  const relativePath = placedRelativePath(rootPath, worktreePath);
  const unavailable = elsewhere && !isLive(chosenRow) ? describeUnavailable(chosenRow) : null;

  const choose = (hostId: HostId) => {
    setChosen(hostId);
    setStatus("idle");
  };

  // The dialog stays open until the worktree exists on the host: closing
  // first would leave a failed or abandoned handoff with nothing to retry from.
  const lastNewWindow = useRef(false);
  const continueOnHost = async (newWindow: boolean) => {
    if (!projectId || status === "pending") return;
    const draft = getDraft();
    if (!draft) return;
    const target = chosenRow;
    lastNewWindow.current = newWindow;
    setStatus("pending");
    const result = await actionService.dispatch(
      "project.openOnHost",
      {
        hostId: target.hostId,
        projectId,
        worktree: toPlacedWorktree(draft, rootPath),
        newWindow,
      },
      { source: "user" }
    );
    const payload: unknown = result.ok ? result.result : undefined;
    const requestId =
      payload !== null && typeof payload === "object" && "requestId" in payload
        ? payload.requestId
        : undefined;
    if (result.ok && typeof requestId === "number") {
      onHostSwitchSettled(requestId, (settlement) => {
        if (settlement === "completed") {
          setStatus("idle");
          onLeave();
          return;
        }
        setStatus("cancelled");
        useAnnouncerStore.getState().announce(`Nothing created on ${target.name}`);
      });
      return;
    }
    if (result.ok) {
      setStatus("idle");
      return;
    }
    logWarn("[Hosts] Handing the project to another host failed", { error: result.error });
    setStatus("failed");
  };
  // The dialog holds one stable submit; each call reaches the latest form.
  const continueRef = useRef(continueOnHost);
  useEffect(() => {
    continueRef.current = continueOnHost;
  });
  const [submit] = useState(
    () => (click?: Pick<MouseEvent, "metaKey" | "ctrlKey">) =>
      void continueRef.current(click ? isNewWindowClick(click) : false)
  );

  const hostName = elsewhere ? chosenRow.name : null;
  const homeName =
    rows.find((row) => row.hostId === windowHostId)?.name ?? localHostLabel(clientPlatform());
  useEffect(() => {
    onCommitChange?.(
      hostName === null
        ? null
        : { hostId: chosen, hostName, homeName, status, unavailable, relativePath, submit }
    );
  }, [onCommitChange, chosen, hostName, homeName, status, unavailable, relativePath, submit]);
  // Gone from the dialog, it chooses no other host: local Create must not stay blocked.
  useEffect(() => () => onCommitChange?.(null), [onCommitChange]);

  if (!visible) return null;

  const comparison = suggestPlacement(rows, history);
  const best = rows.find((row) => row.hostId === comparison.suggestedHostId) ?? null;
  const usageOf = (hostId: HostId) =>
    comparison.options.find((option) => option.hostId === hostId)?.parts ?? [];
  const projectFactsOf = (hostId: HostId): PlacementProjectFacts | null => {
    const host = projectHosts.find((entry) => entry.hostId === hostId);
    if (!host) return null;
    return describePlacementProjectFacts(
      host,
      host.row,
      history.get(hostId)?.[0] ?? host.row.summary
    );
  };

  const chosenFacts = chosenRow.isCurrent ? null : projectFactsOf(chosenRow.hostId);
  const facts: { label: string; value: ReactNode; live?: boolean; pending?: boolean }[] = [];
  if (chosenFacts) {
    facts.push({
      label: "Project",
      value: chosenFacts.project,
      live: true,
      pending: chosenFacts.project === CHECKING,
    });
  }
  facts.push({ label: "Usage", value: <FactRun parts={usageOf(chosenRow.hostId)} /> });
  if (!chosenRow.isLocal) {
    const clis = chosenFacts ? chosenFacts.agentClis : hostAgentCliNames(chosenRow);
    facts.push({
      label: "Agent CLIs",
      value:
        clis === null ? (
          "Not reported"
        ) : clis.length === 0 ? (
          "None detected"
        ) : (
          <FactRun parts={clis} />
        ),
    });
  }
  if (chosenFacts?.control) {
    facts.push({
      label: "Control",
      value: chosenFacts.control,
      pending: chosenFacts.control === CHECKING,
    });
  }
  // Named when only two hosts were compared: "than the others" would be one host.
  const liveRows = rows.filter(isLive);
  const comparedWith =
    liveRows.length === 2 ? liveRows.find((row) => row.hostId !== best?.hostId)?.name : null;

  return (
    <FormRow
      label="Host"
      htmlFor="worktree-host"
      hint={
        <div className="flex flex-col gap-2">
          {/* The floor keeps the value column still as rows come and go between hosts. */}
          <dl
            className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-4"
            data-testid="worktree-placement-facts"
          >
            {facts.map((fact) => (
              <Fragment key={fact.label}>
                <dt className="text-text-secondary">{fact.label}</dt>
                <dd
                  className={cn(
                    "min-w-0",
                    fact.pending ? "text-text-secondary" : "text-text-primary"
                  )}
                >
                  {fact.live ? <span role="status">{fact.value}</span> : fact.value}
                </dd>
              </Fragment>
            ))}
          </dl>
          {status === "failed" && (
            <Callout
              severity="error"
              size="compact"
              role="alert"
              data-testid="worktree-placement-error"
              title={`Couldn't open this project on ${chosenRow.name}`}
              action={
                // The same window the failed attempt asked for.
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void continueOnHost(lastNewWindow.current)}
                >
                  Retry
                </Button>
              }
            >
              <p>Check that it&apos;s connected.</p>
            </Callout>
          )}
          {best && best.hostId !== chosenRow.hostId && (
            <p
              className="text-xs leading-4 text-text-secondary"
              data-testid="worktree-placement-suggestion"
            >
              {`${best.name} reports more free cores and memory than ${comparedWith ?? "the others"}. `}
              <Button
                variant="link"
                size="inline"
                className="text-xs"
                disabled={status === "pending"}
                onClick={() => choose(best.hostId)}
              >
                Use {best.name}
              </Button>
            </p>
          )}
        </div>
      }
    >
      <Select
        value={chosenRow.hostId}
        disabled={status === "pending"}
        onValueChange={(hostId) => {
          const row = rows.find((entry) => entry.hostId === hostId);
          if (row && isLive(row)) choose(hostId);
        }}
      >
        <SelectTrigger
          id="worktree-host"
          className="h-8 min-w-0"
          data-testid="worktree-host-select"
          onKeyDown={(event) => {
            // The dialog's create shortcut, not a way to open the list: Radix
            // opens on any Enter unless the event is already handled.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.preventDefault();
          }}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {rows.map((row) => {
            const live = isLive(row);
            const project = row.hostId === windowHostId ? null : projectFactsOf(row.hostId);
            return (
              <SelectItem
                key={row.hostId}
                value={row.hostId}
                unavailable={!live}
                description={
                  live ? (
                    <>
                      {best?.hostId === row.hostId && (
                        <span className="block">Reports more free cores and memory</span>
                      )}
                      <FactRun parts={usageOf(row.hostId)} />
                      {project && <span className="block">{project.project}</span>}
                    </>
                  ) : (
                    describeUnavailable(row)
                  )
                }
              >
                {row.name}
                {row.hostId === windowHostId ? " (this window)" : ""}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </FormRow>
  );
}
