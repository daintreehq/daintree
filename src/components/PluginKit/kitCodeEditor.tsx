import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers as lineNumberGutter,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  type LanguageSupport,
} from "@codemirror/language";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import type { PluginCodeEditorHandle } from "@shared/types/plugin-sdk-react";
import {
  CODEMIRROR_LANGUAGES,
  loadMarkdownSupport,
} from "@/components/FileViewer/codeMirrorLanguages";
import { createEditorSearchPanel } from "@/components/FileViewer/editorSearchPanel";
import {
  editorSearchHighlightTheme,
  editorSearchPanelTheme,
} from "@/components/FileViewer/editorSearchTheme";
import { getDaintreeEditorTheme } from "@/components/FileViewer/editorTheme";
import { useDaintreeTheme } from "@/pluginUi/theme";

// The kit CodeEditor's CodeMirror half, in its own chunk so the editor and its
// vendor code load on the first CodeEditor a view renders, never with the kit.
// Everything it draws is the file viewer's and the Markdown editor's: the same
// theme, search panel, gutters and keymaps, only made editable and controlled.

export interface KitCodeEditorImplProps {
  value: string | undefined;
  defaultValue: string;
  onChange: ((value: string) => void) | undefined;
  onSave: ((value: string) => void) | undefined;
  language: string | undefined;
  readOnly: boolean;
  lineNumbers: boolean;
  wrap: boolean;
  placeholder: string | undefined;
  autoFocus: boolean;
  ariaLabel: string | undefined;
  handleRef: Ref<PluginCodeEditorHandle> | undefined;
}

/** Marks a transaction that brings the buffer in line with a new `value`, so it is not echoed back. */
const syncFromProps = Annotation.define<boolean>();

/** A language name, alias or extension resolved against the viewer's registry. */
export function findLanguage(name: string): LanguageDescription | null {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  return (
    LanguageDescription.matchLanguageName(CODEMIRROR_LANGUAGES, trimmed, false) ??
    LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, `file.${trimmed.toLowerCase()}`) ??
    LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, trimmed) ??
    null
  );
}

function loadLanguage(name: string): Promise<LanguageSupport | null> {
  const description = findLanguage(name);
  if (!description) return Promise.resolve(null);
  // Markdown takes the one configuration every host surface shares (GFM,
  // highlighted fences, nothing rewritten on paste).
  if (description.name === "Markdown") return loadMarkdownSupport();
  return description.load();
}

// The file viewer's gutter: numbers, fold markers, and the caret's line
// lifted in the gutter as @uiw's basic setup draws it there.
function gutterExtensions(): Extension {
  return [lineNumberGutter(), foldGutter(), highlightActiveLineGutter()];
}

function readOnlyExtensions(readOnly: boolean): Extension {
  return readOnly
    ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-readonly": "true" })]
    : [];
}

// The focus ring is the kit frame's (outline on the editor's box), so
// CodeMirror's own dotted outline would be a second one.
const focusTheme = EditorView.theme({
  "&.cm-focused": { outline: "none" },
});

