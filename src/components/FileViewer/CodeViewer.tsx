import { useMemo, useState, useEffect, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { LanguageDescription } from "@codemirror/language";
import { canopyTheme } from "@/components/Notes/editorTheme";
import { cn } from "@/lib/utils";

export interface CodeViewerProps {
  content: string;
  filePath: string;
  initialLine?: number;
  className?: string;
}

const highlightLineStyle = EditorView.baseTheme({
  "&dark .cm-highlightedLine": {
    backgroundColor: "rgba(234, 179, 8, 0.1)",
  },
});

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
    desc.load().then((lang) => {
      if (!cancelled) setLangExtension(lang);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const extensions = useMemo(() => {
    const exts: Extension[] = [];
    if (langExtension) exts.push(langExtension);
    if (initialLine !== undefined) exts.push(highlightLineStyle);
    return exts;
  }, [langExtension, initialLine]);

  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      if (initialLine === undefined || initialLine < 1) return;
      const lineNum = Math.min(initialLine, view.state.doc.lines);
      const line = view.state.doc.line(lineNum);

      requestAnimationFrame(() => {
        view.dispatch({
          effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
        const domLine = view.domAtPos(line.from)?.node?.parentElement;
        const cmLine = domLine?.closest(".cm-line");
        if (cmLine) cmLine.classList.add("cm-highlightedLine");
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
