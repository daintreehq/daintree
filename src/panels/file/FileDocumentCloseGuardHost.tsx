import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { registerPanelCloseGuard, type PanelCloseVerdict } from "@/services/panelCloseGuard";
import { getFileDocumentProjection, useFileDocumentStore } from "@/store/fileDocumentStore";
import { usePanelStore } from "@/store/panelStore";
import { isFilePanel } from "@shared/types/panel";
import { logError } from "@/utils/logger";

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
 * Cancel — the panel stays, the draft stays.
 */
interface Prompt {
  panelId: string;
  resolve: (verdict: PanelCloseVerdict) => void;
}

function panelFileName(panelId: string): string {
  const panel = usePanelStore.getState().panelsById[panelId];
  const filePath = panel && isFilePanel(panel) ? panel.filePath : undefined;
  return filePath?.split(/[/\\]/).filter(Boolean).pop() ?? "this file";
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
  const queueRef = useRef(queue);
  queueRef.current = queue;
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
            setQueue((current) => [...current, { panelId, resolve }]);
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

  const settle = useCallback((prompt: Prompt, verdict: PanelCloseVerdict) => {
    // Only the prompt an operation started on may be answered by it.
    if (busyPromptRef.current === prompt) busyPromptRef.current = null;
    if (!queueRef.current.includes(prompt)) return;
    prompt.resolve(verdict);
    setQueue((existing) => existing.filter((entry) => entry !== prompt));
    setBusy(null);
  }, []);

  const handleSave = useCallback(
    async (prompt: Prompt) => {
      const projection = getFileDocumentProjection(prompt.panelId);
      if (!projection) {
        settle(prompt, "cancel");
        return;
      }
      setBusy("save");
      busyPromptRef.current = prompt;
      try {
        const saved = await projection.save();
        settle(prompt, saved ? "proceed" : "cancel");
      } catch (error) {
        logError("[FileDocumentCloseGuardHost] save failed", error);
        settle(prompt, "cancel");
      }
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
      data-testid="file-pane-close-prompt"
    >
      <AppDialog.Header>
        <AppDialog.Title>{`Save changes to '${fileName}'?`}</AppDialog.Title>
      </AppDialog.Header>
      <AppDialog.Body>
        <AppDialog.Description>
          Closing without saving loses the edits you made since the last save.
        </AppDialog.Description>
      </AppDialog.Body>
      <AppDialog.Footer>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            variant="ghost"
            onClick={() => settle(prompt, "cancel")}
            disabled={busy !== null}
            className="text-text-secondary hover:text-text-primary"
            data-confirm-role="cancel"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleDiscard(prompt)}
            disabled={busy !== null}
            loading={busy === "discard"}
            data-testid="file-pane-close-discard"
          >
            Discard changes
          </Button>
          <Button
            variant="contrast"
            onClick={() => void handleSave(prompt)}
            disabled={busy !== null}
            loading={busy === "save"}
            data-confirm-role="confirm"
            data-testid="file-pane-close-save"
          >
            Save
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
