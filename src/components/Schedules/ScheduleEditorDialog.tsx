import { useRef, useState } from "react";
import { AppDialog, type RestoreFocusTarget } from "@/components/ui/AppDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { ProjectScheduleSwitches, Schedule } from "@shared/types/scheduledRuns";
import type { SchedulesSnapshot } from "@shared/types/ipc/schedules";
import type { ScheduleOsJobContext } from "@shared/utils/scheduleOsJob";
import { ScheduleEditor, type EditorLeaveState, type WorktreeChoice } from "./ScheduleEditor";

/** A leave that waits on "Discard changes?", with what the question names. */
interface DiscardPrompt {
  then: () => void;
  isNew: boolean;
  name: string;
  open: boolean;
  /** Confirmed: the leave runs once the confirm has finished closing. */
  accepted: boolean;
}

interface ScheduleEditorDialogProps {
  isOpen: boolean;
  /** Null for a new schedule. Read once per opening: a change pushed meanwhile never reseeds the draft. */
  schedule: Schedule | null;
  /** Rises with each opening, so the next one starts from the saved schedule. */
  openingKey: number;
  defaultAgentId: string;
  worktrees: readonly WorktreeChoice[];
  now: number;
  osJobContext: ScheduleOsJobContext | null;
  /** The project's switches, kept current while editing; null until read. */
  projectSwitches: ProjectScheduleSwitches | null;
  /** Why the project's switches couldn't be read, or null. */
  projectSwitchesError?: string | null;
  /** Where focus goes once the editor has closed instead of its opener; null keeps the opener. */
  restoreFocusTo?: RestoreFocusTarget;
  onSaved: (snapshot: SchedulesSnapshot, scheduleId: string) => void;
  onDeleting?: (scheduleId: string) => void;
  onDeleted: (snapshot: SchedulesSnapshot, deletedId: string) => void;
  onClose: () => void;
  /** Runs once the editor has closed and handed focus back. */
  onCloseComplete?: () => void;
  /** Agent settings, opened once the editor has closed, so they aren't hidden behind it. */
  onOpenAgentSettings: () => void;
}

/**
 * A schedule's editor, opened over Project settings from the Schedules tab as a
 * recipe's editor is from the Recipes tab. Leaving with unsaved edits asks
 * first, however it's left, and a save in flight holds the editor open.
 */
export function ScheduleEditorDialog({
  isOpen,
  schedule,
  openingKey,
  defaultAgentId,
  worktrees,
  now,
  osJobContext,
  projectSwitches,
  projectSwitchesError = null,
  restoreFocusTo,
  onSaved,
  onDeleting,
  onDeleted,
  onClose,
  onCloseComplete,
  onOpenAgentSettings,
}: ScheduleEditorDialogProps) {
  const leaveStateRef = useRef<EditorLeaveState | null>(null);
  const [discardPrompt, setDiscardPrompt] = useState<DiscardPrompt | null>(null);
  // What runs once the editor has gone and handed focus back.
  const afterCloseRef = useRef<(() => void) | null>(null);

  /** A clean editor leaves at once; a dirty one asks; a save in flight holds it. */
  const leave = (then: () => void): boolean => {
    const editor = leaveStateRef.current;
    if (!editor) return true;
    if (editor.saving) return false;
    if (!editor.dirty) return true;
    setDiscardPrompt({ then, isNew: editor.isNew, name: editor.name, open: true, accepted: false });
    return false;
  };

  const close = () => {
    if (leave(onClose)) onClose();
  };

  const openAgentSettings = () => {
    const go = () => {
      afterCloseRef.current = onOpenAgentSettings;
      onClose();
    };
    if (leave(go)) go();
  };

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        onBeforeClose={() => leave(onClose)}
        size="4xl"
        maxHeight="h-[min(48rem,85vh)]"
        restoreFocusTo={restoreFocusTo}
        // A target is named only when the opener is the wrong place to land:
        // the row a new schedule made, or the one taking a deleted one's place.
        preferRestoreFocusTo
        onCloseComplete={() => {
          const then = afterCloseRef.current;
          afterCloseRef.current = null;
          onCloseComplete?.();
          then?.();
        }}
        data-testid="schedule-editor-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title>{schedule ? "Edit schedule" : "New schedule"}</AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <ScheduleEditor
          key={openingKey}
          schedule={schedule}
          defaultAgentId={defaultAgentId}
          worktrees={worktrees}
          now={now}
          osJobContext={osJobContext}
          projectSwitches={projectSwitches}
          projectSwitchesError={projectSwitchesError}
          leaveStateRef={leaveStateRef}
          onSaved={onSaved}
          onDeleting={onDeleting}
          onDeleted={onDeleted}
          onCancel={close}
          onOpenAgentSettings={openAgentSettings}
        />
      </AppDialog>

      <ConfirmDialog
        isOpen={discardPrompt?.open ?? false}
        variant="destructive"
        zIndex="nested"
        title={
          discardPrompt?.isNew
            ? "Discard this new schedule?"
            : `Discard changes to '${discardPrompt?.name ?? ""}'?`
        }
        description={
          discardPrompt?.isNew
            ? "It hasn't been created, so nothing will run."
            : "Your edits aren't saved. The saved schedule is unchanged."
        }
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onConfirm={() =>
          setDiscardPrompt((prev) => prev && { ...prev, open: false, accepted: true })
        }
        onClose={() => setDiscardPrompt((prev) => prev && { ...prev, open: false })}
        // The leave runs once the confirm has handed focus back, so its restore
        // can't land after the editor has closed and returned focus to its row.
        onCloseComplete={() => {
          const done = discardPrompt;
          setDiscardPrompt(null);
          if (done?.accepted) done.then();
        }}
      />
    </>
  );
}
