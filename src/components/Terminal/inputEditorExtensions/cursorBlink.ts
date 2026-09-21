import type { Extension } from "@codemirror/state";
import { drawSelection, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { COMPOSER_CURSOR_BLINK_MS } from "@/lib/animationUtils";

/**
 * `drawSelection()` with the cursor blinked by a timer instead of CodeMirror's
 * CSS animation (#12584).
 *
 * The built-in blink is an infinite `steps(1)` animation on `.cm-cursorLayer`
 * that runs whenever the editor has focus — most of the time for the
 * composer. Chromium keeps the frame scheduler at display rate for as long as
 * any animation runs, stepped or not, so an idle focused composer cost ~60
 * compositor frames and ~12 style recalcs a second for a cursor that changes
 * twice a second. A timer flipping the layer's opacity changes the same pixels
 * and lets the scheduler sleep in between.
 *
 * The timer runs only while the editor has focus, and every focus, selection
 * or document change restarts it from the visible phase — the same "cursor
 * shows the moment it moves" behaviour the built-in blink gets by swapping
 * between its two keyframe names.
 */
export function createCursorBlink(): Extension {
  return [drawSelection({ cursorBlinkRate: 0 }), noCssBlink, cursorBlinkPlugin];
}

// A zero blink rate leaves the `infinite` animation in place with a 0ms
// duration, and the layer still swaps its inline animation name on every
// selection change. Take the animation off outright rather than rely on how a
// zero-length infinite animation resolves.
const noCssBlink = EditorView.theme({
  "&.cm-focused > .cm-scroller > .cm-cursorLayer": { animation: "none !important" },
});

class CursorBlink {
  private timer: ReturnType<typeof setInterval> | null = null;
  private hidden = false;

  constructor(private readonly view: EditorView) {
    this.restart();
  }

  update(update: ViewUpdate): void {
    if (update.focusChanged || update.selectionSet || update.docChanged) this.restart();
  }

  destroy(): void {
    this.stop();
    this.setHidden(false);
  }

  private restart(): void {
    this.stop();
    this.setHidden(false);
    if (!this.view.hasFocus) return;
    this.timer = setInterval(() => this.setHidden(!this.hidden), COMPOSER_CURSOR_BLINK_MS / 2);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    // The layer is created by drawSelection's own plugin and lives for the
    // editor's lifetime; look it up each time rather than caching a node that
    // plugin owns.
    const layer = this.view.scrollDOM.querySelector<HTMLElement>(":scope > .cm-cursorLayer");
    if (layer) layer.style.opacity = hidden ? "0" : "";
  }
}

const cursorBlinkPlugin = ViewPlugin.fromClass(CursorBlink);
