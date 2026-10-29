import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { registerPanelCloseGuard, type PanelCloseVerdict } from "@/services/panelCloseGuard";
import {
  getFileDocumentProjection,
  useFileDocumentStore,
  type FileDocumentSaveOutcome,
} from "@/store/fileDocumentStore";
import { usePanelStore } from "@/store/panelStore";
import { notify } from "@/lib/notify";
import { panelNotificationAddress } from "@/lib/notificationAddress";
import { isFilePanel } from "@shared/types/panel";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { showFileDraft } from "./showFileDraft";

/**
 * Holds the close of any dirty file panel behind Save / Discard / Cancel
 * (#12323). Mounted once per project view, outside every pane: a pane can be
 * unmounted while its document stays dirty (an inactive grid tab, a maximised
 * sibling), and a guard that lived inside the pane would vanish with it and
 * let the close through unprompted. Guards follow the document projection
 * instead — registered while a panel's projection is dirty, dropped when it
 * is clean or released.
 *
 * Prompts queue: two guarded closes in one gesture ask one after the other.
 * Each prompt is its own token, so a Save or Discard that started on an
 * earlier prompt can never answer a later one, and any failure answers
 * Cancel — the panel stays, the draft stays. A Save that doesn't land also
 * says why in a toast (#15017): the editor banner that would show it is only
 * mounted in Edit, and the next queued prompt can take over at once.
 */
interface Prompt {
  panelId: string;
  resolve: (verdict: PanelCloseVerdict) => void;
}

function panelFileName(panelId: string): string {
  const documentName = getFileDocumentProjection(panelId)?.fileName;
  if (documentName) return documentName;
  const panel = usePanelStore.getState().panelsById[panelId];
  const filePath = panel && isFilePanel(panel) ? panel.filePath : undefined;
  return filePath?.split(/[/\\]/).filter(Boolean).pop() ?? "this file";
}

function notifySaveFailed(panelId: string, fileName: string, reason: string): void {
  // A panel removed while the save ran has nowhere left to take the user.
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || panel.location === "trash") return;
  const trimmed = reason.trim();
  const sentence = /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  notify({
    type: "error",
    title: `Couldn't save '${fileName}'`,
    message: `${sentence} Your draft is kept.`,
    // uiFeedback is passive, and a toast is the point: the failure happened
    // on a modal the user was looking at, and its reason is off screen. The
    // answer to a press they just made outruns quiet hours and the shared
    // per-worktree error budget; a retry that fails again replaces it.
    priority: "high",
    urgent: true,
    replaceKey: `file-save-failed:${panelId}`,
    context: { eventKind: "uiFeedback", ...panelNotificationAddress(panelId) },
    action: { label: "Review draft", onClick: () => showFileDraft(panelId) },
  });
}

