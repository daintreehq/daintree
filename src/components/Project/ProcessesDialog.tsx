import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { RefreshCw } from "lucide-react";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import type {
  ProcessInventoryPluginProcess,
  ProcessInventorySnapshot,
  ProcessInventoryTerminal,
  ProcessTreeSample,
} from "@shared/types/processes";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { terminalClient } from "@/clients/terminalClient";
import { processesClient } from "@/clients/processesClient";
import { pluralize } from "@/lib/pluralize";
import { isProjectViewCached } from "@/lib/viewCacheState";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import {
  describeMembers,
  describeTerminalKind,
  formatApproxMemory,
  formatCpu,
  groupTerminalsByProject,
  pluginProcessTitle,
  sortPluginProcesses,
  terminalTitle,
  trashSecondsLeft,
} from "./processesView";

const POLL_MS = 4_000;
const TICK_MS = 1_000;
/** Below this the reading is simply current; past it the age earns a line. */
const STALE_AFTER_MS = 10_000;

interface ProcessesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Decided before the confirm opens, so the dialog names what will actually
 * happen: a dev preview stops through its session (which also cancels its
 * recovery), anything else gets the terminal kill.
 */
type KillTarget =
  | { via: "pty"; terminal: ProcessInventoryTerminal }
  | { via: "dev-session"; terminal: ProcessInventoryTerminal; projectId: string; panelId: string };

function incarnationKey(terminal: ProcessInventoryTerminal): string {
  return `${terminal.id}@${terminal.spawnedAt}`;
}

function SampleReadout({ sample }: { sample: ProcessTreeSample | null }): ReactElement {
  if (!sample) {
    return <span className="text-xs text-text-secondary">Not sampled</span>;
  }
  return (
    <span className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-text-secondary">
      <span>{formatCpu(sample.cpuPercent)}</span>
      <span>{formatApproxMemory(sample.memoryKb)}</span>
    </span>
  );
}

/**
 * Every live terminal and plugin process across all projects (#13175): the
 * ones in background projects, evicted views, hidden dev previews and the
 * trash included. Polls only while open, and only while this view is visible.
 */
