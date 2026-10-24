import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { notify } from "@/lib/notify";
import { closeAndAnnounce } from "@/lib/accessibility";
import { logError } from "@/utils/logger";
import { scratchClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Project, Scratch } from "@shared/types";
import type {
  DeleteAllScratchesSnapshot,
  DeleteScratchTarget,
  SearchableScratch,
  UseProjectSwitcherPaletteReturn,
} from "./types";

export type ProjectSwitcherScratchMutations = Pick<
  UseProjectSwitcherPaletteReturn,
  | "createScratch"
  | "deleteScratchConfirm"
  | "requestDeleteScratch"
  | "dismissDeleteScratchConfirm"
  | "confirmDeleteScratch"
  | "isDeletingScratch"
  | "deleteAllScratchesConfirm"
  | "requestDeleteAllScratches"
  | "dismissDeleteAllScratchesConfirm"
  | "confirmDeleteAllScratches"
  | "isDeletingAllScratches"
  | "renameScratch"
  | "saveAsProject"
  | "saveAsProjectConfirm"
  | "dismissSaveAsProjectConfirm"
  | "confirmDeleteOriginalScratch"
  | "isDeletingOriginalScratch"
>;

export interface UseProjectSwitcherScratchMutationsOptions {
  /** Closes the palette; creating a scratch switches to it, so it runs first. */
  close: () => void;
  /** The scratch store's list, which decides whether a confirm's target is gone. */
  scratches: Scratch[];
  /** The rows the confirms are opened from. */
  scratchResults: SearchableScratch[];
}

/**
 * The scratch actions and their confirmations: create, rename, delete one,
 * delete all, and save as project.
 */