export function FileDocumentCloseGuardHost() {
  const dirtyIds = useFileDocumentStore(
    useCallback(
      (state) =>
        Object.keys(state.byPanelId)
          .filter((id) => state.byPanelId[id]?.dirty)
          .sort()
          .join("\n"),
      []
    )
  );
  const [queue, setQueue] = useState<Prompt[]>([]);
  // Mirrored on commit rather than during render: `settle` is stable and runs
  // after an awaited save, so it needs the live queue, and a ref written
  // during render is a compiler bailout. Layout phase, so a continuation that
  // resolves before paint still reads the queue it was queued against.
  const queueRef = useRef(queue);
  useLayoutEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  // Every prompt asked and not yet answered, kept apart from rendered state so
  // teardown can answer one whose render never committed. After teardown a
  // guard a close already captured answers Cancel at once, and a save that
  // resolves late has no prompt left to settle or report on.
  const outstandingRef = useRef(new Set<Prompt>());
  const aliveRef = useRef(false);
  useEffect(() => {
    aliveRef.current = true;
    const outstanding = outstandingRef.current;
    return () => {
      aliveRef.current = false;
      queueRef.current = [];
      for (const prompt of [...outstanding]) prompt.resolve("cancel");
    };
  }, []);
  const [busy, setBusy] = useState<"save" | "discard" | null>(null);
  // The prompt whose Save or Discard is in flight. Its document goes clean
  // mid-operation, which must not read as "this prompt is stale".
  const busyPromptRef = useRef<Prompt | null>(null);

  useEffect(() => {
    const ids = dirtyIds === "" ? [] : dirtyIds.split("\n");
    const disposers = ids.map((panelId) =>
      registerPanelCloseGuard(
        panelId,
        () =>
          new Promise<PanelCloseVerdict>((resolve) => {
            if (!aliveRef.current) {
              resolve("cancel");
              return;
            }
            const prompt: Prompt = {
              panelId,
              resolve: (verdict) => {
                outstandingRef.current.delete(prompt);
                resolve(verdict);
              },
            };
            outstandingRef.current.add(prompt);
            setQueue((current) => [...current, prompt]);
          })
      )
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [dirtyIds]);

  // A prompt whose document went clean or was released underneath it (a
  // discard from elsewhere, a save from a sibling panel, the panel removed by
  // a bulk path) answers Cancel: the close it was holding is for state that
  // has moved on, and a stale approval must not fire. A clean panel's next
  // close goes straight through anyway.
  useEffect(() => {
    const dirty = new Set(dirtyIds === "" ? [] : dirtyIds.split("\n"));
    setQueue((current) => {
      const kept = current.filter((prompt) => {
        if (dirty.has(prompt.panelId) || busyPromptRef.current === prompt) return true;
        prompt.resolve("cancel");
        return false;
      });
      return kept.length === current.length ? current : kept;
    });
  }, [dirtyIds]);

  const current = queue[0] ?? null;

  /** Answers `prompt`; false when it was already answered or dropped. */
  const settle = useCallback((prompt: Prompt, verdict: PanelCloseVerdict): boolean => {
    // Only the prompt an operation started on may be answered by it.
    if (busyPromptRef.current === prompt) busyPromptRef.current = null;
    if (!queueRef.current.includes(prompt)) return false;
    prompt.resolve(verdict);
    setQueue((existing) => existing.filter((entry) => entry !== prompt));
    setBusy(null);
    return true;
  }, []);

  const handleSave = useCallback(
    async (prompt: Prompt) => {
      const projection = getFileDocumentProjection(prompt.panelId);
      if (!projection) {
        settle(prompt, "cancel");
        return;
      }
      // Named as the prompt showed it: a refused save can leave the document
      // released by the time it answers.
      const fileName = panelFileName(prompt.panelId);
      setBusy("save");
      busyPromptRef.current = prompt;
      let outcome: FileDocumentSaveOutcome;
      try {
        outcome = await projection.save();
      } catch (error) {
        logError("[FileDocumentCloseGuardHost] save failed", error);
        outcome = { status: "error", reason: formatErrorMessage(error, "The save failed") };
      }
      if (outcome.status === "saved") {
        settle(prompt, "proceed");
        return;
      }
      // A stale prompt was answered elsewhere; its failure isn't this one's to report.
      if (settle(prompt, "cancel")) notifySaveFailed(prompt.panelId, fileName, outcome.reason);
    },
    [settle]
  );

  const handleDiscard = useCallback(
    async (prompt: Prompt) => {
      const projection = getFileDocumentProjection(prompt.panelId);
      setBusy("discard");
      busyPromptRef.current = prompt;
      try {
        await projection?.discard();
        settle(prompt, "proceed");
      } catch (error) {
        logError("[FileDocumentCloseGuardHost] discard failed", error);
        settle(prompt, "cancel");
      }
    },
    [settle]
  );

  const fileName = useMemo(() => (current ? panelFileName(current.panelId) : ""), [current]);

  if (!current) return null;
  const prompt = current;

  return (
    <AppDialog
      isOpen
      onClose={() => {
        if (busy === null) settle(prompt, "cancel");
      }}
      dismissible={busy === null}
      size="sm"
      zIndex="nested"
      // Explicit: Discard now leads the footer, and the default "first" pass
      // would land on it.
      initialFocus="cancel"
      data-testid="file-pane-close-prompt"
    >
      <AppDialog.Header>
        <AppDialog.Title>{`Save changes to '${fileName}'?`}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <AppDialog.Description>
          Save your edits before leaving this file, or discard them to continue.
        </AppDialog.Description>
      </AppDialog.Body>
      {/* Save / Discard / Cancel is a real three-way answer, so Discard is not a
          second confirm: it is the destructive choice, set apart on the leading
          edge from the Cancel / Save pair the user reaches for. */}
      <AppDialog.Footer
        leadingAction={{
          label: "Discard changes",
          onClick: () => void handleDiscard(prompt),
          disabled: busy !== null,
          loading: busy === "discard",
          intent: "destructive",
        }}
        secondaryAction={{
          label: "Cancel",
          onClick: () => settle(prompt, "cancel"),
          disabled: busy !== null,
        }}
        primaryAction={{
          label: "Save",
          onClick: () => void handleSave(prompt),
          disabled: busy !== null && busy !== "save",
          loading: busy === "save",
        }}
      />
    </AppDialog>
  );
}
