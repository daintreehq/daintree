import { useMemo, useState, useEffect, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { languages } from "@codemirror/language-data";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { canopyTheme } from "@/components/Notes/editorTheme";
import { cn } from "@/lib/utils";

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

const BASE_EXTENSIONS: Extension[] = [highlightedLineField, highlightLineTheme];

export function CodeViewer({ content, filePath, initialLine, className }: CodeViewerProps) {
  const [langExtension, setLangExtension] = useState<Extension | null>(null);

  useEffect(() => {
    const basename = filePath.split("/").pop() ?? filePath;
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
          foldGutter: false,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
          autocompletion: false,
        }}
        onCreateEditor={handleCreateEditor}
      />
    </div>
  );
}
