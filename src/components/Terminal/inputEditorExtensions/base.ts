import { EditorView, Decoration, WidgetType, keymap, placeholder } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type { ChangeDesc, EditorSelection, Extension, Range } from "@codemirror/state";
import { StateField, StateEffect, Prec } from "@codemirror/state";
import { insertNewline } from "@codemirror/commands";
import type { ITheme } from "@xterm/xterm";
import { resolveInputBarColors } from "@/utils/terminalTheme";
import {
  DURATION_100,
  UI_ANIMATION_DURATION,
  UI_PALETTE_ENTER_DURATION,
  EASE_OUT_EXPO,
} from "@/lib/animationUtils";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";

const MAX_TEXTAREA_HEIGHT_PX = 160;
const LINE_HEIGHT_PX = 20;

const X_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

export const TERMINAL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>`;

const INLINE_CHIP_BASE = {
  display: "inline-flex",
  alignItems: "center",
  // minHeight, not height: a wrapped label has to grow the pill rather than
  // spill out of its painted background. Single-line chips still land on 20px.
  minHeight: "20px",
  // top, not bottom: a wrapped pill is taller than the line box, and adjacent
  // text should sit on its first row rather than its last. Identical for
  // single-line chips, whose height already equals the line box.
  verticalAlign: "top",
  whiteSpace: "nowrap",
  gap: "4px",
  padding: "0 5px",
  fontWeight: 600,
  borderRadius: "var(--radius-xs)",
} as const;

const CHIP_SVG_SIZE = {
  height: "14px",
  width: "14px",
  flexShrink: "0",
} as const;

/** The live dictation caret's meter follows the mic level through this property, 0 to 1. */
export const VOICE_CARET_LEVEL_PROPERTY = "--cm-voice-caret-level";

export function buildInputBarTheme(theme: ITheme): Extension {
  const c = resolveInputBarColors(theme);

  const chipStyle = {
    ...INLINE_CHIP_BASE,
    color: c.accent,
    background: `color-mix(in oklab, ${c.chipColor} 10%, transparent)`,
  };

  return EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        height: "auto",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-content": {
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "var(--text-xs)",
        lineHeight: "20px",
        padding: "0 4px 0 0",
        caretColor: c.accent,
      },
      "&.cm-focused .cm-cursor": {
        borderLeft: `2px solid ${c.accent}`,
      },
      "& .cm-selectionBackground": {
        backgroundColor: `color-mix(in oklab, ${c.accent} 25%, transparent) !important`,
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: `color-mix(in oklab, ${c.accent} 45%, transparent) !important`,
      },
      ".cm-dropCursor": {
        borderLeftColor: c.accent,
      },
      // The shell sets `--ib-placeholder` per state; the expanded editor
      // portals out of the shell and takes the resting ink.
      ".cm-placeholder": {
        color: `var(--ib-placeholder, ${c.placeholder})`,
      },
      ".cm-scroller": {
        overflow: "hidden",
      },
      ".cm-line": {
        padding: "0",
      },
      ".cm-slash-command-chip": {
        // inline-block (not the default inline) so the chip-enter transform
        // applies — non-replaced inline elements aren't transformable.
        display: "inline-block",
        fontWeight: 600,
        color: c.chipColor,
        textDecoration: "underline dotted 1px",
        textUnderlineOffset: "2px",
      },
      ".cm-slash-command-chip-invalid": {
        color: c.errorColor,
        textDecoration: "underline wavy 1px",
        textUnderlineOffset: "2px",
      },
      ".cm-file-chip": {
        display: "inline-block",
        fontWeight: 600,
        color: c.chipColor,
        textDecoration: "underline dotted 1px",
        textUnderlineOffset: "2px",
        // The full path stays visible and wraps: truncating hid the tail, so two
        // out-of-tree files could render identically. `break-spaces` (not
        // `normal`) because quoted tokens can carry runs of spaces that
        // `normal` would collapse — the same indistinguishable-paths bug by
        // another route. `anywhere` (not `break-word`) zeroes min-content, so
        // the chip shrinks in narrow panes instead of blowing them out.
        whiteSpace: "break-spaces",
        overflowWrap: "anywhere",
        verticalAlign: "top",
      },
      // A `#N` that names an issue or pull request: still text the caret walks
      // through, so weight and a quiet underline set it apart, not a chip's ink.
      ".cm-forge-ref": {
        fontWeight: 600,
        textDecorationLine: "underline",
        textDecorationThickness: "1px",
        textDecorationColor: "color-mix(in oklab, currentColor 45%, transparent)",
        textUnderlineOffset: "3px",
      },
      ".cm-chip-label": {
        whiteSpace: "break-spaces",
        overflowWrap: "anywhere",
        minWidth: "0",
      },
      ".cm-tooltip": {
        background: "transparent",
        border: "none",
        boxShadow: "none",
      },
      ".cm-tooltip-hover": {
        background: "transparent",
        border: "none",
        boxShadow: "none",
      },
      ".cm-image-chip": {
        ...chipStyle,
      },
      ".cm-image-chip img": {
        height: "16px",
        width: "16px",
        objectFit: "cover",
        borderRadius: "var(--radius-xs)",
        flexShrink: "0",
      },
      ".cm-file-drop-chip": {
        ...chipStyle,
      },
      ".cm-file-drop-chip svg": CHIP_SVG_SIZE,
      // Visible at rest in a quiet ink rather than revealed on hover: the
      // chip pays for the slot either way, and an affordance that appears only
      // under the pointer is one most people never find. Opaque mixes over the
      // shell, because the composer keeps a terminal's polarity under a light
      // app theme and app tokens would land dark-on-dark here.
      ".cm-chip-remove": {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "16px",
        height: "16px",
        marginRight: "-3px",
        borderRadius: "var(--radius-xs)",
        color: `color-mix(in oklab, ${c.foreground} 55%, ${c.shellBg})`,
        cursor: "pointer",
        flexShrink: "0",
        transition: `color ${UI_ANIMATION_DURATION}ms ease-out, background-color ${UI_ANIMATION_DURATION}ms ease-out`,
      },
      // The 24px row-control floor (ROW_CONTROL_CLASS) without growing the
      // chip past its 20px line.
      ".cm-chip-remove::before": {
        content: '""',
        position: "absolute",
        inset: "-4px",
      },
      ".cm-chip-remove svg": {
        width: "12px",
        height: "12px",
      },
      ".cm-chip-remove:hover, .cm-chip-pending-delete .cm-chip-remove": {
        color: c.foreground,
      },
      ".cm-chip-remove:hover": {
        background: `color-mix(in oklab, ${c.foreground} 14%, ${c.shellBg})`,
      },
      "@media (prefers-reduced-motion: reduce)": {
        ".cm-chip-remove": { transition: "none" },
        // `.cm-content` outranks the live rule further down.
        '.cm-content .cm-voice-caret[data-phase="live"]::after': {
          transform: "none",
          transition: "none",
          opacity: `calc(${c.voiceCaretFloor} + ${1 - c.voiceCaretFloor} * var(${VOICE_CARET_LEVEL_PROPERTY}, 1))`,
        },
      },
      ".cm-diff-chip": {
        ...chipStyle,
      },
      ".cm-diff-chip svg": CHIP_SVG_SIZE,
      ".cm-terminal-chip": {
        ...chipStyle,
      },
      ".cm-terminal-chip svg": CHIP_SVG_SIZE,
      ".cm-selection-chip": {
        ...chipStyle,
      },
      ".cm-selection-chip svg": CHIP_SVG_SIZE,
      ".cm-context-chip": {
        ...chipStyle,
      },
      ".cm-context-chip svg": CHIP_SVG_SIZE,
      // The plugin the content comes from, a step quieter than the item itself.
      ".cm-context-chip-source": {
        color: `color-mix(in oklab, ${c.foreground} 60%, ${c.shellBg})`,
      },
      ".cm-context-chip-label": {
        maxWidth: "28ch",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      // Opaque, so the label keeps its resting contrast at the one moment the
      // user has to confirm which chip is about to go; the contour sits inside
      // the box so the staged chip keeps its geometry.
      ".cm-chip-pending-delete": {
        background: `color-mix(in oklab, ${c.foreground} 16%, ${c.shellBg})`,
        outline: `1px solid color-mix(in oklab, ${c.foreground} 55%, ${c.shellBg})`,
        outlineOffset: "-1px",
      },
      "&.cm-chip-staging .cm-selectionBackground": {
        background: "transparent !important",
      },
      // Italic is what sets words not yet written apart from the draft, so it
      // can't rest on colour alone. The mono face ships no italic and the app
      // turns synthesis off, so the ghost asks for a slanted regular. A
      // streamed cleanup is the same until it lands: its reply is judged only
      // once whole and lands with every passage of its pass, so what streams
      // in may yet be turned down. A slant keeps a mono face's advances, so
      // nothing moves as it lands. The shell sets `--ib-interim`; the expanded
      // editor portals out of it onto the dialog, whose draft takes the app's
      // ink, so its provisional words step down that ink instead.
      ".cm-voice-interim, .cm-voice-rewrite": {
        color: "var(--ib-interim, var(--color-text-secondary))",
        fontStyle: "italic",
        fontSynthesis: "style",
      },
      ".cm-voice-pending-ai": {
        textDecorationLine: "underline",
        textDecorationStyle: "dotted",
        textDecorationColor: `color-mix(in oklab, ${c.successColor} 82%, transparent)`,
        textDecorationThickness: "2px",
        textUnderlineOffset: "3px",
        transition: `text-decoration-color ${UI_ANIMATION_DURATION}ms ease-out`,
      },
      // The pending underline's hue, drawn solid once the correction has
      // landed, and only under what it changed.
      ".cm-voice-corrected": {
        textDecorationLine: "underline",
        textDecorationStyle: "solid",
        textDecorationColor: `color-mix(in oklab, ${c.successColor} 82%, transparent)`,
        textDecorationThickness: "2px",
        textUnderlineOffset: "3px",
      },
      // Words dropped with nothing written in their place: a caret pointing up
      // at the gap they left, in the underline's hue. A flat stroke there read
      // as an underscore joining the words. Zero-width, so the text around it
      // does not move; drawn with borders, which forced colours keep.
      ".cm-voice-corrected-gap": {
        display: "inline-block",
        position: "relative",
        width: "0",
        height: "0",
      },
      ".cm-voice-corrected-gap::after": {
        content: '""',
        position: "absolute",
        top: "5px",
        left: "calc(0.5ch - 3px)",
        width: "6px",
        height: "6px",
        boxSizing: "border-box",
        borderLeft: `2px solid color-mix(in oklab, ${c.successColor} 82%, transparent)`,
        borderTop: `2px solid color-mix(in oklab, ${c.successColor} 82%, transparent)`,
        transform: "rotate(45deg)",
      },
      '.cm-voice-corrected-gap[data-side="before"]::after': {
        left: "calc(-0.5ch - 3px)",
      },
      "@media (prefers-contrast: more)": {
        ".cm-voice-pending-ai, .cm-voice-corrected": {
          textDecorationColor: c.successColor,
        },
        ".cm-voice-corrected-gap::after": {
          borderColor: c.successColor,
        },
      },
      // Where dictation writes (`voiceCaret`): a thin level meter set a gap
      // past the text, so it reads as the mic and never as the keyboard's
      // caret. A quiet track holds the place in every phase; the fill is the
      // voice, rising with it while live, empty while the mic comes up, and a
      // still neutral stub while the session holds. Reduced motion keeps the
      // fill full and lets only its opacity follow the voice.
      ".cm-voice-caret": {
        position: "relative",
        paddingLeft: "11px",
        pointerEvents: "none",
      },
      ".cm-voice-caret::before, .cm-voice-caret::after": {
        content: '""',
        position: "absolute",
        top: "1px",
        bottom: "1px",
        left: "6px",
        width: "3px",
        borderRadius: "1px",
      },
      ".cm-voice-caret::before": {
        // The expanded editor portals outside the shell that sets `--ib-fg`.
        backgroundColor: "color-mix(in oklab, var(--ib-fg, currentColor) 16%, transparent)",
      },
      ".cm-voice-caret::after": {
        backgroundColor: c.voiceSignal,
        transformOrigin: "bottom",
        transform: "scaleY(0)",
      },
      '.cm-voice-caret[data-phase="held"]::after': {
        backgroundColor: c.voiceHeld,
        transform: "scaleY(0.25)",
      },
      // The level comes in raw, about once a frame; the transition is what
      // smooths it, so the meter moves with the voice rather than flickers.
      '.cm-voice-caret[data-phase="live"]::after': {
        transform: `scaleY(max(0.12, var(${VOICE_CARET_LEVEL_PROPERTY}, 1)))`,
        transition: `transform ${DURATION_100}ms linear`,
      },
      'body[data-reduce-animations="true"] & .cm-voice-caret[data-phase="live"]::after, body[data-performance-mode="true"] & .cm-voice-caret[data-phase="live"]::after':
        {
          transform: "none",
          transition: "none",
          opacity: `calc(${c.voiceCaretFloor} + ${1 - c.voiceCaretFloor} * var(${VOICE_CARET_LEVEL_PROPERTY}, 1))`,
        },
      "&[data-voice-caret-covers] .cm-cursorLayer": {
        visibility: "hidden",
      },
      // System inks replace author backgrounds, so the meter is borders: a
      // CanvasText outline, filled in Highlight live and GrayText held.
      "@media (forced-colors: active)": {
        ".cm-voice-caret::before, .cm-voice-caret::after": { background: "none" },
        ".cm-voice-caret::before": { border: "1px solid CanvasText", width: "1px" },
        ".cm-voice-caret::after": { width: "0", borderLeft: "3px solid Highlight" },
        '.cm-voice-caret[data-phase="held"]::after': { borderLeftColor: "GrayText" },
      },
    },
    { dark: true }
  );
}

