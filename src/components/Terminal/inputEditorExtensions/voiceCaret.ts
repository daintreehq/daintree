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

/** `at` left out keeps the last one, mapped through edits since. */
export const setVoiceCaret = StateEffect.define<{
  phase: VoiceCaretPhase | null;
  at?: VoiceCaretAt;
}>();

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
 * Draws where dictation will write, focused or not, without blinking. A
 * zero-advance widget, so the text around it doesn't move, and past the grey
 * preview while one shows (the preview's side is 1). When the editor's own
 * caret sits at the same spot it steps aside, so there is one caret, not two.
 */
class VoiceCaretView {
  decorations: DecorationSet = Decoration.none;
  // Matches `caretTracker`: a composer never focused has a caret at 0 nobody chose.
  private everFocused: boolean;
  covers = false;

  constructor(view: EditorView) {
    this.everFocused = view.hasFocus;
    this.compute(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.hasFocus) this.everFocused = true;
    this.compute(update.view);
  }

  private compute(view: EditorView): void {
    const at = view.composing ? null : voiceCaretPosition(view.state, this.everFocused);
    if (!at) {
      this.decorations = Decoration.none;
      this.covers = false;
      return;
    }
    const main = view.state.selection.main;
    this.covers = view.hasFocus && main.empty && main.head === at.pos;
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
});

const voiceCaretAttributes = EditorView.editorAttributes.of((view) =>
  view.plugin(voiceCaretPlugin)?.covers ? { "data-voice-caret-covers": "" } : null
);

export const voiceCaret: Extension = [voiceCaretField, voiceCaretPlugin, voiceCaretAttributes];