export function useProjectSwitcherScratchMutations({
  close,
  scratches,
  scratchResults,
}: UseProjectSwitcherScratchMutationsOptions): ProjectSwitcherScratchMutations {
  const [saveAsProjectConfirm, setSaveAsProjectConfirm] = useState<{
    scratch: SearchableScratch;
    project: Project;
  } | null>(null);
  const [isDeletingOriginalScratch, setIsDeletingOriginalScratch] = useState(false);
  const [deleteAllScratchesConfirm, setDeleteAllScratchesConfirm] =
    useState<DeleteAllScratchesSnapshot | null>(null);
  const [isDeletingAllScratches, setIsDeletingAllScratches] = useState(false);
  // Rapid double-Enter on the confirm button lands twice before React re-renders
  // the disabled state, so the gate has to be synchronous (lesson #4024).
  const isDeletingAllScratchesRef = useRef(false);
  const [deleteScratchConfirm, setDeleteScratchConfirm] = useState<DeleteScratchTarget | null>(
    null
  );
  const [isDeletingScratch, setIsDeletingScratch] = useState(false);
  const isDeletingScratchRef = useRef(false);

  const loadProjects = useProjectStore((state) => state.loadProjects);
  const createScratchAction = useScratchStore((state) => state.createScratch);
  const switchScratchAction = useScratchStore((state) => state.switchScratch);
  const removeScratchActionStore = useScratchStore((state) => state.removeScratch);
  const renameScratchActionStore = useScratchStore((state) => state.renameScratch);

  const createScratch = useCallback(
    async (name?: string) => {
      close();
      // An empty name is forwarded as undefined so main applies its own
      // `defaultScratchName` — same behavior as before the naming affordance.
      const requestedName = name?.trim() ? name.trim() : undefined;
      // Resume at the step that failed. Retrying the whole thing after the
      // scratch already exists would create a second one and orphan its folder.
      let createdId: string | null = null;
      const run = async () => {
        if (!createdId) {
          createdId = (await createScratchAction(requestedName)).id;
        }
        await switchScratchAction(createdId);
      };
      const fail = (error: unknown, retry: () => Promise<void>) => {
        const created = createdId !== null;
        notify({
          type: "error",
          title: created ? "Couldn't open scratch" : "Couldn't create scratch",
          message: formatErrorMessage(
            error,
            created
              ? "Created the scratch workspace but couldn't switch to it"
              : "Couldn't create scratch workspace"
          ),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          context: { eventKind: "recovery" },
        });
      };
      try {
        await run();
      } catch (error) {
        const retry = async () => {
          try {
            await run();
          } catch (retryError) {
            fail(retryError, retry);
          }
        };
        fail(error, retry);
      }
    },
    [close, createScratchAction, switchScratchAction]
  );

  const renameScratch = useCallback(
    async (scratchId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const rename = async () => {
        await renameScratchActionStore(scratchId, trimmed);
      };
      try {
        await rename();
      } catch (error) {
        const retry = async () => {
          try {
            await rename();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't rename scratch",
              message: formatErrorMessage(retryError, "Couldn't rename scratch workspace"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
              context: { eventKind: "recovery" },
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't rename scratch",
          message: formatErrorMessage(error, "Couldn't rename scratch workspace"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          // Not `uiFeedback`: its passive policy routes to the inbox, where this
          // closure-backed "Try again" can never be clicked.
          context: { eventKind: "recovery" },
        });
      }
    },
    [renameScratchActionStore]
  );

  const requestDeleteScratch = useCallback(
    (scratchId: string) => {
      if (isDeletingScratchRef.current || deleteScratchConfirm) return;
      const target = scratchResults.find((scratch) => scratch.id === scratchId);
      // No fallback target: a miss means the row went away between the menu
      // opening and the choice landing, and guessing which scratch the user
      // meant is exactly the silent default a destructive path must not have.
      if (!target) return;
      setDeleteScratchConfirm({ id: target.id, name: target.name, path: target.path });
    },
    [scratchResults, deleteScratchConfirm]
  );

  const dismissDeleteScratchConfirm = useCallback(() => {
    if (isDeletingScratchRef.current) return;
    setDeleteScratchConfirm(null);
  }, []);

  // A `scratch:removed` push from another window can retire the target under an
  // open dialog. Skipped while our own run is in flight, or the removal we just
  // performed would tear the dialog down before the outcome is announced.
  //
  // Gated on the STATE, not the ref that guards re-entrancy: a ref settling in
  // `finally` re-runs nothing. Another window deleting the target mid-run would
  // then be consumed by a skipped pass, and if our own call went on to reject —
  // which leaves the dialog open as its own retry surface — nothing would ever
  // reconcile it, stranding a dialog that retries a scratch already gone.
  useEffect(() => {
    if (!deleteScratchConfirm || isDeletingScratch) return;
    if (scratches.some((scratch: Scratch) => scratch.id === deleteScratchConfirm.id)) return;
    setDeleteScratchConfirm(null);
  }, [deleteScratchConfirm, scratches, isDeletingScratch]);

  const confirmDeleteScratch = useCallback(async () => {
    if (isDeletingScratchRef.current) return;
    const target = deleteScratchConfirm;
    if (!target) return;

    isDeletingScratchRef.current = true;
    setIsDeletingScratch(true);

    try {
      await removeScratchActionStore(target.id);
      const title = `Deleted '${target.name}'`;
      // Close before announcing: VoiceOver drops live-region updates raised from
      // outside a focused `aria-modal` subtree (lesson #9434).
      closeAndAnnounce(() => setDeleteScratchConfirm(null), title);
      // Reports the terminals, not the folder: main tombstones the row and then
      // treats `fs.rm` as best-effort, so a resolved call proves the workspace is
      // gone from the app, not that the directory is gone from disk.
      //
      // A focused-window receipt, deliberately best-effort: the row leaving is
      // only visible if the palette is still open on it, so a toast is worth
      // raising, but a deletion that lands while the window is blurred is dropped
      // rather than filed. `transient` is what drops it, and it stays because a
      // routine delete is not inbox-worthy — `closeAndAnnounce` above is the
      // guaranteed signal. No `context` for the same reason: suppression needs an
      // inbox entry to fall back to, and a transient payload has none.
      // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
      notify({
        type: "success",
        title,
        message: "Its terminals were closed.",
        transient: true,
        priority: "high",
      });
    } catch (error) {
      // Another window may have deleted this scratch while our own call was in
      // flight, which is how ours came to fail. The user asked for it gone and it
      // is gone, so reconcile instead of reporting a failure — and close, because
      // the error copy below leans on the dialog surviving as its retry surface,
      // which the stale-target effect is about to take away.
      const isAlreadyGone = !useScratchStore
        .getState()
        .scratches.some((scratch: Scratch) => scratch.id === target.id);
      if (isAlreadyGone) {
        closeAndAnnounce(() => setDeleteScratchConfirm(null), `Deleted '${target.name}'`);
        return;
      }
      // The dialog stays open and its button re-arms: that button is the retry
      // surface, so the toast needs no action of its own.
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't delete scratch",
        message: formatErrorMessage(error, "Couldn't remove scratch workspace"),
      });
    } finally {
      isDeletingScratchRef.current = false;
      setIsDeletingScratch(false);
    }
  }, [deleteScratchConfirm, removeScratchActionStore]);

  const requestDeleteAllScratches = useCallback(() => {
    if (isDeletingAllScratchesRef.current || deleteAllScratchesConfirm) return;
    if (scratchResults.length === 0) return;
    setDeleteAllScratchesConfirm(
      scratchResults.map((scratch) => ({ id: scratch.id, name: scratch.name }))
    );
  }, [scratchResults, deleteAllScratchesConfirm]);

  const dismissDeleteAllScratchesConfirm = useCallback(() => {
    if (isDeletingAllScratchesRef.current) return;
    setDeleteAllScratchesConfirm(null);
  }, []);

  // A `scratch:removed` push from another window can empty the list under an open
  // dialog. Drop it only once every target is gone — a partially-stale snapshot
  // still has work to do, and shrinking it here would rewrite the count the user
  // already read. Skipped while our own run is in flight, or the last successful
  // removal would tear the dialog down before the summary lands.
  useEffect(() => {
    if (!deleteAllScratchesConfirm || isDeletingAllScratchesRef.current) return;
    const liveIds = new Set(scratches.map((scratch: Scratch) => scratch.id));
    if (deleteAllScratchesConfirm.some((target) => liveIds.has(target.id))) return;
    setDeleteAllScratchesConfirm(null);
  }, [deleteAllScratchesConfirm, scratches]);

  const confirmDeleteAllScratches = useCallback(async () => {
    if (isDeletingAllScratchesRef.current) return;
    const targets = deleteAllScratchesConfirm;
    if (!targets || targets.length === 0) {
      setDeleteAllScratchesConfirm(null);
      return;
    }

    isDeletingAllScratchesRef.current = true;
    setIsDeletingAllScratches(true);

    const total = targets.length;
    const noun = total === 1 ? "scratch workspace" : "scratch workspaces";

    try {
      // Fanned out rather than awaited in sequence: `scratch:remove` has no rate
      // limiter and each scratch owns a disjoint folder, so there is nothing to
      // serialize. `allSettled` also guarantees one bad target can't strand the rest.
      const settled = await Promise.allSettled(
        targets.map((target) => removeScratchActionStore(target.id))
      );

      const failures: { name: string; reason: string }[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status !== "rejected") return;
        const target = targets[index]!;
        failures.push({
          name: target.name,
          reason: formatErrorMessage(outcome.reason, "Deletion failed"),
        });
        logError(`[ProjectSwitcher] Failed to delete scratch ${target.id}`, outcome.reason);
      });

      const successCount = total - failures.length;
      const firstFailure = failures[0];

      // Close before announcing: VoiceOver drops live-region updates raised from
      // outside a focused `aria-modal` subtree (lesson #9434).
      const close = () => setDeleteAllScratchesConfirm(null);

      if (failures.length === 0) {
        const title = `Deleted ${total} ${noun}`;
        closeAndAnnounce(close, title);
        // Reports the terminals, not the folders: main tombstones the row and then
        // treats `fs.rm` as best-effort, swallowing a failure and leaving cleanup to
        // a later sweep (`ScratchStore.removeScratch`). A resolved call therefore
        // proves the workspace is gone from the app, not that the directory is gone
        // from disk — claiming the latter would be a lie on a locked folder.
        //
        // Transient: the section emptying in front of the user is the real
        // confirmation — this is a one-shot receipt, not an inbox entry.
        notify({
          type: "success",
          title,
          message: total === 1 ? "Its terminals were closed." : "Their terminals were closed.",
          transient: true,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
      } else if (successCount === 0) {
        const title = total === 1 ? "Couldn't delete scratch" : "Couldn't delete scratches";
        closeAndAnnounce(close, title, "assertive");
        // No recovery action: the scratch rows survived the failure and are
        // themselves the retry surface.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title,
          message: firstFailure
            ? `${firstFailure.name}: ${firstFailure.reason}`
            : `All ${total} deletions failed.`,
        });
      } else {
        const title = `Deleted ${successCount} of ${total} ${noun}`;
        closeAndAnnounce(close, title);
        // `priority` is set explicitly: `uiFeedback`'s passive policy would otherwise
        // route this to the inbox, and a partial failure is precisely the outcome the
        // user has to see — the survivors are still sitting in the list.
        notify({
          type: "warning",
          title,
          message:
            failures.length === 1 && firstFailure
              ? `${firstFailure.name} failed: ${firstFailure.reason}`
              : `${failures.length} couldn't be deleted.`,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
      }
    } finally {
      isDeletingAllScratchesRef.current = false;
      setIsDeletingAllScratches(false);
    }
  }, [deleteAllScratchesConfirm, removeScratchActionStore]);

  const saveAsProject = useCallback(
    async (scratchId: string) => {
      const scratch = scratchResults.find((s) => s.id === scratchId);
      if (!scratch) return;
      try {
        const result = await scratchClient.saveAsProject(scratchId);
        if (result.status === "cancelled") return;
        await loadProjects();
        setSaveAsProjectConfirm({ scratch, project: result.project });
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't save scratch as project",
          message: formatErrorMessage(error, "Couldn't save scratch as project"),
        });
      }
    },
    [scratchResults, loadProjects]
  );

  const dismissSaveAsProjectConfirm = useCallback(() => {
    setSaveAsProjectConfirm(null);
  }, []);

  const confirmDeleteOriginalScratch = useCallback(async () => {
    if (!saveAsProjectConfirm || isDeletingOriginalScratch) return;
    setIsDeletingOriginalScratch(true);
    const scratchId = saveAsProjectConfirm.scratch.id;
    try {
      await removeScratchActionStore(scratchId);
      setSaveAsProjectConfirm(null);
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't remove original scratch",
        message: formatErrorMessage(error, "Couldn't remove the original scratch workspace"),
      });
    } finally {
      setIsDeletingOriginalScratch(false);
    }
  }, [saveAsProjectConfirm, isDeletingOriginalScratch, removeScratchActionStore]);

  return {
    createScratch,
    deleteScratchConfirm,
    requestDeleteScratch,
    dismissDeleteScratchConfirm,
    confirmDeleteScratch,
    isDeletingScratch,
    deleteAllScratchesConfirm,
    requestDeleteAllScratches,
    dismissDeleteAllScratchesConfirm,
    confirmDeleteAllScratches,
    isDeletingAllScratches,
    renameScratch,
    saveAsProject,
    saveAsProjectConfirm,
    dismissSaveAsProjectConfirm,
    confirmDeleteOriginalScratch,
    isDeletingOriginalScratch,
  };
}