const CHIP_CLASSES = [
  ".cm-file-chip",
  ".cm-slash-command-chip",
  ".cm-image-chip",
  ".cm-file-drop-chip",
  ".cm-diff-chip",
  ".cm-terminal-chip",
  ".cm-selection-chip",
  ".cm-context-chip",
];

const CHIP_ANIMATION = `chip-enter ${UI_PALETTE_ENTER_DURATION}ms ${EASE_OUT_EXPO} both`;
const CHIP_REDUCED_ANIMATION = `chip-fade ${UI_PALETTE_ENTER_DURATION}ms ${EASE_OUT_EXPO} both`;

// Lives outside the swappable buildInputBarTheme compartment so terminal
// color-scheme changes don't re-inject @keyframes and re-trigger the entrance
// animation on already-rendered chips.
export const chipEntranceTheme: Extension = EditorView.baseTheme({
  "@keyframes chip-enter": {
    from: { opacity: "0", transform: "translateY(2px)" },
    to: { opacity: "1", transform: "translateY(0)" },
  },
  ...Object.fromEntries(CHIP_CLASSES.map((cls) => [cls, { animation: CHIP_ANIMATION }])),
  "@keyframes chip-fade": {
    from: { opacity: "0" },
    to: { opacity: "1" },
  },
  // The OS-level prefers-reduced-motion and the Daintree-level "Reduce UI
  // animations" toggle (body[data-reduce-animations]) keep the fade and drop
  // the 2px rise. WCAG 2.3.3.
  "@media (prefers-reduced-motion: reduce)": Object.fromEntries(
    CHIP_CLASSES.map((cls) => [cls, { animation: CHIP_REDUCED_ANIMATION }])
  ),
  ...Object.fromEntries(
    CHIP_CLASSES.map((cls) => [
      `body[data-reduce-animations="true"] ${cls}`,
      { animation: CHIP_REDUCED_ANIMATION },
    ])
  ),
});

class InterimGhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: InterimGhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-voice-interim";
    span.textContent = this.text;
    span.style.userSelect = "none";
    span.style.pointerEvents = "none";
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The dictation preview: its text, and where it shows. A null position puts
 * it at the end of the draft; any other follows edits around it until the next
 * preview replaces it.
 */
export interface InterimPreview {
  text: string;
  pos: number | null;
}

const NO_PREVIEW: InterimPreview = { text: "", pos: null };

export const setInterimText = StateEffect.define<string | InterimPreview>();

export const interimWidgetField = StateField.define<InterimPreview>({
  create() {
    return NO_PREVIEW;
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.pos !== null) {
      const pos = tr.changes.mapPos(next.pos, 1);
      if (pos !== next.pos) next = { ...next, pos };
    }
    for (const effect of tr.effects) {
      if (effect.is(setInterimText)) {
        const preview =
          typeof effect.value === "string" ? { text: effect.value, pos: null } : effect.value;
        next =
          preview.text === next.text && preview.pos === next.pos
            ? next
            : preview.text
              ? preview
              : NO_PREVIEW;
      }
    }
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f, ({ text, pos }) => (view) => {
      // Suppress the ghost during IME composition so it can't displace the
      // composition overlay (mirrors the xterm guard added for #4379).
      if (!text || view.composing) return Decoration.none;
      const at = pos === null ? view.state.doc.length : Math.min(pos, view.state.doc.length);
      return Decoration.set([
        Decoration.widget({ widget: new InterimGhostWidget(text), side: 1 }).range(at),
      ]);
    }),
    // The doc stays empty while dictation is interim, so CodeMirror's own
    // placeholder is still mounted and the ghost renders right after it
    // ("Ask Claude" followed by the transcript). Flag the content element so
    // the placeholder can be hidden for as long as ghost text is showing.
    EditorView.contentAttributes.from(f, ({ text }): Record<string, string> =>
      text ? { class: "cm-voice-interim-active" } : {}
    ),
    EditorView.baseTheme({
      ".cm-voice-interim-active .cm-placeholder": { display: "none" },
    }),
  ],
});

