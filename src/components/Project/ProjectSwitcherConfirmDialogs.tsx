import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useScratchDeletionProgress } from "@/hooks/useScratchDeletionProgress";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import type {
  DeleteAllScratchesSnapshot,
  DeleteScratchTarget,
  SearchableProject,
  SearchableScratch,
  UseProjectSwitcherPaletteReturn,
} from "@/hooks/useProjectSwitcherPalette";
import { Callout } from "@/components/ui/Callout";
import { pluralize } from "@/lib/pluralize";
import { PathSegments } from "@/components/ui/PathSegments";

/**
 * The confirmations the palette stacks above itself. Each one is state its
 * owner froze when the confirm opened, so the copy keeps naming what the user
 * agreed to while the live list underneath changes.
 */
export interface ProjectSwitcherConfirmState {
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
  /** Frozen snapshot of the project pending a Sleep confirm, or null. */
  sleepConfirmProject?: SearchableProject | null;
  onSleepConfirmClose?: () => void;
  onConfirmSleep?: () => void;
  isSleepingProject?: boolean;
  /**
   * Target of a pending single-scratch delete confirmation, frozen when it
   * opened. Surfaced as a top-level ConfirmDialog above the palette.
   */
  deleteScratchConfirm?: DeleteScratchTarget | null;
  onDismissDeleteScratchConfirm?: () => void;
  onConfirmDeleteScratch?: () => void;
  isDeletingScratch?: boolean;
  /**
   * Targets of a pending bulk-delete confirmation, frozen when it opened.
   * Surfaced as a top-level ConfirmDialog above the palette.
   */
  deleteAllScratchesConfirm?: DeleteAllScratchesSnapshot | null;
  onDismissDeleteAllScratchesConfirm?: () => void;
  onConfirmDeleteAllScratches?: () => void;
  isDeletingAllScratches?: boolean;
  /**
   * "Open project?" follow-up after a successful Save-as-Project copy.
   * Surfaced as a top-level ConfirmDialog above the palette.
   */
  saveAsProjectConfirm?: {
    scratch: Pick<SearchableScratch, "name">;
    project: { name: string; path: string };
  } | null;
  onDismissSaveAsProjectConfirm?: () => void;
  onOpenSavedProject?: () => void;
}

/**
 * Single-scratch delete confirmation (#11522).
 *
 * Its own component so the progress clocks mount and unmount with the dialog —
 * the palette body would otherwise carry timers outliving every confirm it ever
 * opened.
 */