export default function KitCodeEditorImpl({
  value,
  defaultValue,
  onChange,
  onSave,
  language,
  readOnly,
  lineNumbers,
  wrap,
  placeholder,
  autoFocus,
  ariaLabel,
  handleRef,
}: KitCodeEditorImplProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const polarity = useDaintreeTheme().colorMode;
  const compartments = useRef({
    language: new Compartment(),
    theme: new Compartment(),
    wrap: new Compartment(),
    gutter: new Compartment(),
    readOnly: new Compartment(),
    placeholder: new Compartment(),
    label: new Compartment(),
  });
  // Read at event time, so a new callback never rebuilds the editor.
  const live = useRef({ onChange, onSave });
  useEffect(() => {
    live.current = { onChange, onSave };
  }, [onChange, onSave]);
  // What the editor was created with. The effects below reconfigure each of
  // these in place, so the creation effect runs once per mount.
  const initial = useRef({
    text: value ?? defaultValue,
    polarity,
    wrap,
    lineNumbers,
    readOnly,
    placeholder,
    ariaLabel,
    autoFocus,
  });

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => viewRef.current?.focus(),
      openSearch: () => {
        if (viewRef.current) openSearchPanel(viewRef.current);
      },
    }),
    []
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const start = initial.current;
    const parts = compartments.current;
    let destroyed = false;
    // The text last handed to onChange (or set through `value`), so nothing
    // is reported twice and an unchanged buffer is never reported at all.
    let reported = start.text;
    const report = (text: string) => {
      if (text === reported) return;
      reported = text;
      live.current.onChange?.(text);
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: start.text,
        extensions: [
          // A DOM handler rather than a keymap entry, as in the Markdown
          // editor: the key must stop here, never reaching the panel around
          // the view. Only claimed when the view listens for it.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (event, target) => {
                const save = live.current.onSave;
                if (!save || event.key.toLowerCase() !== "s") return false;
                if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
                event.preventDefault();
                event.stopPropagation();
                if (!event.shiftKey) save(target.state.doc.toString());
                return true;
              },
            })
          ),
          parts.gutter.of(start.lineNumbers ? gutterExtensions() : []),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true, createPanel: createEditorSearchPanel }),
          keymap.of([
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...defaultKeymap,
            // Tab stays keyboard navigation, as in every host editor: an
            // editor inside a pane must not trap focus.
            { key: "Mod-l", run: gotoLine },
          ]),
          parts.language.of([]),
          parts.wrap.of(start.wrap ? EditorView.lineWrapping : []),
          parts.theme.of(getDaintreeEditorTheme(start.polarity)),
          parts.readOnly.of(readOnlyExtensions(start.readOnly)),
          parts.placeholder.of(start.placeholder ? placeholderExtension(start.placeholder) : []),
          parts.label.of(
            EditorView.contentAttributes.of(
              start.ariaLabel ? { "aria-label": start.ariaLabel } : {}
            )
          ),
          editorSearchPanelTheme,
          editorSearchHighlightTheme,
          focusTheme,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.every((tr) => tr.annotation(syncFromProps) === true)) {
              reported = update.state.doc.toString();
              return;
            }
            // IME: reported once composition ends, never half-composed.
            if (update.view.composing) return;
            report(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            compositionend: (_event, target) => {
              // CodeMirror flushes the composition's last DOM change after
              // this event, and that transaction can land while it still
              // reads as composing: report once it has, and only if the
              // text moved (a cancelled composition changes nothing).
              setTimeout(() => {
                if (!destroyed) report(target.state.doc.toString());
              }, 0);
              return false;
            },
          }),
        ],
      }),
    });
    // As CodeMirror holds it: a CRLF starting text reads as LF from here on.
    reported = view.state.doc.toString();
    viewRef.current = view;
    if (start.autoFocus) view.focus();
    // The app's Cmd+F reaches a focused pane as an event, not a keystroke;
    // while this editor has the keyboard, it is this editor's find.
    const onFind = () => {
      if (view.hasFocus) openSearchPanel(view);
    };
    window.addEventListener("daintree:find-in-panel", onFind);
    return () => {
      destroyed = true;
      window.removeEventListener("daintree:find-in-panel", onFind);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === undefined) return;
    const doc = view.state.doc;
    // Compared and clamped as CodeMirror holds the text: it reads CRLF as one
    // line break, so the string's own length can run past the document's.
    const next = view.state.toText(value);
    if (doc.eq(next)) return;
    // Selection kept where it still fits, so an echo of a formatter or a
    // revert does not throw the caret to the start.
    const { anchor, head } = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: next },
      selection: { anchor: Math.min(anchor, next.length), head: Math.min(head, next.length) },
      annotations: syncFromProps.of(true),
    });
  }, [value]);

  useEffect(() => {
    if (!language) {
      viewRef.current?.dispatch({ effects: compartments.current.language.reconfigure([]) });
      return;
    }
    let cancelled = false;
    // Plain text until the grammar lands, and on a grammar that fails to load.
    loadLanguage(language)
      .then((support) => {
        if (cancelled) return;
        viewRef.current?.dispatch({
          effects: compartments.current.language.reconfigure(support ?? []),
        });
      })
      .catch(() => {
        if (!cancelled) {
          viewRef.current?.dispatch({ effects: compartments.current.language.reconfigure([]) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.theme.reconfigure(getDaintreeEditorTheme(polarity)),
    });
  }, [polarity]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.gutter.reconfigure(lineNumbers ? gutterExtensions() : []),
    });
  }, [lineNumbers]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure(readOnlyExtensions(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.placeholder.reconfigure(
        placeholder ? placeholderExtension(placeholder) : []
      ),
    });
  }, [placeholder]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.label.reconfigure(
        EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {})
      ),
    });
  }, [ariaLabel]);

  return (
    <div ref={hostRef} data-kit-code-editor-host="" className="flex min-h-0 flex-1 flex-col" />
  );
}