const pendingAIMark = Decoration.mark({ class: "cm-voice-pending-ai" });

// The cleanup streamed so far, drawn over the dictated words it has replaced.
// The draft keeps what was dictated until the whole correction lands.
class CorrectionRewriteWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: CorrectionRewriteWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-voice-rewrite";
    span.textContent = this.text;
    return span;
  }
  // The rewrite grows a stretch at a time; the same node takes each stretch.
  updateDOM(dom: HTMLElement): boolean {
    dom.textContent = this.text;
    return true;
  }
  // A spoken list is laid out on lines of its own.
  get lineBreaks(): number {
    return this.text.split("\n").length - 1;
  }
  // A click lands at the edge of the rewritten words, as on any text.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Whether `changes` edit inside the range, not just at its edges: typing in
 * the dictated words a rewrite hides drops the rewrite in the same
 * transaction, so the keystroke is never hidden under it.
 */
function editsInside(changes: ChangeDesc, from: number, to: number): boolean {
  let inside = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from) inside = true;
  });
  return inside;
}

// A caret or selection end among the words a rewrite hides would sit where
// nothing shows, so those words show as dictated while it's there.
function selectionInside(selection: EditorSelection, from: number, to: number): boolean {
  return selection.ranges.some(
    (range) => (range.head > from && range.head < to) || (range.anchor > from && range.anchor < to)
  );
}

