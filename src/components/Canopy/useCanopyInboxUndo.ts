import { useCallback, useEffect, useRef, useState } from "react";
import type { CanopyReadMark } from "@shared/types/ipc/canopy";
import type { HostId } from "@shared/types/remoteHosts";
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { CanopyApi } from "./canopyHostSource";

/** How long the panel's undo line stays up, as a mail client's "Undo send". */
export const UNDO_LINE_MS = 10_000;

/**
 * The panel's one-deep undo: Z, or an action's toast, takes back the newest
 * triage done on the host shown. A read change goes back only where main
 * still has it as the change left it.
 */
export function useCanopyInboxUndo({
  hostId,
  api,
}: {
  /** The other host the panel shows, or null for the window's own. */
  hostId: HostId | null;
  api: CanopyApi;
}) {
  // The last triage the user did here, to take back with Z or the toast's
  // Undo. One deep, as in mail: only the newest action can be undone.
  const undoRef = useRef<(() => void) | null>(null);
  // The line naming the newest archive, trash or read change, with its Undo. It is
  // the same one action as Z, so the next action replaces it.
  const [line, setLine] = useState<{ id: number; message: string; undo: () => void } | null>(null);
  const lineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineIdRef = useRef(0);
  const clearLine = useCallback(() => {
    if (lineTimerRef.current !== null) clearTimeout(lineTimerRef.current);
    lineTimerRef.current = null;
    setLine(null);
  }, []);
  useEffect(() => clearLine, [clearLine]);
  // Z never takes back, unseen, what was done on a host no longer shown.
  const shownHostRef = useRef(hostId);
  useEffect(() => {
    if (shownHostRef.current === hostId) return;
    shownHostRef.current = hostId;
    undoRef.current = null;
    clearLine();
  }, [hostId, clearLine]);
  /**
   * Holds Z for an action from its press, not from when main answers: a Z
   * pressed before then waits for it, and an action pressed after takes Z
   * over. `land` hands over the action's undo once main has done it (with an
   * Undo toast when one is given); `forget` gives Z up when main did nothing.
   */
  const reserveUndo = useCallback(() => {
    let landed: (() => void) | null = null;
    let asked = false;
    const undo = () => {
      clearLine();
      if (landed) landed();
      else asked = true;
    };
    undoRef.current = undo;
    clearLine();
    return {
      land: (
        restoreOnce: () => void,
        shown?: { title: string; message: string } | { line: string }
      ) => {
        // Z and the toast's Undo take back the same one action, once: the
        // second of them finds it done.
        let done = false;
        const restore = () => {
          if (done) return;
          done = true;
          restoreOnce();
        };
        landed = restore;
        if (asked) {
          restore();
          return;
        }
        if (!shown) return;
        if ("line" in shown) {
          // A newer action has taken Z since: this one is no longer the newest.
          if (undoRef.current !== undo) return;
          const id = ++lineIdRef.current;
          setLine({
            id,
            message: shown.line,
            undo: () => {
              if (undoRef.current === undo) undoRef.current = null;
              clearLine();
              restore();
            },
          });
          lineTimerRef.current = setTimeout(clearLine, UNDO_LINE_MS);
          return;
        }
        const toast = shown;
        notify({
          type: "success",
          transient: true,
          title: toast.title,
          message: toast.message,
          context: { eventKind: "agent" },
          duration: UNDO_TOAST_DURATION_MS,
          actions: [
            {
              label: "Undo",
              onClick: () => {
                if (undoRef.current === undo) undoRef.current = null;
                restore();
              },
            },
          ],
        });
      },
      forget: () => {
        if (undoRef.current === undo) undoRef.current = null;
      },
    };
  }, [clearLine]);
  // Z takes the newest action back from anywhere in the panel: a row, the
  // folded Archived bar, or Refresh once the last row archived away — never
  // from the pane's terminal or composer, or any text field, where Z is a letter.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.shiftKey || event.altKey) return;
      if (event.key !== "z" && event.key !== "Z") return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-testid="canopy-dialog"]')) return;
      if (
        target.closest(
          'input, textarea, select, [contenteditable="true"], [data-canopy-terminal], [data-canopy-detail] .cm-editor'
        )
      ) {
        return;
      }
      event.preventDefault();
      // Held down, Z undoes once: a repeat must not take the slot from an
      // action pressed since.
      if (event.repeat) return;
      const undo = undoRef.current;
      undoRef.current = null;
      undo?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  /**
   * Undo of a read change: each run back to what it was (`before`), wherever
   * it is still as the change left it (`after`) — a new turn, or a change from
   * another view since, stands.
   */
  const undoReads = useCallback(
    (before: CanopyReadMark[], after: CanopyReadMark[]) => {
      const was = new Map(before.map((mark) => [mark.runId, mark]));
      const restores = after.flatMap((left) => {
        const mark = was.get(left.runId);
        return mark !== undefined && mark.spawnedAt === left.spawnedAt
          ? [{ mark, expectVersion: left.version }]
          : [];
      });
      if (restores.length > 0) safeFireAndForget(api.restoreReads(restores));
    },
    [api]
  );

  return { reserveUndo, undoReads, undoLine: line };
}
