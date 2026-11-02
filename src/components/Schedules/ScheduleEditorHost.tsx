import { useLayoutEffect, useRef } from "react";
import { useWallClock } from "@/hooks/useWallClock";
import { isVisibleTabbableElement } from "@/lib/accessibility";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { useFirstAgentOptions } from "@/components/Worktree/hooks/useFirstAgentOptions";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { NEW_SCHEDULE_SELECTOR, scheduleActionSelector } from "./ScheduleList";
import { useScheduleOsJob } from "./useScheduleOsJob";
import { useProjectSchedules } from "./useProjectSchedules";
import { useWorktreeChoices } from "./useWorktreeChoices";

/** Re-read on each minute boundary, so the next runs it previews stay current. */
function untilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

function find(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

const EDITOR_DIALOG_SELECTOR = '[data-testid="schedule-editor-dialog"]';

/**
 * The surface of the topmost dialog other than the editor: Project settings,
 * when the editor's opener went with a page Settings moved away from. Focus
 * left in the app shell would sit behind that modal, out of its reach.
 */
function topmostOtherDialog(): HTMLElement | null {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
  ).filter((dialog) => !dialog.matches(EDITOR_DIALOG_SELECTOR));
  const top = dialogs.at(-1);
  return top?.querySelector<HTMLElement>(':scope > [tabindex="-1"]') ?? top ?? null;
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
  // The project's switches decide whether "Run when Daintree isn't running"
  // counts. Read here, not handed over by the tab, which Settings can unmount
  // under an open editor, and kept current if another window turns them.
  const { state: project } = useProjectSchedules(editor !== null);
  const now = useWallClock(editor?.key ?? 0, untilNextMinute);
  // Where focus goes once the editor closes, when its opener is the wrong place.
  const focusAfterRef = useRef<(() => HTMLElement | null) | null>(null);
  const successorRef = useRef<string | null>(null);
  // What had focus as this opening began, which the editor hands focus back to.
  const openerRef = useRef<HTMLElement | null>(null);
  const openingKey = editor?.key ?? null;
  useLayoutEffect(() => {
    if (openingKey === null) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }, [openingKey]);

  if (!editor) return null;

  const handleSaved = (snapshot: SchedulesSnapshot, scheduleId: string) => {
    answerEditor(snapshot);
    // A new schedule's row is where the user goes next; an edit returns to its opener.
    focusAfterRef.current =
      editor.schedule === null ? () => find(scheduleActionSelector(scheduleId, "edit")) : null;
    closeEditor();
  };

  const handleDeleted = (snapshot: SchedulesSnapshot) => {
    const successor = successorRef.current;
    answerEditor(snapshot);
    focusAfterRef.current = () =>
      successor ? find(scheduleActionSelector(successor, "delete")) : find(NEW_SCHEDULE_SELECTOR);
    closeEditor();
    // Opened from the schedule's history, the tab goes back to the list once the
    // editor has gone, unless an opening already waits to land there instead.
    const { request, landedSeq } = useSchedulesViewStore.getState();
    if (request.seq <= landedSeq) open(null);
  };

  /**
   * A target named for after a save or delete, else the opener, else whatever
   * modal is left. Either can still be in the document but hidden: Settings
   * keeps a page it moved away from mounted under `display: none`.
   */
  const restoreTarget = (): HTMLElement | null => {
    const named = focusAfterRef.current?.();
    if (named && isVisibleTabbableElement(named)) return named;
    const opener = openerRef.current;
    if (opener?.isConnected && isVisibleTabbableElement(opener)) return null;
    return topmostOtherDialog();
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
      projectSwitches={project.snapshot?.switches ?? null}
      restoreFocusTo={restoreTarget}
      onSaved={handleSaved}
      // Read while the row is still on screen: main's push can remove it before the delete answers.
      onDeleting={(id) => {
        successorRef.current = successorRow(id);
      }}
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