/** The rewrite already shown at `from`, if it still ends clear of the selection. */
function heldRewrite(
  value: DecorationSet,
  from: number,
  to: number,
  selection: EditorSelection
): Range<Decoration> | null {
  let held: Range<Decoration> | null = null;
  value.between(from, from, (start, end, decoration) => {
    if (
      !held &&
      start === from &&
      end <= to &&
      decoration.spec.widget instanceof CorrectionRewriteWidget &&
      !selectionInside(selection, start, end)
    ) {
      held = decoration.range(start, end);
    }
  });
  return held;
}

function revealUnderSelection(value: DecorationSet, selection: EditorSelection): DecorationSet {
  const revealed: Range<Decoration>[] = [];
  value.between(0, Number.MAX_SAFE_INTEGER, (from, to, decoration) => {
    if (
      decoration.spec.widget instanceof CorrectionRewriteWidget &&
      selectionInside(selection, from, to)
    ) {
      revealed.push(pendingAIMark.range(from, to));
    }
  });
  if (revealed.length === 0) return value;
  return value.update({
    filter: (from, to, decoration) =>
      !(decoration.spec.widget instanceof CorrectionRewriteWidget) ||
      !selectionInside(selection, from, to),
    add: revealed,
    sort: true,
  });
}

export interface PendingAIRange {
  from: number;
  to: number;
  /** Show the draft from `from` to `rewrite.to` as `rewrite.text`. */
  rewrite?: { to: number; text: string };
}

