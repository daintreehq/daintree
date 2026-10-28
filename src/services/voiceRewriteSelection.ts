/**
 * Composer selections a spoken rewrite (#14635) can act on. Each mounted
 * composer registers a source; the dictation service holds no editor imports,
 * so it reads selections only through here.
 */

/** A selection captured for a rewrite, followed through every edit until it lands or is lost. */
export interface RewriteSelection {
  /** The selected text when it was captured. */
  readonly text: string;
  /** Where it sits now, or null once an edit reached it or its composer went away. */
  range(): { from: number; to: number } | null;
  /** Calls `listener` once, the moment the selection is lost. */
  onLost(listener: () => void): void;
  /**
   * Replaces the selection with `replacement` as one undo step and selects the
   * result. False, with nothing changed, when the selection was lost.
   */
  apply(replacement: string): boolean;
  /** Stops following it; it can no longer be applied. */
  release(): void;
}

export interface ComposerSelectionSource {
  readonly terminalId: string;
  /** The composer holds the caret. */
  hasFocus(): boolean;
  /** The current selection, or null when nothing is selected. */
  captureSelection(): RewriteSelection | null;
}

const sources = new Set<ComposerSelectionSource>();

export function registerComposerSelectionSource(source: ComposerSelectionSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/**
 * The composer a rewrite gesture is aimed at: the one holding the caret, else
 * the focused panel's.
 */
export function findRewriteComposer(focusedPanelId: string | null): ComposerSelectionSource | null {
  for (const source of sources) {
    if (source.hasFocus()) return source;
  }
  if (!focusedPanelId) return null;
  for (const source of sources) {
    if (source.terminalId === focusedPanelId) return source;
  }
  return null;
}
