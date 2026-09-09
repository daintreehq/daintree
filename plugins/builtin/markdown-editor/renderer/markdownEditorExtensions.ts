import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from "@codemirror/view";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches, gotoLine } from "@codemirror/search";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxTree,
  type LanguageSupport,
} from "@codemirror/language";
import { markdownKeymap } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import {
  editorSearchHighlightTheme,
  editorSearchPanelTheme,
} from "@/components/FileViewer/editorSearchTheme";
import {
  getDaintreeEditorTheme,
  type EditorThemePolarity,
} from "@/components/FileViewer/editorTheme";

/**
 * The CodeMirror configuration for the Markdown editor (#12323). Read-only
 * Source mode and this editor share the language, the theme and the search
 * chrome; this file adds what an editable buffer needs — history, the
 * Markdown keymap, the save binding, IME-aware change reporting, and
 * Mod+click link following.
 *
 * Precedence: the save handler first, so `Mod-s` never reaches another panel;
 * then search, Markdown, history, and the defaults.
 */
export interface MarkdownEditorCallbacks {
  /** The buffer changed by typing (never during an IME composition). */
  onChange: (text: string) => void;
  onSave: () => void;
  /** Mod+click on a link's destination text. */
  onFollowLink: (href: string) => void;
}

export const wrapCompartment = new Compartment();
export const themeCompartment = new Compartment();

/** Walk up from the click position to the nearest link node and read its target. */
export function linkTargetAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") {
      return view.state.sliceDoc(node.from, node.to);
    }
    if (node.name === "Link" || node.name === "Image") {
      const url = node.getChild("URL");
      return url ? view.state.sliceDoc(url.from, url.to) : null;
    }
    if (node.name === "Autolink") {
      // `<https://example.com>` — the angle brackets are marks, the text between is the URL.
      const text = view.state.sliceDoc(node.from, node.to);
      return text.replace(/^<|>$/g, "");
    }
    node = node.parent;
  }
  return null;
}

export function buildMarkdownEditorExtensions(options: {
  language: LanguageSupport;
  polarity: EditorThemePolarity;
  wrapLines: boolean;
  ariaLabel: string;
  callbacks: MarkdownEditorCallbacks;
}): Extension[] {
  const { language, polarity, wrapLines, ariaLabel, callbacks } = options;
  return [
    // Save is a DOM-level handler rather than a keymap entry: a keymap that
    // runs preventDefaults but lets the event bubble, and the panel around
    // this editor must never see a Mod-s the editor already consumed. The
    // shifted variant is swallowed too, so a Save As habit from another app
    // does not leak a stray keystroke anywhere.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => {
          if (
            event.key.toLowerCase() !== "s" ||
            !(event.metaKey || event.ctrlKey) ||
            event.altKey
          ) {
            return false;
          }
          event.preventDefault();
          event.stopPropagation();
          if (!event.shiftKey) callbacks.onSave();
          return true;
        },
      })
    ),
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([
      ...searchKeymap,
      ...markdownKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...defaultKeymap,
      // Tab stays keyboard navigation, as CodeMirror ships it: an editor in a
      // grid of panels must not trap focus.
      { key: "Mod-l", run: gotoLine },
    ]),
    language,
    wrapCompartment.of(wrapLines ? EditorView.lineWrapping : []),
    themeCompartment.of(getDaintreeEditorTheme(polarity)),
    editorSearchPanelTheme,
    editorSearchHighlightTheme,
    EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "true" }),
    EditorView.updateListener.of((update) => {
      // IME: the buffer is reported once composition ends, never mid-way,
      // so a half-composed sequence is neither persisted nor marked dirty.
      if (!update.docChanged || update.view.composing) return;
      callbacks.onChange(update.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      compositionend: (_event, view) => {
        // The final composition transaction can land in the same update as
        // the composition ending; report the buffer as it now stands.
        callbacks.onChange(view.state.doc.toString());
        return false;
      },
      click: (event, view) => {
        const mod = navigator.platform.toLowerCase().includes("mac")
          ? event.metaKey
          : event.ctrlKey;
        if (!mod || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const href = linkTargetAt(view, pos);
        if (!href) return false;
        event.preventDefault();
        callbacks.onFollowLink(href);
        return true;
      },
    }),
  ];
}