export const setPendingAIRanges = StateEffect.define<PendingAIRange[]>();

export const pendingAIField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    if (tr.docChanged) {
      value = value
        .update({
          filter: (from, to, decoration) =>
            !(decoration.spec.widget instanceof CorrectionRewriteWidget) ||
            !editsInside(tr.changes, from, to),
        })
        .map(tr.changes);
    }
    for (const effect of tr.effects) {
      if (effect.is(setPendingAIRanges)) {
        const ranges = effect.value;
        if (ranges.length === 0) return Decoration.none;
        const docLen = tr.state.doc.length;
        const decorations: Range<Decoration>[] = [];
        for (const r of ranges) {
          const from = Math.max(0, r.from);
          const to = Math.min(docLen, r.to);
          if (from >= to) continue;
          let rewriteTo = r.rewrite ? Math.min(to, r.rewrite.to) : from;
          let rewrite: Range<Decoration> | null =
            r.rewrite && rewriteTo > from
              ? Decoration.replace({ widget: new CorrectionRewriteWidget(r.rewrite.text) }).range(
                  from,
                  rewriteTo
                )
              : null;
          // A locked composer draws no caret, so nothing would sit hidden.
          if (
            rewrite &&
            !tr.state.readOnly &&
            selectionInside(tr.state.selection, from, rewriteTo)
          ) {
            // The stream waits at the caret rather than taking back what it
            // already wrote: a rewrite never steps backwards.
            rewrite = heldRewrite(value, from, to, tr.state.selection);
            rewriteTo = rewrite?.to ?? from;
          }
          if (rewrite) decorations.push(rewrite);
          if (rewriteTo < to) decorations.push(pendingAIMark.range(rewriteTo, to));
        }
        return decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none;
      }
    }
    return (tr.selection || tr.docChanged || tr.reconfigured) && !tr.state.readOnly
      ? revealUnderSelection(value, tr.state.selection)
      : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Sent from the editor's element, bubbling, after every autosize measure. The
 * composer shell places its trailing controls from it (`useComposerMeasure`).
 */
export const COMPOSER_GEOMETRY_EVENT = "daintree:composer-geometry";

export interface AutoSizeConfig {
  lineHeightPx?: number;
  maxHeightPx?: number;
}

const EPSILON_PX = 2;

export function computeAutoSize(
  contentHeight: number,
  lineHeightPx: number,
  maxHeightPx: number,
  isEmpty: boolean = false
) {
  if (lineHeightPx <= 0) {
    return { next: maxHeightPx, shouldScroll: false };
  }

  if (isEmpty) {
    return { next: lineHeightPx, shouldScroll: false };
  }

  const adjustedHeight = contentHeight - EPSILON_PX;
  const lines = Math.max(1, Math.ceil(adjustedHeight / lineHeightPx));
  const snapped = lines * lineHeightPx;
  const next = Math.min(snapped, maxHeightPx);
  return { next, shouldScroll: snapped > maxHeightPx };
}

