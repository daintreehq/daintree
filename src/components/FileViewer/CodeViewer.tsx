import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { languages } from "@codemirror/language-data";
import { EditorView, Decoration, type DecorationSet, keymap } from "@codemirror/view";
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { search, openSearchPanel, gotoLine } from "@codemirror/search";
import { canopyTheme } from "@/components/Notes/editorTheme";
import { cn } from "@/lib/utils";

export interface CodeViewerHandle {
  openSearch: () => void;
  openGotoLine: () => void;
}

export interface CodeViewerProps {
  content: string;
  filePath: string;
  initialLine?: number;
  className?: string;
}

const setHighlightedLine = StateEffect.define<number | null>();

const highlightedLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightedLine)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          try {
            const line = tr.state.doc.line(e.value);
            deco = Decoration.set([
              Decoration.line({ class: "cm-highlightedLine" }).range(line.from),
            ]);
          } catch {
            deco = Decoration.none;
          }
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlightLineTheme = EditorView.baseTheme({
  ".cm-highlightedLine": {
    backgroundColor: "rgba(234, 179, 8, 0.1) !important",
  },
});

const searchPanelTheme = EditorView.theme({
  ".cm-panels": {
    backgroundColor: "var(--theme-surface-sidebar)",
    color: "var(--theme-text-primary)",
    borderBottom: "1px solid var(--theme-border-default)",
  },
  ".cm-panel.cm-search": {
    padding: "4px 8px",
  },
  ".cm-search .cm-textfield": {
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "3px",
    outline: "none",
  },
  ".cm-search .cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "3px",
  },
  ".cm-search .cm-button:hover": {
    backgroundColor: "var(--theme-border-default)",
  },
  ".cm-search label": {
    color: "var(--theme-text-primary)",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--theme-text-primary)",
  },
  ".cm-dialog": {
    backgroundColor: "var(--theme-surface-sidebar)",
    color: "var(--theme-text-primary)",
    borderBottom: "1px solid var(--theme-border-default)",
    padding: "4px 8px",
  },
  ".cm-dialog .cm-textfield": {
    backgroundColor: "var(--theme-surface-canvas)",
    color: "var(--theme-text-primary)",
    border: "1px solid var(--theme-border-default)",
    borderRadius: "3px",
    outline: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "rgba(234, 179, 8, 0.3)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "rgba(234, 179, 8, 0.6)",
  },
});

const BASE_EXTENSIONS: Extension[] = [
  highlightedLineField,
  highlightLineTheme,
  search({ top: true }),
  keymap.of([{ key: "Mod-l", run: gotoLine }]),
  searchPanelTheme,
];

export const CodeViewer = forwardRef<CodeViewerHandle, CodeViewerProps>(function CodeViewer(
  { content, filePath, initialLine, className },
  ref
) {
  const [langExtension, setLangExtension] = useState<Extension | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useImperativeHandle(ref, () => ({
    openSearch() {
      if (viewRef.current) {
        openSearchPanel(viewRef.current);
      }
    },
    openGotoLine() {
      if (viewRef.current) {
        gotoLine(viewRef.current);
      }
    },
  }));

  useEffect(() => {
    const basename = filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath;
    const desc = LanguageDescription.matchFilename(languages, basename);
    if (!desc) {
      setLangExtension(null);
      return;
    }
    let cancelled = false;
    desc
      .load()
      .then((lang) => {
        if (!cancelled) setLangExtension(lang);
      })
      .catch(() => {
        // Plain text fallback on load failure
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const extensions = useMemo<Extension[]>(
    () => (langExtension ? [...BASE_EXTENSIONS, langExtension] : BASE_EXTENSIONS),
    [langExtension]
  );

  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      if (initialLine === undefined || initialLine < 1) return;
      const lineNum = Math.min(initialLine, view.state.doc.lines);

      view.dispatch({ effects: setHighlightedLine.of(lineNum) });

      // Use DOM scrollIntoView — outer wrapper owns scroll, not cm-scroller
      requestAnimationFrame(() => {
        try {
          const line = view.state.doc.line(lineNum);
          const { node } = view.domAtPos(line.from);
          const lineEl =
            node instanceof Element
              ? node.closest(".cm-line")
              : (node as ChildNode).parentElement?.closest(".cm-line");
          lineEl?.scrollIntoView({ block: "center" });
        } catch {
          // Ignore scroll errors (view may not be fully rendered)
        }
      });
    },
    [initialLine]
  );

  return (
    <div
      className={cn(
        "overflow-auto [&_.cm-editor]:min-h-full [&_.cm-scroller]:!overflow-visible",
        className
      )}
    >
      <CodeMirror
        value={content}
        theme={canopyTheme}
        extensions={extensions}
        editable={false}
        readOnly={true}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
          autocompletion: false,
        }}
        onCreateEditor={handleCreateEditor}
      />
    </div>
  );
});
