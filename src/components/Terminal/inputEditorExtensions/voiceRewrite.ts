import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { Transaction, type ChangeDesc, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { RewriteSelection } from "@/services/voiceRewriteSelection";

export const REWRITE_USER_EVENT = "input.voice-rewrite";

const trackedByView = new WeakMap<EditorView, Set<TrackedSelection>>();

class TrackedSelection implements RewriteSelection {
  private lost = false;
  private listeners: Array<() => void> = [];

  constructor(
    private readonly view: EditorView,
    readonly text: string,
    private from: number,
    private to: number,
    private readonly onApplied: (doc: string) => void
  ) {}

  range(): { from: number; to: number } | null {
    return this.lost ? null : { from: this.from, to: this.to };
  }

  onLost(listener: () => void): void {
    if (this.lost) listener();
    else this.listeners.push(listener);
  }

  /**
   * Follows the selection through a change. Any change inside it, or over it,
   * loses it for good, even one that later puts the same text back. Typing
   * either side only moves it.
   */
  map(changes: ChangeDesc): void {
    if (this.lost) return;
    let touched = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA < this.to && toA > this.from) touched = true;
    });
    if (touched) {
      this.lose();
      return;
    }
    this.from = changes.mapPos(this.from, 1);
    this.to = changes.mapPos(this.to, -1);
  }

  lose(): void {
    if (this.lost) return;
    this.lost = true;
    trackedByView.get(this.view)?.delete(this);
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener();
  }

  apply(replacement: string): boolean {
    if (this.lost) return false;
    const { view, from, to } = this;
    // Lands even while a send holds the composer read-only: the send is
    // waiting for exactly this.
    if (view.state.sliceDoc(from, to) !== this.text) {
      this.lose();
      return false;
    }
    this.release();
    view.dispatch({
      changes: { from, to, insert: replacement },
      // Selected, so a second instruction can follow straight on.
      selection: { anchor: from, head: from + replacement.length },
      scrollIntoView: true,
      annotations: [isolateHistory.of("full"), Transaction.userEvent.of(REWRITE_USER_EVENT)],
    });
    this.onApplied(view.state.doc.toString());
    return true;
  }

  release(): void {
    this.lost = true;
    this.listeners = [];
    trackedByView.get(this.view)?.delete(this);
  }
}

/**
 * The view's non-empty main selection, followed through every edit from now
 * on. `onApplied` gets the document a landed rewrite leaves, for whatever must
 * hold it before the next render does.
 */
export function captureRewriteSelection(
  view: EditorView,
  onApplied: (doc: string) => void = () => {}
): RewriteSelection | null {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const tracked = new TrackedSelection(view, view.state.sliceDoc(from, to), from, to, onApplied);
  let set = trackedByView.get(view);
  if (!set) {
    set = new Set();
    trackedByView.set(view, set);
  }
  set.add(tracked);
  return tracked;
}

/** Keeps captured selections in step with the document, and loses them with the editor. */
export const voiceRewriteTracker: Extension = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      const tracked = trackedByView.get(update.view);
      if (!tracked) return;
      for (const selection of [...tracked]) selection.map(update.changes);
    }

    destroy(): void {
      const tracked = trackedByView.get(this.view);
      if (!tracked) return;
      for (const selection of [...tracked]) selection.lose();
    }
  }
);