export function createAutoSize(config: AutoSizeConfig = {}) {
  const configLineHeightPx = config.lineHeightPx;
  const maxHeightPx = config.maxHeightPx ?? MAX_TEXTAREA_HEIGHT_PX;
  let lastHeight = 0;
  let lastOverflowY = "";

  return EditorView.updateListener.of((update) => {
    // Interim dictation is an effect-only change to a widget on an otherwise
    // empty doc, so none of the layout flags fire for it (#13103).
    // A streamed cleanup's rewrite is the same: its words can change the
    // passage's line count without touching the doc.
    const interimChanged =
      update.startState.field(interimWidgetField, false) !==
        update.state.field(interimWidgetField, false) ||
      update.startState.field(pendingAIField, false) !== update.state.field(pendingAIField, false);
    if (!update.docChanged && !update.viewportChanged && !update.geometryChanged && !interimChanged)
      return;

    const view = update.view;
    // A cleanup changes its passage's length as it streams; the composer keeps
    // the height it had until the correction lands, scrolling inside it if the
    // rewrite runs longer, so the pane above is resized once rather than a
    // line at a time. Typing, and dictation still arriving, size it as ever.
    const holdHeight =
      lastHeight > 0 &&
      !update.docChanged &&
      (update.state.field(pendingAIField, false)?.size ?? 0) > 0 &&
      !update.state.field(interimWidgetField, false)?.text;

    view.requestMeasure({
      read() {
        const lineHeight =
          configLineHeightPx != null && configLineHeightPx > 0
            ? configLineHeightPx
            : view.defaultLineHeight > 0
              ? view.defaultLineHeight
              : LINE_HEIGHT_PX;
        // Interim dictation renders as a widget while the doc stays empty; it
        // hides the placeholder and has real height, so it counts as content.
        const isEmpty =
          view.state.doc.length === 0 && !view.state.field(interimWidgetField, false)?.text;
        return computeAutoSize(view.contentHeight, lineHeight, maxHeightPx, isEmpty);
      },
      write(measured) {
        const next = holdHeight ? lastHeight : measured.next;
        if (next !== lastHeight) {
          lastHeight = next;
          view.dom.style.height = `${next}px`;
        }

        const overflows = measured.shouldScroll || (holdHeight && measured.next > lastHeight);
        const newOverflowY = overflows ? "auto" : "hidden";
        if (newOverflowY !== lastOverflowY) {
          lastOverflowY = newOverflowY;
          view.scrollDOM.style.overflowY = newOverflowY;
        }

        // The draft's rows are laid out and sized as of this write, so this is
        // the moment the composer shell can read where they end — in the same
        // frame as the text, before it paints.
        view.dom.dispatchEvent(new Event(COMPOSER_GEOMETRY_EVENT, { bubbles: true }));
      },
    });
  });
}

interface CustomKeymapConfig {
  onEnter: () => boolean;
  onModEnter: () => boolean;
  onEscape: () => boolean;
  onArrowUp: () => boolean;
  onArrowDown: () => boolean;
  onArrowLeft: () => boolean;
  onArrowRight: () => boolean;
  onTab: () => boolean;
  onCtrlC: (hasSelection: boolean) => boolean;
  onStash: () => boolean;
  onPopStash: () => boolean;
  onExpand: () => boolean;
  onHistorySearch: () => boolean;
}

