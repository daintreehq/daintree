import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { interimWidgetField } from "./base";

/**
 * A dictation into this composer: the session taking words, and where the
 * words dictated so far end (the next ones go there). The grey preview, when
 * it shows, runs on past `end`.
 */
export interface DictationFollow {
  session: string | null;
  end: number | null;
}

const IDLE: DictationFollow = { session: null, end: null };

/** `end` left out keeps the last one, carried through edits since. */
export const setDictationFollow = StateEffect.define<{ session: string | null; end?: number }>();

/** A dictated passage's cleanup has begun: show it from its first line. */
export const revealDictationStart = StateEffect.define<number>();

export const dictationFollowField = StateField.define<DictationFollow>({
  create() {
    return IDLE;
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.end !== null) {
      const end = tr.changes.mapPos(next.end, 1);
      if (end !== next.end) next = { ...next, end };
    }
    for (const effect of tr.effects) {
      if (!effect.is(setDictationFollow)) continue;
      const { session } = effect.value;
      if (session === null) {
        next = IDLE;
        continue;
      }
      const end = effect.value.end ?? (session === next.session ? next.end : null);
      if (session !== next.session || end !== next.end) next = { session, end };
    }
    return next;
  },
});

// Room left past the followed words, as CodeMirror leaves past a caret it
// scrolls to.
const MARGIN_PX = 5;
// How long after a wheel, touch or key a scroll still counts as the person's.
const INTENT_MS = 300;
const INTENT_EVENTS = ["wheel", "touchmove", "touchend"] as const;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);

interface Box {
  top: number;
  bottom: number;
}

function visibleBox(scroller: HTMLElement): Box {
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  return { top, bottom: top + scroller.clientHeight };
}

/** Where the dictation's words end on screen: the preview's last line, else the written words'. */
function dictationEndRect(view: EditorView, end: number | null): Box | null {
  const preview = view.contentDOM.querySelector(".cm-voice-interim");
  if (preview) {
    const rects = preview.getClientRects();
    const last = rects[rects.length - 1];
    if (last) return last;
  }
  if (end === null) return null;
  return positionRect(view, Math.min(end, view.state.doc.length), -1);
}

/**
 * Where a position sits on screen. One outside the rendered viewport has no
 * coordinates of its own, so it is placed by its line's estimated height.
 */
function positionRect(view: EditorView, pos: number, side: -1 | 1): Box | null {
  const rect = view.coordsAtPos(pos, side);
  if (rect) return rect;
  const line = view.lineBlockAt(pos);
  return { top: view.documentTop + line.top, bottom: view.documentTop + line.bottom };
}

function inView(rect: Box, box: Box): boolean {
  return rect.bottom <= box.bottom + 1 && rect.top >= box.top - 1;
}

/**
 * Keeps the end of a live dictation in view, grey preview and written words
 * alike, the way anything that streams does: scrolling up stops the
 * following, and bringing the end back into view starts it again (#14928).
 * When a passage's cleanup begins, the passage is shown from its start, once,
 * unless that is already in view; nothing follows the cleanup as it streams.
 */
class DictationFollower {
  private following = true;
  // Where this last left the scroller, and where it last saw it, so the
  // scroll event a write causes isn't read as the person scrolling, and the
  // person's own scrolls can tell up from down.
  private ownTop: number | null = null;
  private lastTop: number;
  // Only the person's own scrolling changes whether this follows: the
  // content shrinking under the scroller, CodeMirror keeping its place, or
  // the editor moving into the expanded view all scroll it too.
  private lastIntent = -Infinity;
  private pointerHeld = false;
  private readonly followKeys = { first: {}, settled: {} };
  private readonly revealKeys = { first: {}, settled: {} };

