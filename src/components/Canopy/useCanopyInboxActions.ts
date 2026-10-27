import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { CanopyReadMark } from "@shared/types/ipc/canopy";
import type { HostId } from "@shared/types/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useCanopyStore } from "@/store/canopyStore";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import type { AgentSnoozeDurationOption } from "@shared/utils/agentSnoozeDurations";
import { itemArchived, itemSubject, type CanopyItem } from "./canopyModel";
import {
  canopyCardDomId,
  type CanopyCardHandle,
  type CanopyCardHandlers,
  type CanopyPaneFocus,
} from "./CanopyCard";
import type { CanopyRowMenuActions } from "./CanopyRowMenu";
import type { CanopyApi, CanopyTerminalApi } from "./canopyHostSource";
import { placeOf } from "./canopyInboxPlace";

/** An error toast whose one recovery is the place the action can be done by hand. */
function failToast(
  title: string,
  error: unknown,
  recovery: { label: string; onClick: () => void }
) {
  notify({
    type: "error",
    title,
    message: formatErrorMessage(error, "Something went wrong."),
    context: { eventKind: "agent" },
    duration: 6000,
    actions: [recovery],
  });
}

interface UndoReservation {
  land: (
    restoreOnce: () => void,
    shown?: { title: string; message: string } | { line: string }
  ) => void;
  forget: () => void;
}

/**
 * What the panel does to runs: open, archive, answer, reply, rename, trash,
 * read and refresh, each on the host it was asked of and each held for Z.
 * Where the keyboard goes after one comes from the focus it is handed.
 */
