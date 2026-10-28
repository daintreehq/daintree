import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { interimWidgetField } from "./base";

/**
 * How the mic stands for the dictation writing into this composer: still
 * coming up (or silent), feeding words, or held (paused, reconnecting, or
 * draining its last words).
 */
export type VoiceCaretPhase = "starting" | "live" | "held";

/**
 * Where the session's next words go: a position in the draft (its anchor),
 * the composer's caret, or the end. The caret only counts once the composer
 * has had focus, as dictation only starts there then (`caretTracker`).
 */
export type VoiceCaretAt = number | "caret" | "end";

export interface VoiceCaret {
  phase: VoiceCaretPhase | null;
  at: VoiceCaretAt;
}

const HIDDEN: VoiceCaret = { phase: null, at: "end" };

interface VoiceCaretRequest {
  phase: VoiceCaretPhase | null;
  /** Left out, keeps the last one, mapped through edits since. */
  at?: VoiceCaretAt;
}

export const setVoiceCaret = StateEffect.define<VoiceCaretRequest>();

// What the session last asked each composer to show, for a state swapped in
// from elsewhere (a popped stash), which carries none of it.
const requested = new WeakMap<EditorView, VoiceCaretRequest>();

/** The effect showing `request`, remembered for `currentVoiceCaretEffects`. */
export function requestVoiceCaret(
  view: EditorView,
  request: VoiceCaretRequest
): StateEffect<VoiceCaretRequest> {
  requested.set(view, request);
  return setVoiceCaret.of(request);
}

/**
 * The session's caret for a state just swapped in. A position belongs to the
 * text it was taken in, so one at an anchor shows at the end until the next
 * pass over the draft places it.
 */
export function currentVoiceCaretEffects(view: EditorView): StateEffect<VoiceCaretRequest>[] {
  const request = requested.get(view);
  if (!request?.phase) return [];
  const at = typeof request.at === "number" ? undefined : request.at;
  return [setVoiceCaret.of({ phase: request.phase, ...(at !== undefined ? { at } : {}) })];
}

export const voiceCaretField = StateField.define<VoiceCaret>({
  create() {
    return HIDDEN;
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && typeof next.at === "number") {
      const at = tr.changes.mapPos(next.at, 1);
      if (at !== next.at) next = { ...next, at };
    }
    for (const effect of tr.effects) {
      if (!effect.is(setVoiceCaret)) continue;
      const { phase } = effect.value;
      if (phase === null) {
        next = HIDDEN;
        continue;
      }
      const at = effect.value.at ?? next.at;
      if (phase !== next.phase || at !== next.at) next = { phase, at };
    }
    return next;
  },
});

/** Where the caret shows, and whether that is past the dictation's preview. */
export function voiceCaretPosition(
  state: EditorState,
  caretCounts: boolean
): { phase: VoiceCaretPhase; pos: number; afterPreview: boolean } | null {
  const { phase, at } = state.field(voiceCaretField);
  if (phase === null) return null;
  const length = state.doc.length;
  const preview = state.field(interimWidgetField, false);
  if (preview?.text) {
    const pos = preview.pos === null ? length : Math.min(preview.pos, length);
    return { phase, pos, afterPreview: true };
  }
  if (typeof at === "number") return { phase, pos: Math.min(at, length), afterPreview: false };
  if (at === "caret" && caretCounts) {
    return { phase, pos: state.selection.main.from, afterPreview: false };
  }
  return { phase, pos: length, afterPreview: false };
}

class VoiceCaretWidget extends WidgetType {
  constructor(readonly phase: VoiceCaretPhase) {
    super();
  }
  eq(other: VoiceCaretWidget): boolean {
    return other.phase === this.phase;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-voice-caret";
    span.dataset.phase = this.phase;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  updateDOM(dom: HTMLElement): boolean {
    dom.dataset.phase = this.phase;
    return true;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const CARET_WIDGETS: Record<VoiceCaretPhase, VoiceCaretWidget> = {
  starting: new VoiceCaretWidget("starting"),
  live: new VoiceCaretWidget("live"),
  held: new VoiceCaretWidget("held"),
};

/**
 * Draws where dictation will write, focused or not, without blinking: a level
 * meter that takes no width, so nothing around it moves, past the grey
 * preview's words while one shows (the words' side is 1, a separator after
 * them 3). Where the editor's own caret follows the dictation, at the meter or
 * where the preview begins, it steps aside, so there is one caret, not two; a
 * caret the user put elsewhere stays, in a neutral ink (`apart`). An empty
 * draft whose placeholder is saying what the mic is doing shows no meter.
 */
class VoiceCaretView {
  decorations: DecorationSet = Decoration.none;
  // Matches `caretTracker`: a composer never focused has a caret at 0 nobody chose.
  private everFocused: boolean;
  covers = false;
  apart = false;

  constructor(view: EditorView) {
    this.everFocused = view.hasFocus;
    this.compute(view);
  }

  private refresh: ReturnType<typeof setTimeout> | null = null;

  update(update: ViewUpdate): void {
    if (update.view.hasFocus) this.everFocused = true;
    this.compute(update.view);
  }

  /**
   * Composing hides the caret, and a composition can end without a
   * transaction after it: redraw once CodeMirror has let go of it.
   */
  compositionEnded(view: EditorView): void {
    if (this.refresh !== null) clearTimeout(this.refresh);
    this.refresh = setTimeout(() => {
      this.refresh = null;
      if (!view.composing && view.state.field(voiceCaretField).phase !== null) view.dispatch({});
    });
  }

  destroy(): void {
    if (this.refresh !== null) clearTimeout(this.refresh);
  }

  private compute(view: EditorView): void {
    const at = view.composing ? null : voiceCaretPosition(view.state, this.everFocused);
    // Starting, no audio or held, an empty draft's placeholder says so, and
    // the words can only go in where it starts.
    if (!at || (at.phase !== "live" && !at.afterPreview && view.state.doc.length === 0)) {
      this.decorations = Decoration.none;
      this.covers = false;
      this.apart = false;
      return;
    }
    const main = view.state.selection.main;
    // A caret where a preview begins is the dictation's own, carried along by
    // the words it writes: the meter past the preview stands for it.
    this.covers = view.hasFocus && main.empty && main.head === at.pos;
    this.apart = view.hasFocus && !this.covers;
    this.decorations = Decoration.set(
      Decoration.widget({
        widget: CARET_WIDGETS[at.phase],
        side: at.afterPreview ? 2 : -1,
      }).range(at.pos)
    );
  }
}

const voiceCaretPlugin = ViewPlugin.fromClass(VoiceCaretView, {
  decorations: (v) => v.decorations,
  eventHandlers: {
    compositionend(_event, view) {
      this.compositionEnded(view);
    },
  },
});

const voiceCaretAttributes = EditorView.editorAttributes.of((view) => {
  const plugin = view.plugin(voiceCaretPlugin);
  if (plugin?.covers) return { "data-voice-caret-covers": "" };
  if (plugin?.apart) return { "data-voice-caret-apart": "" };
  return null;
});

export const voiceCaret: Extension = [voiceCaretField, voiceCaretPlugin, voiceCaretAttributes];