export function createCustomKeymap(config: CustomKeymapConfig): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Enter",
        run() {
          return config.onEnter();
        },
      },
      {
        key: "Mod-Enter",
        run() {
          return config.onModEnter();
        },
      },
      {
        key: "Shift-Enter",
        run: insertNewline,
      },
      {
        key: "Alt-Enter",
        run: insertNewline,
      },
      {
        key: "Escape",
        run() {
          return config.onEscape();
        },
      },
      {
        key: "ArrowUp",
        run() {
          return config.onArrowUp();
        },
      },
      {
        key: "ArrowDown",
        run() {
          return config.onArrowDown();
        },
      },
      {
        key: "ArrowLeft",
        run() {
          return config.onArrowLeft();
        },
      },
      {
        key: "ArrowRight",
        run() {
          return config.onArrowRight();
        },
      },
      {
        key: "Tab",
        run() {
          return config.onTab();
        },
      },
      {
        key: "Ctrl-c",
        run(view) {
          const hasSelection = !view.state.selection.main.empty;
          return config.onCtrlC(hasSelection);
        },
      },
      {
        key: "Mod-Shift-s",
        run() {
          return config.onStash();
        },
      },
      {
        key: "Mod-Shift-x",
        run() {
          return config.onPopStash();
        },
      },
      {
        key: "Mod-Shift-e",
        run() {
          return config.onExpand();
        },
      },
      {
        key: "Mod-r",
        run() {
          return config.onHistorySearch();
        },
      },
    ])
  );
}

export function createPlaceholder(text: string): Extension {
  return placeholder(text);
}

export function createContentAttributes(): Extension {
  return EditorView.contentAttributes.of({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    autocomplete: "off",
    // Surface marker: lets fleet-broadcast classify keystrokes that
    // originate inside the agent prompt editor vs the xterm body.
    "data-hybrid-input-editor": "true",
  });
}

export interface ComboboxAttributes {
  listboxId: string;
  expanded: boolean;
  activeOptionId: string | null;
}

/**
 * The editor as the autocomplete menu's combobox: DOM focus never leaves it, so
 * this is how assistive tech learns there is a list and which row the arrows
 * are on. `null` before the composer has a menu to point at.
 */
export function createComboboxAttributes(attrs: ComboboxAttributes | null): Extension {
  if (!attrs) return [];
  const base: Record<string, string> = {
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-haspopup": "listbox",
    "aria-expanded": String(attrs.expanded),
  };
  if (attrs.expanded) base["aria-controls"] = attrs.listboxId;
  if (attrs.expanded && attrs.activeOptionId) {
    base["aria-activedescendant"] = attrs.activeOptionId;
  }
  return EditorView.contentAttributes.of(base);
}

export function createPlainPasteKeymap(): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Mod-Shift-v",
        run(view) {
          navigator.clipboard.readText().then((text) => {
            if (!text) return;
            const { from, to } = view.state.selection.main;
            view.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
            });
          });
          return true;
        },
      },
    ])
  );
}

/**
 * The remove control an attachment chip ends in. Pointer-only by construction,
 * like a `RowControlTooltip` control: the chip is `role="img"`, whose children
 * are presentational, so a button here took a tab stop that assistive tech
 * could not see and that Enter did nothing on. The keyboard route is the
 * chip's own Backspace stage. Removal runs on click, so a press dragged off the
 * control cancels; the press itself is swallowed to keep the editor's focus
 * and selection where they were.
 */
export function createChipRemoveControl(onRemove: () => void): HTMLElement {
  const control = document.createElement("span");
  control.className = "cm-chip-remove";
  control.setAttribute("aria-hidden", "true");
  setTrustedInnerHTML(control, createTrustedHTML(X_ICON_SVG));
  control.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  control.addEventListener("click", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  });
  return control;
}

export function removeChipRange(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc.toString();
  const deleteTo = to < doc.length && doc[to] === " " ? to + 1 : to;
  view.dispatch({ changes: { from, to: deleteTo, insert: "" } });
  view.focus();
}

export function formatChipLabel(filePath: string): string {
  // A host's inbox names a pasted image by its own clock (`clipboard-YYYYMMDD-HHMMSS-…`);
  // this machine's paste uses epoch milliseconds.
  const stamped = filePath.match(/clipboard-\d{8}-(\d{2})(\d{2})\d{2}-/);
  if (stamped) return `Screenshot ${stamped[1]}:${stamped[2]}`;
  const match = filePath.match(/clipboard-(\d+)-/);
  if (match) {
    const date = new Date(Number(match[1]));
    if (!isNaN(date.getTime())) {
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      return `Screenshot ${hh}:${mm}`;
    }
  }
  return "Screenshot";
}
