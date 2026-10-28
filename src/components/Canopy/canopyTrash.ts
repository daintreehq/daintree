import type { CanopyTrashEntry } from "@shared/types/ipc/canopy";
import {
  buildPilotGroups,
  type PilotAgentRow,
  type PilotWorkspaceMeta,
} from "@/components/Pilot/pilotRows";
import { formatWaitAge } from "@/lib/projectRowStatus";
import { pluralize } from "@/lib/pluralize";
import { rowSubject } from "./canopyModel";

/** One run in Canopy's Trash, named and placed as its inbox row was. */
export interface CanopyTrashItem {
  /** The run's id as the panel holds it: in All hosts, keyed by its host. */
  runId: string;
  spawnedAt: number;
  trashedAt: number;
  /** When the trash lets it go; it also names which trash of the run this is. */
  expiresAt: number;
  /** The trash let its process go: Restore resumes its session. */
  ended: boolean;
  /** Ended, and the worktree it ran in is gone: there is nowhere to resume it. */
  worktreeRemoved: boolean;
  subject: string;
  row: PilotAgentRow;
  workspace: { name: string; emoji: string | null; host: string | null };
}

export function canopyTrashDomId(runId: string): string {
  return `canopy-trash-${runId}`;
}

/** The host's trash as rows, in its order: newest first. */
export function buildCanopyTrash(
  entries: readonly CanopyTrashEntry[],
  workspaces: ReadonlyMap<string, PilotWorkspaceMeta>,
  nowMs: number
): CanopyTrashItem[] {
  if (entries.length === 0) return [];
  const rows = new Map<string, { row: PilotAgentRow; workspace: CanopyTrashItem["workspace"] }>();
  for (const group of buildPilotGroups(
    entries.map((entry) => entry.run),
    { workspaces, currentWorkspaceId: null, nowMs }
  )) {
    const workspace = { name: group.name, emoji: group.emoji, host: group.host ?? null };
    for (const row of group.rows) rows.set(row.run.runId, { row, workspace });
  }
  return entries.flatMap((entry) => {
    const built = rows.get(entry.run.runId);
    if (!built) return [];
    return [
      {
        runId: entry.run.runId,
        spawnedAt: entry.run.spawnedAt,
        trashedAt: entry.trashedAt,
        expiresAt: entry.expiresAt,
        ended: entry.ended !== undefined,
        worktreeRemoved: entry.ended?.worktreeRemoved === true,
        subject: rowSubject(built.row, built.workspace.name),
        row: built.row,
        workspace: built.workspace,
      },
    ];
  });
}

/** Whether every word of a search is in one of the names the row goes by. */
export function trashMatches(item: CanopyTrashItem, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = [
    item.subject,
    item.row.title,
    item.row.run.title,
    item.row.run.lastObservedTitle,
    item.row.worktreeLabel,
    item.row.chrome.label,
    item.workspace.name,
    item.workspace.host,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** "Closed 12s ago": to the second while it is new, as the trash keeps it only that long. */
export function closedPhrase(trashedAt: number, nowMs: number): string {
  const seconds = Math.floor(Math.max(0, nowMs - trashedAt) / 1000);
  if (seconds < 1) return "Closed just now";
  if (seconds < 60) return `Closed ${seconds}s ago`;
  return `Closed ${formatWaitAge(trashedAt, nowMs)} ago`;
}

/**
 * A row's aside: when it was closed, and once its process is gone, that it
 * ended, or that its worktree is gone with it.
 */
export function trashAside(
  item: Pick<CanopyTrashItem, "trashedAt" | "ended" | "worktreeRemoved">,
  nowMs: number
): string {
  const closed = closedPhrase(item.trashedAt, nowMs);
  if (item.worktreeRemoved) return `${closed} · Worktree removed`;
  return item.ended ? `${closed} · ended` : closed;
}

/** Said once, politely, when the trash let runs go at their time. */
export function expiredAnnouncement(subjects: readonly string[]): string {
  return subjects.length === 1
    ? `'${subjects[0]}' expired and was removed permanently`
    : `${pluralize(subjects.length, "trashed agent")} expired and were removed permanently`;
}
