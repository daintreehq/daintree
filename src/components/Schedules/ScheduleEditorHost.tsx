import { useRef } from "react";
import { useWallClock } from "@/hooks/useWallClock";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { useFirstAgentOptions } from "@/components/Worktree/hooks/useFirstAgentOptions";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { NEW_SCHEDULE_SELECTOR, scheduleActionSelector } from "./ScheduleList";
import { useScheduleOsJob } from "./useScheduleOsJob";
import { useWorktreeChoices } from "./useWorktreeChoices";

/** Re-read on each minute boundary, so the next runs it previews stay current. */
function untilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

/** The row that slides into a deleted one's place, or the one above it, read before it goes. */
function successorRow(deletedId: string): string | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-schedule-id]")).map(
    (row) => row.dataset.scheduleId
  );
  const index = rows.indexOf(deletedId);
  if (index === -1) return null;
  return rows[index + 1] ?? rows[index - 1] ?? null;
}

/**
 * The schedule editor that Project settings → Schedules opens. It lives with
 * the project's other dialogs rather than in the tab, which Settings unmounts
 * whenever it changes scope (Cmd+, among others), so a draft is only ever
 * dropped by the editor's own guarded ways out.
 */
export function ScheduleEditorHost() {
  const editor = useSchedulesViewStore((s) => s.editor);
  const closeEditor = useSchedulesViewStore((s) => s.closeEditor);
  const clearEditor = useSchedulesViewStore((s) => s.clearEditor);
  const answerEditor = useSchedulesViewStore((s) => s.answerEditor);
  const open = useSchedulesViewStore((s) => s.open);
  const { choices } = useWorktreeChoices();
  const agents = useFirstAgentOptions();
  const osJob = useScheduleOsJob(editor !== null, editor?.key ?? null);
  const now = useWallClock(editor?.key ?? 0, untilNextMinute);
  // Where focus goes once the editor closes, when its opener is the wrong place.
  const focusAfterRef = useRef<(() => HTMLElement | null) | null>(null);

  if (!editor) return null;

  const handleSaved = (snapshot: SchedulesSnapshot, scheduleId: string) => {
    answerEditor(snapshot);
    // A new schedule's row is where the user goes next; an edit returns to its opener.
    focusAfterRef.current =
      editor.schedule === null ? () => find(scheduleActionSelector(scheduleId, "edit")) : null;
    closeEditor();
  };

  const handleDeleted = (snapshot: SchedulesSnapshot, deletedId: string) => {
    const successor = successorRow(deletedId);
    answerEditor(snapshot);
    focusAfterRef.current = () =>
      successor ? find(scheduleActionSelector(successor, "delete")) : find(NEW_SCHEDULE_SELECTOR);
    closeEditor();
    // Opened from the schedule's history, the tab goes back to the list once the editor has gone.
    open(null);
  };

  return (
    <ScheduleEditorDialog
      isOpen={editor.open}
      schedule={editor.schedule}
      openingKey={editor.key}
      defaultAgentId={editor.schedule?.launch.agentId ?? agents[0]?.id ?? ""}
      worktrees={choices}
      now={now}
      osJobContext={osJob.status?.context ?? null}
      restoreFocusTo={() => focusAfterRef.current?.() ?? null}
      onSaved={handleSaved}
      onDeleted={handleDeleted}
      onClose={closeEditor}
      onCloseComplete={clearEditor}
      onOpenAgentSettings={() =>
        window.dispatchEvent(
          new CustomEvent("daintree:open-settings-tab", { detail: { tab: "agents" } })
        )
      }
    />
  );
}