export function ProcessesDialog({
  isOpen,
  onClose,
  restoreFocusTo,
}: ProcessesDialogProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ProcessInventorySnapshot | null>(null);
  const [devSessions, setDevSessions] = useState<DevPreviewSessionState[]>([]);
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [killTarget, setKillTarget] = useState<KillTarget | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  // Killed rows stay hidden until the next read stops listing them: the kill
  // lands before the census notices. Keyed by PTY generation, so a pane that
  // restarts on exit reappears as the new process it is.
  const [killedIds, setKilledIds] = useState<ReadonlySet<string>>(() => new Set());
  const fetchRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    let inFlight = false;

    const fetchSnapshot = async () => {
      if (inFlight || document.hidden || isProjectViewCached()) return;
      inFlight = true;
      try {
        const [snapshotResult, sessionsResult] = await Promise.allSettled([
          processesClient.getSnapshot(),
          window.electron.devPreview.getAllSessions(),
        ]);
        if (cancelled) return;
        if (snapshotResult.status === "fulfilled") {
          const next = snapshotResult.value;
          setSnapshot(next);
          setReadFailed(false);
          const listed = new Set(next.terminals.map(incarnationKey));
          setKilledIds((prev) => {
            const kept = [...prev].filter((id) => listed.has(id));
            return kept.length === prev.size ? prev : new Set(kept);
          });
        } else {
          setReadFailed(true);
          logError("[ProcessesDialog] Failed to read processes", snapshotResult.reason);
        }
        if (sessionsResult.status === "fulfilled") setDevSessions(sessionsResult.value);
      } finally {
        inFlight = false;
      }
    };

    fetchRef.current = fetchSnapshot;
    void fetchSnapshot();
    const poll = setInterval(() => void fetchSnapshot(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const onVisible = () => {
      if (!document.hidden) void fetchSnapshot();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      fetchRef.current = async () => {};
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isOpen]);

  const terminals = (snapshot?.terminals ?? []).filter(
    (terminal) => !killedIds.has(incarnationKey(terminal))
  );
  const groups = groupTerminalsByProject(terminals);
  const plugins = sortPluginProcesses(snapshot?.plugins ?? []);
  const isEmpty = snapshot !== null && terminals.length + plugins.length === 0;

  // The Kill button leaves with its row, so focus moves to the next row's Kill,
  // or the one before, or the close button once none is left.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<{ killedId: string; neighbourId: string | null } | null>(null);
  const listedIds = groups.flatMap((group) => group.terminals.map((terminal) => terminal.id));
  const listedKey = listedIds.join("\n");
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || listedKey.split("\n").includes(pending.killedId)) return;
    pendingFocusRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const dialog = bodyRef.current?.closest('[role="dialog"]');
    const target =
      (pending.neighbourId !== null &&
        dialog?.querySelector<HTMLElement>(
          `[data-process-kill="${CSS.escape(pending.neighbourId)}"]`
        )) ||
      dialog?.querySelector<HTMLElement>('button[aria-label="Close dialog"]');
    target?.focus();
  }, [listedKey]);

  const requestKill = (terminal: ProcessInventoryTerminal) => {
    setKillError(null);
    // Only a dev preview's PTY belongs to a session.
    const session = devSessions.find((candidate) => candidate.terminalId === terminal.id);
    setKillTarget(
      session
        ? {
            via: "dev-session",
            terminal,
            projectId: session.projectId,
            panelId: session.panelId,
          }
        : { via: "pty", terminal }
    );
  };

  const confirmKill = async () => {
    if (!killTarget) return;
    const { terminal } = killTarget;
    setIsKilling(true);
    try {
      if (killTarget.via === "dev-session") {
        await window.electron.devPreview.stop({
          projectId: killTarget.projectId,
          panelId: killTarget.panelId,
        });
      } else {
        await terminalClient.kill(terminal.id);
      }
      const at = listedIds.indexOf(terminal.id);
      pendingFocusRef.current = {
        killedId: terminal.id,
        neighbourId: listedIds[at + 1] ?? listedIds[at - 1] ?? null,
      };
      setKilledIds((prev) => new Set(prev).add(incarnationKey(terminal)));
      setKillTarget(null);
      void fetchRef.current();
    } catch (error) {
      setKillTarget(null);
      setKillError(
        `Couldn't ${killTarget.via === "dev-session" ? "stop" : "kill"} '${terminalTitle(terminal)}'. ${formatErrorMessage(error, "The process didn't respond.")}`
      );
    } finally {
      setIsKilling(false);
    }
  };

  const sampleAge =
    snapshot && snapshot.sampledAt > 0 ? Math.max(0, now - snapshot.sampledAt) : null;

  const renderTerminal = (terminal: ProcessInventoryTerminal, projectLabel: string) => {
    const title = terminalTitle(terminal);
    const kind = describeTerminalKind(terminal);
    const secondsLeft = trashSecondsLeft(terminal, now);
    const details = [
      kind === title ? null : kind,
      terminal.isTrashed
        ? secondsLeft === null
          ? "In trash"
          : `In trash, ends in ${secondsLeft}s`
        : null,
      terminal.rootPid !== null ? `PID ${terminal.rootPid}` : null,
      terminal.sample ? describeMembers(terminal.sample) : null,
    ].filter((part): part is string => part !== null);
    return (
      <li
        key={terminal.id}
        className="flex min-h-11 items-center gap-3 border-t border-border-subtle py-1.5 first:border-t-0"
        data-testid="process-row"
        data-terminal-id={terminal.id}
      >
        <div className="min-w-0 flex-1">
          <TruncatedTooltip content={title}>
            <div className="truncate text-sm text-text-primary">{title}</div>
          </TruncatedTooltip>
          <div className="truncate text-xs text-text-secondary">{details.join(" · ")}</div>
        </div>
        <SampleReadout sample={terminal.sample} />
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Kill '${title}' in ${projectLabel}`}
          onClick={() => requestKill(terminal)}
          data-process-kill={terminal.id}
        >
          Kill
        </Button>
      </li>
    );
  };

  const renderPlugin = (process: ProcessInventoryPluginProcess) => {
    const title = pluginProcessTitle(process);
    const details = [
      process.source === "plugin-worker" ? "Plugin worker" : `Run by ${process.pluginId}`,
      `PID ${process.pid}`,
      process.sample && process.sample.members.length > 0 ? describeMembers(process.sample) : null,
    ].filter((part): part is string => part !== null);
    return (
      <li
        key={`${process.source}:${process.id}`}
        className="flex min-h-11 items-center gap-3 border-t border-border-subtle py-1.5 first:border-t-0"
        data-testid="plugin-process-row"
      >
        <div className="min-w-0 flex-1">
          <TruncatedTooltip content={title}>
            <div className="truncate text-sm text-text-primary">{title}</div>
          </TruncatedTooltip>
          <div className="truncate text-xs text-text-secondary">{details.join(" · ")}</div>
        </div>
        <SampleReadout sample={process.sample} />
      </li>
    );
  };

  const target = killTarget;
  const targetTitle = target ? terminalTitle(target.terminal) : "";
  const targetWhere = target?.terminal.projectId
    ? ` in ${target.terminal.projectName ?? "an unknown project"}`
    : "";
  const targetCount = target?.terminal.sample?.processCount ?? null;

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        restoreFocusTo={restoreFocusTo}
        data-testid="processes-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>Running processes</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body>
          <div ref={bodyRef} className="flex flex-col gap-4">
            <p className="text-xs leading-snug text-text-secondary">
              Every terminal and plugin process across all projects, including ones whose panel
              isn't on screen. CPU and memory are sampled; each process is counted in full, so
              memory two processes share is counted twice.
              {sampleAge !== null && sampleAge >= STALE_AFTER_MS
                ? ` Sampled ${Math.round(sampleAge / 1000)}s ago.`
                : null}
            </p>
            {killError && (
              <Callout severity="error" size="compact" role="alert">
                {killError}
              </Callout>
            )}
            {readFailed && (
              <Callout
                severity="warning"
                size="compact"
                action={
                  <Button variant="ghost" size="sm" onClick={() => void fetchRef.current()}>
                    <RefreshCw aria-hidden="true" />
                    Retry
                  </Button>
                }
              >
                {snapshot
                  ? "Couldn't refresh the list. Showing the last reading."
                  : "Couldn't read the running processes."}
              </Callout>
            )}
            {snapshot && !snapshot.complete && (
              <Callout severity="warning" size="compact">
                A terminal host didn't answer, so some terminals may be missing.
              </Callout>
            )}
            {snapshot && snapshot.complete && !snapshot.samplesAvailable && (
              <Callout severity="warning" size="compact">
                The last process census failed. CPU and memory are from the reading before it.
              </Callout>
            )}
            {snapshot === null && !readFailed ? (
              <Skeleton label="Loading processes" className="space-y-2">
                <SkeletonBone className="h-4 w-full" />
                <SkeletonBone className="h-4 w-5/6" />
                <SkeletonBone className="h-4 w-3/4" />
              </Skeleton>
            ) : isEmpty ? (
              <p className="text-sm text-text-secondary">
                No terminals or plugin processes are running.
              </p>
            ) : (
              <>
                {groups.map((group) => {
                  const headingId = `processes-group-${group.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                  return (
                    <section key={group.key} aria-labelledby={headingId}>
                      <h3
                        id={headingId}
                        className="mb-1 flex items-baseline justify-between gap-2 text-xs font-medium text-text-secondary"
                      >
                        <span className="truncate">{group.label}</span>
                        <span className="shrink-0 font-normal">
                          {pluralize(group.terminals.length, "terminal")}
                        </span>
                      </h3>
                      <ul>
                        {group.terminals.map((terminal) => renderTerminal(terminal, group.label))}
                      </ul>
                    </section>
                  );
                })}
                {plugins.length > 0 && (
                  <section aria-labelledby="processes-group-plugins">
                    <h3
                      id="processes-group-plugins"
                      className="mb-1 text-xs font-medium text-text-secondary"
                    >
                      Plugins
                    </h3>
                    <ul>{plugins.map(renderPlugin)}</ul>
                  </section>
                )}
              </>
            )}
          </div>
        </AppDialog.Body>
      </AppDialog>
      <ConfirmDialog
        isOpen={target !== null}
        onClose={() => setKillTarget(null)}
        variant="destructive"
        title={target?.via === "dev-session" ? `Stop '${targetTitle}'?` : `Kill '${targetTitle}'?`}
        description={
          target?.via === "dev-session"
            ? `Stops the dev server for this preview${targetWhere}.`
            : `Ends this terminal${targetWhere}${
                targetCount !== null && targetCount > 1
                  ? ` and the ${pluralize(targetCount - 1, "process", "processes")} running in it`
                  : ""
              }.`
        }
        confirmLabel={target?.via === "dev-session" ? "Stop dev server" : "Kill terminal"}
        onConfirm={confirmKill}
        isConfirmLoading={isKilling}
      />
    </>
  );
}
