/**
 * What a composer's editor held beyond its draft's text, kept while no editor
 * shows that draft (#16883). The draft store holds text only, and maximizing,
 * docking, a tab or worktree switch tear the editor down and build another
 * over the same draft: its image and file chips and its selection come back
 * from here. Structural, so this module stays free of the editor's packages.
 */
export interface ComposerRemountSnapshot {
  /** The draft the editor showed: the ranges below are in it. */
  draft: string;
  images: readonly { from: number; to: number; filePath: string; thumbnailUrl: string }[];
  files: readonly {
    from: number;
    to: number;
    filePath: string;
    fileName: string;
    fileSize?: number;
  }[];
  selection: { anchor: number; head: number };
  /** The editor had published its caret for dictation (`composerCaret`). */
  caretPublished: boolean;
}

/** Keyed by draft key (`makeDraftKey`). */
const snapshots = new Map<string, ComposerRemountSnapshot>();

export function keepComposerSnapshot(draftKey: string, snapshot: ComposerRemountSnapshot): void {
  snapshots.set(draftKey, snapshot);
}

/**
 * The snapshot for an editor about to show `draft`, or null when the draft
 * changed since: chips on other text would attach what the text no longer
 * says. Used up either way.
 */
export function takeComposerSnapshot(
  draftKey: string,
  draft: string
): ComposerRemountSnapshot | null {
  const snapshot = snapshots.get(draftKey);
  snapshots.delete(draftKey);
  return snapshot !== undefined && snapshot.draft === draft ? snapshot : null;
}

/** The draft was cleared or its composer closed: its chips and caret go with it. */
export function forgetComposerSnapshots(matches: (draftKey: string) => boolean): void {
  for (const key of [...snapshots.keys()]) {
    if (matches(key)) snapshots.delete(key);
  }
}

export function _resetComposerSnapshotsForTesting(): void {
  snapshots.clear();
}
