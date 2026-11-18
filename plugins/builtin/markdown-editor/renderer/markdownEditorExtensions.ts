import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
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
import { utf8ByteLength } from "@shared/utils/folderUpload";
import type { MarkdownTargets } from "@/components/Markdown/markdownHeadingTargets";
import {
  editorSearchHighlightTheme,
  editorSearchPanelTheme,
} from "@/components/FileViewer/editorSearchTheme";
import { createEditorSearchPanel } from "@/components/FileViewer/editorSearchPanel";
import { closeUndoOrdering } from "@/components/Terminal/inputEditorExtensions/closeUndoOrdering";
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
  /**
   * The buffer changed by typing: never during an IME composition, never for
   * a change {@link externalChange} marks. The document, not its text: making
   * the string is the receiver's call (#17071).
   */
  onChange: (doc: Text) => void;
  onSave: () => void;
  /**
   * Mod+click on a link's destination text. A same-document link (`#risks`)
   * never comes here: the editor follows it to the heading itself.
   */
  onFollowLink: (href: string) => void;
}

/** Marks a change that brings the buffer up to the shared document, so it isn't reported back. */
export const externalChange = Annotation.define<true>();

export const wrapCompartment = new Compartment();
export const themeCompartment = new Compartment();

function rangeUtf8Bytes(doc: Text, from: number, to: number): number {
  let bytes = 0;
  // Chunks break only at line breaks, which never split a surrogate pair.
  for (const iter = doc.iterRange(from, to); !iter.next().done;) {
    bytes += utf8ByteLength(iter.value);
  }
  return bytes;
}

/**
 * UTF-8 bytes in the buffer's `\n`-joined text, carried from change to change
 * so the status line never re-encodes the document per keystroke (#17071).
 * Each change is measured with one code unit of unchanged context either side:
 * a pair split or joined at a change's edge then counts as what it became.
 */
export const docUtf8Bytes = StateField.define<number>({
  create: (state) => rangeUtf8Bytes(state.doc, 0, state.doc.length),
  update: (bytes, tr) => {
    if (!tr.docChanged) return bytes;
    const before = tr.startState.doc;
    let next = bytes;
    tr.changes.iterChanges((fromA, toA, fromB, toB) => {
      const lead = fromA > 0 ? 1 : 0;
      const trail = toA < before.length ? 1 : 0;
      next +=
        rangeUtf8Bytes(tr.newDoc, fromB - lead, toB + trail) -
        rangeUtf8Bytes(before, fromA - lead, toA + trail);
    });
    return next;
  },
});

/**
 * Where the buffer's same-document links land, parsed on the first link
 * followed in a document version and kept for the next ones: an edit clears
 * it, and so does closing the editor (#17788).
 */
class FragmentTargets {
  private slot: { doc: Text; targets: MarkdownTargets } | null = null;

  for(doc: Text, build: (source: string) => MarkdownTargets): MarkdownTargets {
    if (this.slot?.doc !== doc) this.slot = { doc, targets: build(doc.toString()) };
    return this.slot.targets;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.slot = null;
  }

  destroy(): void {
    this.slot = null;
  }
}

const fragmentTargets = ViewPlugin.fromClass(FragmentTargets);

/**
 * Mod+click on `[Risks](#risks)`: the caret goes to the line the rendered
 * document would scroll to. The parser that resolves it loads on the first
 * such link, not with the editor, and reads the buffer as it stands then.
 */
export async function followHeadingLink(view: EditorView, href: string): Promise<void> {
  const selection = view.state.selection;
  const { markdownTargets } = await import("@/components/Markdown/markdownHeadingTargets");
  // Closed or replaced by a reload while the parser loaded, or the reader has
  // moved on: a late jump must not take the caret, or focus, back from them.
  if (!view.dom.isConnected || !view.hasFocus || !view.state.selection.eq(selection)) return;
  if (href === "#") return;
  const doc = view.state.doc;
  const cache = view.plugin(fragmentTargets);
  const targets = cache ? cache.for(doc, markdownTargets) : markdownTargets(doc.toString());
  const line = targets.lineOf(href);
  if (line === null || line > doc.lines) return;
  const position = doc.line(line).from;
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "start" }),
    userEvent: "select",
  });
}

/** A link destination without the `<…>` CommonMark allows around it, which the URL node keeps. */
function destination(view: EditorView, url: SyntaxNode): string {
  return view.state.sliceDoc(url.from, url.to).replace(/^<([\s\S]*)>$/, "$1");
}

/** Walk up from the click position to the nearest link node and read its target. */
export function linkTargetAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") {
      return destination(view, node);
    }
    if (node.name === "Link" || node.name === "Image") {
      const url = node.getChild("URL");
      return url ? destination(view, url) : null;
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
  /**
   * The height of chrome pinned over the document's top edge as it scrolls
   * (the view's sticky strip). With the open top panels' own height it is the
   * scroll margin, so the cursor and search matches never land beneath either.
   */
  pinnedTopInset?: () => number;
}): Extension[] {
  const { language, polarity, wrapLines, ariaLabel, callbacks, pinnedTopInset } = options;
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
    docUtf8Bytes,
    fragmentTargets,
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    // Typing newer than a panel close undoes before Cmd+Z reopens the panel (#17180).
    closeUndoOrdering(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true, createPanel: createEditorSearchPanel }),
    pinnedTopInset
      ? EditorView.scrollMargins.of((view) => ({
          // CodeMirror's own margin for a docked panel measures from the
          // window's top, not from the pane that scrolls here.
          top:
            pinnedTopInset() +
            (view.dom.querySelector<HTMLElement>(".cm-panels-top")?.offsetHeight ?? 0),
        }))
      : [],
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
      if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(externalChange)))
        return;
      callbacks.onChange(update.state.doc);
    }),
    EditorView.domEventHandlers({
      compositionend: (_event, view) => {
        // The final composition transaction can land in the same update as
        // the composition ending; report the buffer as it now stands.
        callbacks.onChange(view.state.doc);
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
        if (href.startsWith("#")) void followHeadingLink(view, href);
        else callbacks.onFollowLink(href);
        return true;
      },
    }),
  ];
}
