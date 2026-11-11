import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { PendingImageRange } from "@/lib/composerPendingImages";
import { restoredImageChipEffects, setImageChipPreview } from "./inputEditorExtensions";
import { composerDraftGeneration } from "./inputEditorExtensions/composerDraftGeneration";

async function readPreview(filePath: string): Promise<string | null> {
  try {
    const { thumbnailDataUrl } = await window.electron.clipboard.thumbnailFromPath(filePath);
    return thumbnailDataUrl;
  } catch {
    return null;
  }
}

/**
 * Puts the chips for `images` back on the text `view` shows (#16786): at once,
 * so a send straight away attaches them, with their previews filled in as they
 * arrive. A preview that can't be read leaves its chip without one, still
 * attaching the image. `isCurrent` says whether `view` is still the composer's.
 */
export function restoreImageChips(
  view: EditorView,
  images: readonly PendingImageRange[],
  isCurrent: () => boolean
): void {
  const effects = restoredImageChipEffects(view.state, images);
  if (effects.length === 0) return;
  view.dispatch({ effects });
  const generation = composerDraftGeneration(view);
  for (const filePath of new Set(effects.map((effect) => effect.value.filePath))) {
    void readPreview(filePath).then((thumbnailUrl) => {
      if (thumbnailUrl === null || !isCurrent() || composerDraftGeneration(view) !== generation) {
        return;
      }
      view.dispatch({
        effects: setImageChipPreview.of({ filePath, thumbnailUrl }),
        annotations: Transaction.addToHistory.of(false),
      });
    });
  }
}