  constructor(private readonly view: EditorView) {
    this.lastTop = view.scrollDOM.scrollTop;
    const scroller = view.scrollDOM;
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    for (const type of INTENT_EVENTS) {
      scroller.addEventListener(type, this.onIntent, { passive: true });
    }
    scroller.addEventListener("keydown", this.onKeyDown);
    scroller.addEventListener("pointerdown", this.onPointerDown);
    scroller.ownerDocument.addEventListener("pointerup", this.onPointerUp, true);
    scroller.ownerDocument.addEventListener("pointercancel", this.onPointerUp, true);
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(revealDictationStart)) this.reveal(effect.value);
      }
    }
    const was = update.startState.field(dictationFollowField);
    const now = update.state.field(dictationFollowField);
    if (now.session === null && was.session !== null) {
      // The words a stop writes in land with the session's end, and are
      // brought into view like any others.
      if (this.following && was.end !== null) this.follow(update.changes.mapPos(was.end, 1));
      return;
    }
    if (now.session !== was.session) this.following = true;
    if (now.session === null || !this.following) return;
    if (
      update.docChanged ||
      update.heightChanged ||
      update.geometryChanged ||
      was !== now ||
      update.startState.field(interimWidgetField, false) !==
        update.state.field(interimWidgetField, false)
    ) {
      this.follow();
    }
  }

  destroy() {
    const scroller = this.view.scrollDOM;
    scroller.removeEventListener("scroll", this.onScroll);
    for (const type of INTENT_EVENTS) scroller.removeEventListener(type, this.onIntent);
    scroller.removeEventListener("keydown", this.onKeyDown);
    scroller.removeEventListener("pointerdown", this.onPointerDown);
    scroller.ownerDocument.removeEventListener("pointerup", this.onPointerUp, true);
    scroller.ownerDocument.removeEventListener("pointercancel", this.onPointerUp, true);
  }

  /**
   * Measured a pass late, once the composer's own size for this update is
   * written (`createAutoSize`), so a composer still growing to fit is never
   * scrolled.
   */
  private settled(
    keys: { first: object; settled: object },
    read: (view: EditorView) => number | null
  ) {
    this.view.requestMeasure({
      key: keys.first,
      read: () => null,
      write: (_, view) => {
        view.requestMeasure({
          key: keys.settled,
          read,
          write: (top) => {
            if (top !== null) this.scrollTo(top);
          },
        });
      },
    });
  }

  /** `finalEnd` follows the words a session ended on, after it has ended. */
  private follow(finalEnd?: number) {
    this.settled(this.followKeys, (view) => {
      const { session, end } = view.state.field(dictationFollowField);
      // Composition hides the preview; the words it covers aren't the end.
      if (!this.following || view.composing) return null;
      if (session === null && finalEnd === undefined) return null;
      const rect = dictationEndRect(view, session === null ? (finalEnd ?? null) : end);
      if (!rect) return null;
      const box = visibleBox(view.scrollDOM);
      const scrollTop = view.scrollDOM.scrollTop;
      if (rect.bottom + MARGIN_PX > box.bottom)
        return scrollTop + rect.bottom + MARGIN_PX - box.bottom;
      if (rect.top - MARGIN_PX < box.top) return scrollTop + rect.top - MARGIN_PX - box.top;
      return null;
    });
  }

  private reveal(from: number) {
    // The cleanup decides where the passage shows from now: the last words
    // of the dictation it cleans up aren't followed past it.
    this.following = false;
    this.settled(this.revealKeys, (view) => {
      if (from > view.state.doc.length) return null;
      const rect = positionRect(view, from, 1);
      if (!rect) return null;
      const box = visibleBox(view.scrollDOM);
      if (inView(rect, box)) return null;
      return view.scrollDOM.scrollTop + rect.top - MARGIN_PX - box.top;
    });
  }

  private scrollTo(top: number) {
    const scroller = this.view.scrollDOM;
    scroller.scrollTop = Math.max(0, top);
    this.ownTop = scroller.scrollTop;
    this.lastTop = this.ownTop;
  }

  private onIntent = () => {
    this.lastIntent = performance.now();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) this.onIntent();
  };

  private onPointerDown = (event: PointerEvent) => {
    // A press on the scroller itself, not its text, is on its scrollbar.
    if (event.target === this.view.scrollDOM) this.pointerHeld = true;
  };

  // A quick drag can let go before the scroll it made is reported.
  private onPointerUp = () => {
    if (this.pointerHeld) this.onIntent();
    this.pointerHeld = false;
  };

  private onScroll = () => {
    const scroller = this.view.scrollDOM;
    const top = scroller.scrollTop;
    const movedUp = top < this.lastTop - 1;
    this.lastTop = top;
    if (this.ownTop !== null && Math.abs(top - this.ownTop) < 1) return;
    this.ownTop = null;
    const { session, end } = this.view.state.field(dictationFollowField);
    if (session === null) return;
    if (!this.pointerHeld && performance.now() - this.lastIntent > INTENT_MS) return;
    if (movedUp) {
      this.following = false;
      return;
    }
    const rect = dictationEndRect(this.view, end);
    if (rect) this.following = inView(rect, visibleBox(scroller));
  };
}

export const dictationFollow = [dictationFollowField, ViewPlugin.fromClass(DictationFollower)];
