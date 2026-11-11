import type { TextChange } from "./textRangeMapping";

/** Where an image's path sits in a draft, for the composer to put its chip back on. */
export interface PendingImageRange {
  from: number;
  to: number;
  filePath: string;
}

/**
 * A draft written from outside the composer with images in it (#16786). The
 * draft store holds text only, so a sent message taken back for editing leaves
 * its images here until the composer shows that draft.
 */
export interface PendingComposerImages {
  /** The draft the write left in the store: the images' positions are in it. */
  draft: string;
  /** The draft the write went over. */
  before: string;
  /**
   * The write itself. A composer still showing `before` makes exactly this
   * change, so the chips it already has stay on their own text.
   */
  change: TextChange;
  images: readonly PendingImageRange[];
}

/** Keyed by draft key (`makeDraftKey`), the latest write's only. */
const pending = new Map<string, PendingComposerImages>();

export function setPendingComposerImages(draftKey: string, images: PendingComposerImages): void {
  pending.set(draftKey, images);
}

/**
 * The images waiting for the composer to show `draft`, or a draft that only
 * added to it since (dictation or a handoff landing before the composer
 * caught up): their text is still where it was. Any pending ones are used up
 * either way.
 */
export function takePendingComposerImages(
  draftKey: string,
  draft: string
): PendingComposerImages | null {
  const entry = pending.get(draftKey);
  pending.delete(draftKey);
  return entry !== undefined && draft.startsWith(entry.draft) ? entry : null;
}

/**
 * The change that brings a composer still showing `pending.before` to `draft`:
 * the restore as it was made, then whatever was added to its draft since.
 */
export function restoreChange(pending: PendingComposerImages, draft: string): TextChange[] {
  const added = draft.slice(pending.draft.length);
  const { before, change } = pending;
  if (added === "") return [change];
  // A restore that replaced a blank draft ends where the addition goes in.
  if (change.to === before.length) return [{ ...change, insert: change.insert + added }];
  return [change, { from: before.length, to: before.length, insert: added }];
}

/**
 * Where each of `imagePaths` sits in `text`, in order, as a composer's chips
 * list them. A path `text` doesn't spell after the one before it is left out
 * rather than put on some other mention of it.
 */
export function imageRangesIn(text: string, imagePaths: readonly string[]): PendingImageRange[] {
  const ranges: PendingImageRange[] = [];
  let from = 0;
  for (const filePath of imagePaths) {
    if (filePath === "") continue;
    const at = text.indexOf(filePath, from);
    if (at < 0) continue;
    ranges.push({ from: at, to: at + filePath.length, filePath });
    from = at + filePath.length;
  }
  return ranges;
}

export function _resetPendingComposerImagesForTesting(): void {
  pending.clear();
}