export function useCanopyInboxActions({
  hostId,
  ownHostId,
  api,
  terminalApi,
  listed,
  focusedItem,
  searchRef,
  detailRef,
  selectNow,
  focusCardNow,
  openPaneNow,
  nextAfter,
  moveOnTarget,
  leavePane,
  showsHost,
  isSelected,
  captureFocusAfterClose,
  closeForTerminal,
  reserveUndo,
  undoReads,
  menuOpenChanged,
  requestRank,
}: {
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  ownHostId: HostId;
  api: CanopyApi;
  terminalApi: CanopyTerminalApi;
  /** The inbox as listed, filters included. */
  listed: CanopyItem[];
  /** The run the pane shows. */
  focusedItem: CanopyItem | null;
  searchRef: RefObject<HTMLInputElement | null>;
  detailRef: RefObject<CanopyCardHandle | null>;
  selectNow: (runId: string) => void;
  focusCardNow: (runId: string) => void;
  openPaneNow: (runId: string, focus: CanopyPaneFocus) => void;
  nextAfter: (runId: string) => CanopyItem | undefined;
  moveOnTarget: (runId: string) => CanopyItem | undefined;
  leavePane: (item: CanopyItem) => void;
  showsHost: (hostId: HostId | null) => boolean;
  isSelected: (runId: string) => boolean;
  captureFocusAfterClose: () => void;
  closeForTerminal: (runId: string) => void;
  reserveUndo: () => UndoReservation;
  undoReads: (before: CanopyReadMark[], after: CanopyReadMark[]) => void;
  menuOpenChanged: (open: boolean) => void;
  requestRank: () => void;
}) {
  // A deliberate act on a run reads it at once — going to it, a click,
  // answering, replying — through the turn it showed. Merely arriving on it
  // reads it only once it has stayed in front of the user (main's dwell).
  const readNow = useCallback(
    (item: CanopyItem) => {
      if (!item.unread) return;
      safeFireAndForget(
        api.setRead(item.runId, { spawnedAt: item.row.run.spawnedAt }, true, item.readMark?.turn)
      );
    },
    [api]
  );

  const handlers = useMemo<CanopyCardHandlers>(() => {
    const openRun = (item: CanopyItem, newWindow = false) => {
      readNow(item);
      const place = placeOf(item, hostId, ownHostId);
      if (place.hostId !== null) {
        // Another host's run: the window moves to that host and project (or a
        // new one opens there, or the window already showing it comes
        // forward), and the pane is focused wherever it lands. The panel
        // stays open on a switch that didn't happen; its toast says why, and
        // its Retry closes the panel once it lands.
        const focusIntent = { intent: "focus-panel", panelId: place.runId } as const;
        const placeHostId = place.hostId;
        void switchToHost(placeHostId, newWindow, place.workspaceId, {
          focusIntent,
          onLanded: () => {
            // A panel since closed, or showing another host, is the user's newer choice.
            if (!showsHost(hostId)) return;
            if (useCanopyStore.getState().isOpen) closeForTerminal(item.runId);
          },
        });
        return;
      }
      const args = { runId: place.runId, workspaceId: place.workspaceId };
      if (place.workspaceId !== getViewWorkspaceId()) {
        // The switch replaces this view, so the panel closes first; the view
        // is kept, and the panel opens where it was left when it comes back.
        closeForTerminal(item.runId);
        void actionService.dispatch("pilot.openRun", args, { source: "user" });
        return;
      }
      // Here already: focus the terminal while the panel is still open, and
      // close only once that worked. `pilot.openRun` arms the palette's
      // focus-restore suppression on success, so the close can't hand focus
      // back to whatever opened the panel.
      void actionService.dispatch("pilot.openRun", args, { source: "user" }).then((result) => {
        if (!result.ok) return;
        // `pilot.openRun` arms the palettes' one-shot restore suppression; this
        // is a dialog, which hands focus on by its own target instead, so the
        // flag is taken here rather than left for the next palette to close.
        consumePaletteFocusRestoreSuppression();
        captureFocusAfterClose();
        closeForTerminal(item.runId);
      });
    };
    // The incarnation on screen, so main refuses a terminal respawned since.
    const target = (item: CanopyItem) => ({ spawnedAt: item.row.run.spawnedAt });
    const goTo = (item: CanopyItem) => ({ label: "Go to terminal", onClick: () => openRun(item) });
    const archive = (item: CanopyItem, expectTurn?: number) =>
      expectTurn === undefined
        ? api.archive(item.runId, target(item))
        : api.archive(item.runId, target(item), expectTurn);
    const unarchive = (item: CanopyItem) => api.unarchive(item.runId, target(item));
    const archiveFailed =
      (item: CanopyItem) =>
      (error: unknown): void =>
        failToast("Couldn't archive", error, goTo(item));
    const unarchiveFailed =
      (item: CanopyItem) =>
      (error: unknown): void =>
        failToast("Couldn't move to inbox", error, goTo(item));
    return {
      onOpen: openRun,
      onLeavePane: leavePane,
      onSent: (item, moveOnTo) => {
        readNow(item);
        // A reply stays on the run it answered, from the reply or typed
        // straight into the terminal, so the user can watch it picked up, as
        // Send stays on the thread in mail. The answered one reads as replied
        // where it is, and leaves the band at a later re-rank.
        if (moveOnTo === undefined) return;
        // The user moved to another run while the reply was on its way, or
        // closed the panel: their choice stands.
        if (!showsHost(hostId) || !isSelected(item.runId)) return;
        // ⌘↩: on to the run the reply named as it was pressed, into its reply.
        const next = moveOnTarget(moveOnTo);
        if (!next || next.runId === item.runId) return;
        if (searchRef.current !== null && document.activeElement === searchRef.current) {
          selectNow(next.runId);
        } else {
          openPaneNow(next.runId, "composer");
        }
      },
      onArchive: (item) => {
        if (itemArchived(item)) {
          const turn = item.readMark?.turn ?? 0;
          const undo = reserveUndo();
          safeFireAndForget(
            unarchive(item).then(
              () =>
                undo.land(
                  () =>
                    // Main archives it again only while it has done nothing since
                    // it came back: otherwise that would hide what it did.
                    safeFireAndForget(archive(item, turn).catch(archiveFailed(item))),
                  { line: `Moved '${itemSubject(item)}' to inbox` }
                ),
              (error: unknown) => {
                undo.forget();
                unarchiveFailed(item)(error);
              }
            )
          );
          return;
        }
        // The cursor moves on before the run leaves, as archiving does in mail —
        // only off the run it is on: a row archived from its hover button
        // leaves the user where they were.
        if (isSelected(item.runId)) {
          const next = nextAfter(item.runId);
          if (next) focusCardNow(next.runId);
        }
        const before = item.readMark;
        // No toast: the user watched it leave. The panel's undo line and Z take it back.
        const undo = reserveUndo();
        safeFireAndForget(
          archive(item).then(
            (after) => {
              // Refused — the run left, or was respawned: nothing to undo.
              if (after === null) return undo.forget();
              undo.land(
                () => {
                  safeFireAndForget(unarchive(item).catch(unarchiveFailed(item)));
                  // Archiving read it; taking it back puts back what was unread.
                  if (before) undoReads([before], [after]);
                },
                { line: `Archived '${itemSubject(item)}'` }
              );
            },
            (error: unknown) => {
              undo.forget();
              archiveFailed(item)(error);
            }
          )
        );
      },
      onSendFailed: (item, error) => failToast("Couldn't send to agent", error, goTo(item)),
      onAnswer: function answer(item, label) {
        readNow(item);
        // The answer stays on the run it answered, as a reply does.
        safeFireAndForget(
          terminalApi.answer(item.runId, target(item), label).then(
            () => {
              if (!showsHost(hostId) || !isSelected(item.runId)) return;
              // A choice in the pane goes away with the screen it answered, and
              // the keyboard with it, to the page: it goes to the run's row
              // instead, where the next answer is one key away. Anywhere else,
              // Reply and Go to terminal beside the choices included, it stays.
              const active = document.activeElement;
              const lost =
                active === null ||
                active === document.body ||
                active.closest("[data-canopy-detail] [data-canopy-choice]") !== null;
              if (!lost) return;
              if (document.getElementById(canopyCardDomId(item.runId))) {
                focusCardNow(item.runId);
              } else {
                // Its row folded away: the pane keeps the keyboard.
                detailRef.current?.focusComposer();
              }
            },
            (error: unknown) => failToast("Couldn't answer", error, goTo(item))
          )
        );
      },
      // No toast on success: the user watched the name change. A refusal says
      // so and keeps the name it had.
      onRename: (item, title) => {
        const rename = (): Promise<void> =>
          api.rename(item.runId, target(item), title).catch((error: unknown) => {
            failToast("Couldn't rename terminal", error, {
              label: "Retry",
              onClick: () => safeFireAndForget(rename()),
            });
            throw error;
          });
        return rename();
      },
      onTrash: (item) => {
        // No toast: the run leaves for the panel's own Trash, and the undo
        // line and Z take it back. The receipt means something only to the
        // host that trashed it, so Undo goes back there whichever host the
        // panel shows by then.
        const trashedOn = api;
        const undo = reserveUndo();
        safeFireAndForget(
          trashedOn.trash(item.runId, target(item)).then(
            (receipt) => {
              if (receipt === null) return undo.forget();
              undo.land(
                () =>
                  safeFireAndForget(
                    trashedOn.untrash(receipt).catch((error: unknown) =>
                      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
                      notify({
                        type: "error",
                        title: "Couldn't restore terminal",
                        message: formatErrorMessage(error, "It has left the trash."),
                        context: { eventKind: "agent" },
                        duration: 6000,
                      })
                    )
                  ),
                { line: `Trashed '${itemSubject(item)}'` }
              );
            },
            (error: unknown) => {
              undo.forget();
              failToast("Couldn't trash terminal", error, goTo(item));
            }
          )
        );
      },
    };
  }, [
    readNow,
    focusCardNow,
    selectNow,
    openPaneNow,
    nextAfter,
    moveOnTarget,
    leavePane,
    showsHost,
    isSelected,
    captureFocusAfterClose,
    closeForTerminal,
    searchRef,
    detailRef,
    reserveUndo,
    undoReads,
    api,
    terminalApi,
    hostId,
    ownHostId,
  ]);

  /** U: read or unread, by hand. Z takes it back. */
  const toggleRead = useCallback(
    (item: CanopyItem) => {
      if (itemArchived(item)) return;
      const read = item.unread;
      const send = () =>
        api.setRead(item.runId, { spawnedAt: item.row.run.spawnedAt }, read, item.readMark?.turn);
      const undo = reserveUndo();
      safeFireAndForget(
        send().then(
          (after) => {
            if (!after) return undo.forget();
            // A run Canopy had no mark for had nothing unread.
            const before = item.readMark ?? {
              ...after,
              readTurn: after.turn,
              markedUnreadAt: null,
            };
            undo.land(() => undoReads([before], [after]), {
              line: `Marked '${itemSubject(item)}' as ${read ? "read" : "unread"}`,
            });
          },
          (error: unknown) => {
            undo.forget();
            failToast(read ? "Couldn't mark as read" : "Couldn't mark as unread", error, {
              label: "Retry",
              onClick: () => safeFireAndForget(send()),
            });
          }
        )
      );
    },
    [reserveUndo, undoReads, api]
  );

  /**
   * Every unread run in the inbox as listed, read through the turn the list
   * showed: anything that lands after the press stays unread. Undo puts back
   * what each was, unless it has done something since.
   */
  const markAllRead = () => {
    const unread = listed.filter((item) => item.unread);
    if (unread.length === 0) return;
    const before = unread.flatMap((item) => (item.readMark ? [item.readMark] : []));
    const undo = reserveUndo();
    safeFireAndForget(
      api
        .markAllRead(
          unread.map((item) => ({
            runId: item.runId,
            spawnedAt: item.row.run.spawnedAt,
            turn: item.readMark?.turn ?? 0,
          }))
        )
        .then(
          (after) =>
            undo.land(() => undoReads(before, after), {
              title: "Marked as read",
              message: pluralize(unread.length, "agent"),
            }),
          (error: unknown) => {
            undo.forget();
            failToast("Couldn't mark as read", error, { label: "Retry", onClick: markAllRead });
          }
        )
    );
  };

  // Trash from a row's menu arms it as its first press does; the pane's
  // button or ⌘⌫ confirms. Bumped per request, for the run it names.
  const [trashArm, setTrashArm] = useState<{ runId: string; request: number } | null>(null);
  // A request is for the run it named while it stays open: coming back to it
  // later must not find Trash armed.
  const openRunId = focusedItem?.runId ?? null;
  useEffect(() => {
    if (trashArm !== null && openRunId !== trashArm.runId) setTrashArm(null);
  }, [trashArm, openRunId]);
  // Rename from a row — its menu, or F2 — opens the run and starts the rename
  // in its title bar, where a grid pane's is.
  const [renameAsk, setRenameAsk] = useState<{ runId: string; request: number } | null>(null);
  useEffect(() => {
    if (renameAsk !== null && openRunId !== renameAsk.runId) setRenameAsk(null);
  }, [renameAsk, openRunId]);
  // Requests are for a run on the host they were made on.
  useEffect(() => {
    setTrashArm(null);
    setRenameAsk(null);
  }, [hostId]);
  const askRename = (item: CanopyItem) => {
    focusCardNow(item.runId);
    setRenameAsk((ask) => ({ runId: item.runId, request: (ask?.request ?? 0) + 1 }));
  };

  // Park and snooze reach this window's fleet service, so only a run on the
  // window's own host offers them.
  const canSetAside = useCallback(
    (item: CanopyItem) => placeOf(item, hostId, ownHostId).hostId === null,
    [hostId, ownHostId]
  );
  const [parkRunId, setParkRunId] = useState<string | null>(null);
  useEffect(() => {
    setParkRunId(null);
  }, [hostId]);
  const closePark = useCallback(() => setParkRunId(null), []);
  const asideFailed = (title: string, error: unknown, retry: () => void) =>
    failToast(title, error, { label: "Retry", onClick: retry });
  const setAside = {
    canSetAside,
    onPark: (item: CanopyItem) => {
      if (canSetAside(item)) setParkRunId(placeOf(item, hostId, ownHostId).runId);
    },
    onUnpark: function unpark(item: CanopyItem) {
      const { runId } = placeOf(item, hostId, ownHostId);
      safeFireAndForget(
        window.electron.fleet
          .unparkRun(runId)
          .catch((error: unknown) =>
            asideFailed("Couldn't unpark the agent", error, () => unpark(item))
          )
      );
    },
    onSnooze: function snooze(item: CanopyItem, option: AgentSnoozeDurationOption) {
      const { runId } = placeOf(item, hostId, ownHostId);
      safeFireAndForget(
        window.electron.fleet
          .snoozeRun(runId, option)
          .catch((error: unknown) =>
            asideFailed("Couldn't snooze the agent", error, () => snooze(item, option))
          )
      );
    },
    onWake: function wake(item: CanopyItem) {
      const { runId } = placeOf(item, hostId, ownHostId);
      safeFireAndForget(
        window.electron.fleet
          .unsnoozeRun(runId)
          .catch((error: unknown) =>
            asideFailed("Couldn't wake the agent", error, () => wake(item))
          )
      );
    },
  };

  const rowMenu: CanopyRowMenuActions = {
    ...setAside,
    onOpen: handlers.onOpen,
    // The run already open keeps its pane mounted, so the composer is focused
    // directly; another run's pane takes the keyboard there as it opens.
    onReply: (item) => {
      if (focusedItem?.runId === item.runId && detailRef.current?.focusComposer()) return;
      openPaneNow(item.runId, "composer");
    },
    onToggleRead: toggleRead,
    onReread: function reread(item) {
      safeFireAndForget(
        api.reread(item.runId, { spawnedAt: item.row.run.spawnedAt }).catch((error: unknown) =>
          failToast("Couldn't read the screen again", error, {
            label: "Go to terminal",
            onClick: () => handlers.onOpen(item),
          })
        )
      );
    },
    onArchive: handlers.onArchive,
    onRename: askRename,
    onTrash: (item) => {
      focusCardNow(item.runId);
      setTrashArm((arm) => ({ runId: item.runId, request: (arm?.request ?? 0) + 1 }));
    },
    onOpenChange: menuOpenChanged,
  };

  // A press spins the button until the refresh it asked for is done, cards
  // included. The background polls never do: they are not news.
  const [refreshes, setRefreshes] = useState(0);
  const refresh = () => {
    setRefreshes((n) => n + 1);
    safeFireAndForget(
      api
        .refresh()
        .catch((error: unknown) =>
          failToast("Couldn't refresh Canopy", error, { label: "Retry", onClick: refresh })
        )
        .finally(() => {
          setRefreshes((n) => n - 1);
          // What the user asked to see, in order now.
          requestRank();
        })
    );
  };

  return {
    readNow,
    handlers,
    toggleRead,
    markAllRead,
    askRename,
    rowMenu,
    setAside,
    parkRunId,
    closePark,
    trashArm,
    renameAsk,
    refreshes,
    refresh,
  };
}
