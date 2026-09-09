import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { registerPanelCloseGuard, type PanelCloseVerdict } from "@/services/panelCloseGuard";
import { getFileDocumentProjection } from "@/store/fileDocumentStore";

interface FileDocumentCloseGuardOptions {
  panelId: string;
  dirty: boolean;
  fileName: string;
}

/**
 * Holds the close of a dirty file panel behind Save / Discard / Cancel
 * (#12323). Registered with the close-guard registry only while the document
 * is dirty, so a clean panel closes exactly as it always did. The prompt is
 * hosted by the panel rather than the editor view: the draft is document
 * state, and it must survive a switch to Rendered or Source.
 *
 * Save and Discard call back into the owning plugin through the document
 * projection. A save that is refused (a conflict, a write error) cancels the
 * close and leaves the editor's own banner to explain — the panel never
 * discards on the user's behalf.
 */
export function useFileDocumentCloseGuard({
  panelId,
  dirty,
  fileName,
}: FileDocumentCloseGuardOptions): ReactNode {
  const [prompt, setPrompt] = useState<{ resolve: (verdict: PanelCloseVerdict) => void } | null>(
    null
  );
  const [busy, setBusy] = useState<"save" | "discard" | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  useEffect(() => {
    if (!dirty) return;
    return registerPanelCloseGuard(
      panelId,
      () =>
        new Promise<PanelCloseVerdict>((resolve) => {
          setPrompt({ resolve });
        })
    );
  }, [panelId, dirty]);

  // An unmount mid-prompt (the panel was torn down by a bulk path) answers
  // cancel so the awaiting close never hangs on a dialog that no longer exists.
  useEffect(() => {
    return () => {
      promptRef.current?.resolve("cancel");
    };
  }, []);

  const settle = useCallback((verdict: PanelCloseVerdict) => {
    promptRef.current?.resolve(verdict);
    setPrompt(null);
    setBusy(null);
  }, []);

  const handleSave = useCallback(async () => {
    const projection = getFileDocumentProjection(panelId);
    if (!projection) {
      settle("cancel");
      return;
    }
    setBusy("save");
    const saved = await projection.save();
    settle(saved ? "proceed" : "cancel");
  }, [panelId, settle]);

  const handleDiscard = useCallback(async () => {
    const projection = getFileDocumentProjection(panelId);
    setBusy("discard");
    try {
      await projection?.discard();
    } finally {
      settle("proceed");
    }
  }, [panelId, settle]);

  if (!prompt) return null;

  return (
    <AppDialog
      isOpen
      onClose={() => settle("cancel")}
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
            onClick={() => settle("cancel")}
            disabled={busy !== null}
            className="text-text-secondary hover:text-text-primary"
            data-confirm-role="cancel"
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleDiscard()}
            disabled={busy !== null}
            loading={busy === "discard"}
            data-testid="file-pane-close-discard"
          >
            Discard changes
          </Button>
          <Button
            variant="contrast"
            onClick={() => void handleSave()}
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
