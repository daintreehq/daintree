import type { ScheduledRunInboxItem } from "@shared/types/ipc/scheduledRuns";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { machineTimeZone } from "@shared/utils/cron";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { lastRunWords } from "./lastRunWords";
import { runDetail, runStartedAt } from "./runWords";
import { formatRunInstant } from "./scheduleWords";

/** The inbox entry a run is filed under: one per run, whichever view writes it. */
export function scheduledRunInboxEntryId(runId: string): string {
  return `scheduled-run:${runId}`;
}

/**
 * A run that settled with no window open, as an unread inbox entry (#15983):
 * the schedule, when it ran, its outcome and the agent's summary or the
 * recorded reason, addressed to its terminal, with its history a click away.
 * Read only from what the history recorded. Null for a run that hasn't settled.
 */
export function scheduledRunInboxEntry(
  item: ScheduledRunInboxItem,
  now: number = Date.now()
): NotificationHistoryEntry | null {
  const { run, schedule } = item;
  const { settlement } = run;
  if (settlement.state !== "settled") return null;
  const timeZone = schedule?.timeZone ?? machineTimeZone();
  const words = lastRunWords(run);

  const started = runStartedAt(run);
  const when =
    started !== null
      ? `started ${formatRunInstant(started, timeZone, now)}`
      : run.origin.dueAt !== null
        ? `due ${formatRunInstant(run.origin.dueAt, timeZone, now)}`
        : formatRunInstant(run.createdAt, timeZone, now);

  const detail = runDetail(run);
  let said: string | null = null;
  if (detail?.kind === "summary") {
    // The agent's claim, said as its own.
    const agentId = run.resume?.agentId;
    const agentName = (agentId && getEffectiveAgentConfig(agentId)?.name) || agentId || "Agent";
    said = `${agentName}: ${detail.text}`;
  } else if (detail) {
    said = detail.text;
  }

  const panelId =
    run.terminalId !== null && run.terminalSpawnedAt !== null ? run.terminalId : undefined;
  const worktreeId = run.resume?.worktreeId ?? undefined;

  return {
    id: scheduledRunInboxEntryId(run.id),
    type: words.severity ?? "info",
    title: schedule?.name ?? "Scheduled run",
    message: `${words.label} · ${when}${said ? ` — ${said}` : ""}`,
    timestamp: settlement.settledAt,
    seenAsToast: false,
    summarized: false,
    countable: true,
    archivedAt: null,
    context: {
      projectId: run.projectId,
      ...(worktreeId ? { worktreeId } : {}),
      ...(panelId ? { panelId } : {}),
      eventKind: "agent",
    },
    // A schedule that's gone took its history with it.
    ...(schedule
      ? {
          actions: [
            {
              label: "View history",
              actionId: "schedules.open" as const,
              actionArgs: { scheduleId: run.scheduleId, projectId: run.projectId },
            },
          ],
        }
      : {}),
  };
}