function DeleteScratchConfirmDialog({
  target,
  onDismiss,
  onConfirm,
  isDeleting,
  restoreFocusTo,
}: {
  target: DeleteScratchTarget;
  onDismiss: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  restoreFocusTo: React.RefObject<HTMLElement | null>;
}) {
  const progress = useScratchDeletionProgress(isDeleting);
  const remoteHostName = useRemoteHostName();

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={onDismiss}
      title={`Delete '${target.name}'?`}
      zIndex="nested"
      confirmLabel="Delete scratch"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      // Split on purpose: the dialog locks the instant Delete is pressed, but
      // the spinner waits out the Doherty gate, so a scratch that deletes in
      // 80ms never flashes one. Gating the lock too would leave a window where
      // a second press, or a dismissal, still went through.
      isBusy={isDeleting}
      isConfirmLoading={isDeleting && progress.isVisible}
      variant="destructive"
      // The row that opened this is gone by the time it closes, so the default
      // restore walks to the first tabbable node under #root — app chrome behind
      // a palette that is still `aria-modal`. Hand focus back to the search box
      // instead, which survives the delete and keeps it inside the palette.
      restoreFocusTo={restoreFocusTo}
    >
      <div className="space-y-3">
        <div className="text-sm text-text-secondary">
          {`Its terminals will be closed and its folder deleted from ${remoteHostName ?? "disk"}.`}
        </div>
        <div className="text-xs text-text-secondary font-mono">
          <PathSegments path={target.path} />
        </div>
        {/*
         * Raw `isDeleting` decides whether the live region exists; the Doherty
         * gate only decides whether it has anything to say, so a scratch that
         * deletes inside the gate never flashes it (lesson #10083). The region
         * stays mounted for the whole run so the long-wait line is an update to
         * one announcer rather than a second one.
         */}
        {isDeleting && (
          <div
            role="status"
            className="min-h-4 text-xs text-text-secondary"
            data-testid="delete-scratch-progress"
          >
            {progress.isVisible && (
              <>
                {/*
                 * Names the operation, not a step. Main tears the terminals down
                 * FIRST and only reaches the folder if that confirms — so a line
                 * claiming both would be asserting file deletion during a
                 * teardown that may yet fail and delete nothing. The steps are
                 * named in the consequence copy above, where they are a statement
                 * of intent rather than a claim about what is happening now.
                 */}
                Deleting scratch…
                {progress.isStillWorking && (
                  <span className="block text-text-secondary">Still working…</span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

export function ProjectSwitcherConfirmDialogs({
  removeConfirmProject,
  onRemoveConfirmClose,
  onConfirmRemove,
  isRemovingProject = false,
  sleepConfirmProject,
  onSleepConfirmClose,
  onConfirmSleep,
  isSleepingProject = false,
  deleteScratchConfirm,
  onDismissDeleteScratchConfirm,
  onConfirmDeleteScratch,
  isDeletingScratch = false,
  deleteAllScratchesConfirm,
  onDismissDeleteAllScratchesConfirm,
  onConfirmDeleteAllScratches,
  isDeletingAllScratches = false,
  saveAsProjectConfirm,
  onDismissSaveAsProjectConfirm,
  onOpenSavedProject,
  paletteInputRef,
}: ProjectSwitcherConfirmState & {
  /** The search box, which outlives every row a confirm can remove. */
  paletteInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  // Scratch folders live on the window's host; locally the copy says "disk" as it always has.
  const scratchFolderHome = useRemoteHostName() ?? "disk";

  const hasRunningProcesses = removeConfirmProject
    ? removeConfirmProject.processCount > 0 ||
      removeConfirmProject.activeAgentCount > 0 ||
      removeConfirmProject.waitingAgentCount > 0
    : false;

  return (
    <>
      {removeConfirmProject && onRemoveConfirmClose && onConfirmRemove && (
        <ConfirmDialog
          isOpen={true}
          onClose={onRemoveConfirmClose}
          title={
            removeConfirmProject.isActive
              ? `Close '${removeConfirmProject.name}'?`
              : `Remove '${removeConfirmProject.name}'?`
          }
          zIndex="nested"
          confirmLabel={removeConfirmProject.isActive ? "Close project" : "Remove project"}
          cancelLabel="Cancel"
          onConfirm={onConfirmRemove}
          isConfirmLoading={isRemovingProject}
          variant="destructive"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{removeConfirmProject.name}</div>
              <div className="text-xs text-text-secondary font-mono mt-1">
                {removeConfirmProject.path}
              </div>
            </div>
            {removeConfirmProject.isActive
              ? hasRunningProcesses && (
                  <Callout severity="warning" title="All running processes will be terminated">
                    <div>
                      {removeConfirmProject.processCount > 0 && (
                        <div>
                          •{" "}
                          {pluralize(
                            removeConfirmProject.processCount,
                            "running process",
                            "running processes"
                          )}
                        </div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>
                          • {pluralize(removeConfirmProject.activeAgentCount, "active agent")}
                        </div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>
                          • {pluralize(removeConfirmProject.waitingAgentCount, "waiting agent")}
                        </div>
                      )}
                    </div>
                  </Callout>
                )
              : hasRunningProcesses && (
                  <Callout severity="warning" title="Running terminals detected">
                    <div>
                      {removeConfirmProject.processCount > 0 && (
                        <div>
                          •{" "}
                          {pluralize(
                            removeConfirmProject.processCount,
                            "running process",
                            "running processes"
                          )}
                        </div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>
                          • {pluralize(removeConfirmProject.activeAgentCount, "active agent")}
                        </div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>
                          • {pluralize(removeConfirmProject.waitingAgentCount, "waiting agent")}
                        </div>
                      )}
                    </div>
                  </Callout>
                )}
            <div className="text-xs text-text-secondary">
              {removeConfirmProject.isActive
                ? "The project will remain in your list and can be reopened at any time."
                : `Removing it deletes this project's saved settings, recipes stored outside the repository, schedules and layout, and ends any running terminals and processes. Opening the folder again starts the project fresh. ${
                    removeConfirmProject.cloneState === "cloning"
                      ? "Its clone is still running: removing it cancels the clone and discards the partly cloned folder."
                      : "The folder itself isn't touched, and recipes kept in the repository under .daintree/recipes/ stay."
                  }`}
            </div>
          </div>
        </ConfirmDialog>
      )}
      {sleepConfirmProject && onSleepConfirmClose && onConfirmSleep && (
        <ConfirmDialog
          isOpen={true}
          onClose={onSleepConfirmClose}
          title={`Sleep '${sleepConfirmProject.name}'?`}
          zIndex="nested"
          confirmLabel="Sleep project"
          cancelLabel="Cancel"
          onConfirm={onConfirmSleep}
          isConfirmLoading={isSleepingProject}
          variant="default"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{sleepConfirmProject.name}</div>
              <div className="text-xs text-text-secondary font-mono mt-1">
                {sleepConfirmProject.path}
              </div>
            </div>
            {(sleepConfirmProject.processCount > 0 ||
              sleepConfirmProject.activeAgentCount > 0 ||
              sleepConfirmProject.waitingAgentCount > 0) && (
              <Callout severity="warning" title="Running processes will be stopped">
                <div>
                  {sleepConfirmProject.processCount > 0 && (
                    <div>
                      •{" "}
                      {pluralize(
                        sleepConfirmProject.processCount,
                        "running process",
                        "running processes"
                      )}
                    </div>
                  )}
                  {sleepConfirmProject.activeAgentCount > 0 && (
                    <div>• {pluralize(sleepConfirmProject.activeAgentCount, "active agent")}</div>
                  )}
                  {sleepConfirmProject.waitingAgentCount > 0 && (
                    <div>• {pluralize(sleepConfirmProject.waitingAgentCount, "waiting agent")}</div>
                  )}
                </div>
              </Callout>
            )}
            {sleepConfirmProject.isActive && (
              <div className="text-xs text-text-secondary">
                This window returns to the project picker
              </div>
            )}
            <div className="text-xs text-text-secondary">
              The layout, terminal scrollback, and agent sessions come back when you reopen the
              project.
            </div>
          </div>
        </ConfirmDialog>
      )}
      {deleteScratchConfirm && onDismissDeleteScratchConfirm && onConfirmDeleteScratch && (
        <DeleteScratchConfirmDialog
          target={deleteScratchConfirm}
          restoreFocusTo={paletteInputRef}
          onDismiss={onDismissDeleteScratchConfirm}
          onConfirm={onConfirmDeleteScratch}
          isDeleting={isDeletingScratch}
        />
      )}
      {deleteAllScratchesConfirm &&
        onDismissDeleteAllScratchesConfirm &&
        onConfirmDeleteAllScratches && (
          <ConfirmDialog
            isOpen={true}
            onClose={onDismissDeleteAllScratchesConfirm}
            // Counted off the frozen snapshot, never the live list: the rows
            // disappear as the run lands, and the dialog must keep naming the
            // number the user actually agreed to.
            title={
              deleteAllScratchesConfirm.length === 1
                ? "Delete 1 scratch workspace?"
                : `Delete ${deleteAllScratchesConfirm.length} scratch workspaces?`
            }
            zIndex="nested"
            confirmLabel="Delete scratch workspaces"
            cancelLabel="Cancel"
            onConfirm={onConfirmDeleteAllScratches}
            isConfirmLoading={isDeletingAllScratches}
            variant="destructive"
            // The list below scrolls, so the role has to drop from `alertdialog`
            // to `dialog` — a reader would otherwise flatten every name into a
            // single utterance on open.
            hasPreview={true}
            // Only consulted when the element that opened this has disconnected,
            // which the context menu's item does as soon as the run empties the
            // list (the visible button added in #11705 survives a cancel, and
            // keeps focus itself). Without a named successor that case walks to
            // app chrome behind a still-`aria-modal` palette, so name the search
            // box, which outlives the delete.
            restoreFocusTo={paletteInputRef}
          >
            <div className="space-y-3">
              <div className="text-sm text-text-secondary">
                {deleteAllScratchesConfirm.length === 1
                  ? `Its terminals will be closed and its folder deleted from ${scratchFolderHome}.`
                  : `Their terminals will be closed and their folders deleted from ${scratchFolderHome}.`}
              </div>
              {/*
               * Named, not just counted: the action is one click from "New
               * scratch workspace" now, so the dialog is what stands between a
               * misclick and folders leaving disk. Every target is rendered —
               * only the viewport is capped — because a "+N more" tail would
               * reintroduce the count-only problem for the hidden ones. Keyed by
               * id so two scratches sharing a name stay separate rows.
               */}
              <div className="max-h-40 overflow-y-auto" data-testid="scratch-delete-all-preview">
                <ul
                  className="space-y-0.5 text-xs text-text-secondary"
                  aria-label="Scratch workspaces to delete"
                >
                  {/*
                   * Wrapped rather than truncated: this list is what the user
                   * consents against, and two long names sharing a prefix would
                   * clip to the same string. Chromium keeps the overflowing
                   * container keyboard-reachable on its own, and skips it when
                   * the names happen to fit.
                   */}
                  {deleteAllScratchesConfirm.map((target) => (
                    <li key={target.id} className="break-words">
                      {target.name}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </ConfirmDialog>
        )}
      {/*
       * Never an offer to delete the scratch (#15004). The save is a copy, and
       * the scratch's terminals and agents keep working in the original folder,
       * so whatever they change after it exists only there. Its row's own
       * Delete stays the way to remove it, with the consequence spelled out.
       */}
      {saveAsProjectConfirm && onDismissSaveAsProjectConfirm && onOpenSavedProject && (
        <ConfirmDialog
          isOpen={true}
          onClose={onDismissSaveAsProjectConfirm}
          title={`Open '${saveAsProjectConfirm.project.name}'?`}
          zIndex="nested"
          confirmLabel="Open project"
          cancelLabel="Not now"
          onConfirm={onOpenSavedProject}
          variant="default"
          restoreFocusTo={paletteInputRef}
        >
          <div className="space-y-3">
            <div className="text-sm">
              The project is a copy of{" "}
              <span className="font-medium">{saveAsProjectConfirm.scratch.name}</span> as it was
              when you saved it.
            </div>
            <div className="text-xs text-text-secondary font-mono">
              <PathSegments path={saveAsProjectConfirm.project.path} />
            </div>
            <div className="text-sm text-text-secondary">
              The scratch is kept. Anything its terminals or agents change from now on stays there,
              not in the project.
            </div>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

export type ProjectSwitcherConfirmSource = Pick<
  UseProjectSwitcherPaletteReturn,
  | "removeConfirmProject"
  | "setRemoveConfirmProject"
  | "confirmRemoveProject"
  | "isRemovingProject"
  | "sleepConfirmProject"
  | "setSleepConfirmProject"
  | "confirmSleep"
  | "isSleepingProject"
  | "deleteScratchConfirm"
  | "dismissDeleteScratchConfirm"
  | "confirmDeleteScratch"
  | "isDeletingScratch"
  | "deleteAllScratchesConfirm"
  | "dismissDeleteAllScratchesConfirm"
  | "confirmDeleteAllScratches"
  | "isDeletingAllScratches"
  | "saveAsProjectConfirm"
  | "dismissSaveAsProjectConfirm"
  | "openSavedProject"
>;

/**
 * The one place a view renders the switcher's confirmations (#16919). The
 * switcher is drawn by the ⌘P modal and the toolbar dropdown, and Close is also
 * requested from the action palette and the toolbar pill with neither open, so
 * the confirms can't live in a copy of the switcher: before any copy had
 * mounted they rendered nowhere, and once both had they rendered twice.
 */
export function ProjectSwitcherConfirmHost({
  projectSwitcher,
  paletteInputRef,
}: {
  projectSwitcher: ProjectSwitcherConfirmSource;
  /** The ⌘P palette's search box, a focus successor while the palette is open. */
  paletteInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <ProjectSwitcherConfirmDialogs
      removeConfirmProject={projectSwitcher.removeConfirmProject}
      onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
      onConfirmRemove={() => void projectSwitcher.confirmRemoveProject()}
      isRemovingProject={projectSwitcher.isRemovingProject}
      sleepConfirmProject={projectSwitcher.sleepConfirmProject}
      onSleepConfirmClose={() => projectSwitcher.setSleepConfirmProject(null)}
      onConfirmSleep={() => void projectSwitcher.confirmSleep()}
      isSleepingProject={projectSwitcher.isSleepingProject}
      deleteScratchConfirm={projectSwitcher.deleteScratchConfirm}
      onDismissDeleteScratchConfirm={projectSwitcher.dismissDeleteScratchConfirm}
      onConfirmDeleteScratch={() => void projectSwitcher.confirmDeleteScratch()}
      isDeletingScratch={projectSwitcher.isDeletingScratch}
      deleteAllScratchesConfirm={projectSwitcher.deleteAllScratchesConfirm}
      onDismissDeleteAllScratchesConfirm={projectSwitcher.dismissDeleteAllScratchesConfirm}
      onConfirmDeleteAllScratches={() => void projectSwitcher.confirmDeleteAllScratches()}
      isDeletingAllScratches={projectSwitcher.isDeletingAllScratches}
      saveAsProjectConfirm={projectSwitcher.saveAsProjectConfirm}
      onDismissSaveAsProjectConfirm={projectSwitcher.dismissSaveAsProjectConfirm}
      onOpenSavedProject={projectSwitcher.openSavedProject}
      paletteInputRef={paletteInputRef}
    />
  );
}
