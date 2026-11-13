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
import { EditorView, Decoration, type DecorationSet, keymap, panels } from "@codemirror/view";
import { type Extension, StateEffect, StateField, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { type SyntaxNode } from "@lezer/common";
import { search, openSearchPanel, gotoLine } from "@codemirror/search";
import { getDaintreeEditorTheme } from "./editorTheme";
import { useActiveAppScheme } from "@/hooks/useActiveAppScheme";
import { editorSearchHighlightTheme, editorSearchPanelTheme } from "./editorSearchTheme";
import { createEditorSearchPanel } from "./editorSearchPanel";
import { matchCodeMirrorLanguage } from "./codeMirrorLanguages";
import { cn } from "@/lib/utils";
import { CODE_VIEWER_OWNER_ATTR } from "@/lib/codeViewerKeys";

export interface CodeViewerHandle {
  openSearch: () => void;
  openGotoLine: () => void;
}

export interface CodeViewerProps {
  content: string;
  filePath: string;
  initialLine?: number;
  wrapLines?: boolean;
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
    backgroundColor: "var(--color-search-highlight-background) !important",
  },
});

// `editable={false}` strips contenteditable, and without a tabindex nothing
// else makes `.cm-content` focusable: closing find handed focus to a node that
// refused it and stranded it on `body`, and the keymap below never saw a key
// unless the find field was open. The tabindex keeps the surface focusable
// without a caret. The focus ring is the scroll wrapper's below, so the two
// outlines CodeMirror's content would otherwise wear are dropped: its dotted
// editor outline, and the global focus-visible ring, which forced-colors makes
// important and which would trace the whole file's height.
const focusableSurface = [
  EditorView.contentAttributes.of({ tabindex: "0" }),
  EditorView.theme({
    "&.cm-focused": { outline: "none" },
    ".cm-content:focus-visible": { outline: "none !important" },
  }),
];

const BASE_EXTENSIONS: Extension[] = [
  highlightedLineField,
  highlightLineTheme,
  EditorState.readOnly.of(true),
  focusableSurface,
  search({ top: true, createPanel: createEditorSearchPanel }),
  // The find bar runs only keys scoped to it, so go to line needs the scope to
  // answer while the find field has focus.
  keymap.of([{ key: "Mod-l", run: gotoLine, scope: "editor search-panel" }]),
  editorSearchPanelTheme,
  editorSearchHighlightTheme,
];

const SCOPE_NODE_TYPES_BY_LANGUAGE: Record<string, Set<string>> = {
  JavaScript: new Set([
    "FunctionDeclaration",
    "ClassDeclaration",
    "MethodDeclaration",
    "ArrowFunction",
    "FunctionExpression",
    "ClassExpression",
    "InterfaceDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
  ]),
  TypeScript: new Set([
    "FunctionDeclaration",
    "ClassDeclaration",
    "MethodDeclaration",
    "ArrowFunction",
    "FunctionExpression",
    "ClassExpression",
    "InterfaceDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
  ]),
  Python: new Set(["FunctionDefinition", "ClassDefinition"]),
  Go: new Set(["FunctionDecl", "MethodDecl", "TypeDecl"]),
  Rust: new Set([
    "FunctionItem",
    "StructItem",
    "ImplItem",
    "TraitItem",
    "EnumItem",
    "ModItem",
    "UnionItem",
  ]),
  Java: new Set([
    "ClassDeclaration",
    "MethodDeclaration",
    "InterfaceDeclaration",
    "EnumDeclaration",
  ]),
  TSX: new Set([
    "FunctionDeclaration",
    "ClassDeclaration",
    "MethodDeclaration",
    "ArrowFunction",
    "FunctionExpression",
    "ClassExpression",
    "InterfaceDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
  ]),
  JSX: new Set([
    "FunctionDeclaration",
    "ClassDeclaration",
    "MethodDeclaration",
    "ArrowFunction",
    "FunctionExpression",
    "ClassExpression",
    "InterfaceDeclaration",
    "EnumDeclaration",
    "NamespaceDeclaration",
  ]),
  "C++": new Set(["FunctionDefinition", "ClassSpecifier", "StructSpecifier"]),
  C: new Set(["FunctionDefinition", "ClassSpecifier", "StructSpecifier"]),
};

export const CodeViewer = forwardRef<CodeViewerHandle, CodeViewerProps>(function CodeViewer(
  { content, filePath, initialLine, wrapLines = false, className },
  ref
) {
  const [langExtension, setLangExtension] = useState<Extension | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const stickyScopeRef = useRef<string | null>(null);
  const [stickyScope, setStickyScope] = useState<string | null>(null);
  const [cmLineHeight, setCmLineHeight] = useState<number>(24);
  // Find docks here, above the scrolling document rather than inside it: the
  // wrapper below scrolls sideways for long lines, which carried a docked bar
  // out of a narrow pane, and its top edge belongs to the scope line. Sticky,
  // because a host that sizes this viewer to its content (FilePane) scrolls
  // the whole viewer instead, and find has to stay on screen there too.
  const [panelHost] = useState(() => document.createElement("div"));
  const mountPanelHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && panelHost.parentNode !== node) node.appendChild(panelHost);
    },
    [panelHost]
  );

  // Track the active palette's polarity so CodeMirror's internal base matches
  // the canvas it renders on (RC-8) — a light palette must not get the dark base.
  const schemePolarity = useActiveAppScheme().type;
  const editorTheme = getDaintreeEditorTheme(schemePolarity);

  useImperativeHandle(
    ref,
    () => ({
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
    }),
    []
  );

  const langName = useMemo(() => matchCodeMirrorLanguage(filePath)?.name ?? null, [filePath]);

  const scopeTypes = useMemo(
    () => (langName ? (SCOPE_NODE_TYPES_BY_LANGUAGE[langName] ?? null) : null),
    [langName]
  );

  useEffect(() => {
    const desc = matchCodeMirrorLanguage(filePath);
    // Clear any previously-loaded extension so a failed lazy chunk fetch
    // doesn't leave the prior file's syntax highlighting on this file.
    setLangExtension(null);
    if (!desc) return;
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

  const extensions = useMemo<Extension[]>(() => {
    const list = langExtension ? [...BASE_EXTENSIONS, langExtension] : [...BASE_EXTENSIONS];
    list.push(panels({ topContainer: panelHost }));
    if (wrapLines) list.push(EditorView.lineWrapping);
    return list;
  }, [langExtension, wrapLines, panelHost]);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const view = viewRef.current;
      const wrapper = scrollRef.current;
      if (!view || !wrapper) return;
      if (wrapper.scrollTop <= 0) {
        stickyScopeRef.current = null;
        setStickyScope(null);
        return;
      }
      if (!scopeTypes || scopeTypes.size === 0) {
        stickyScopeRef.current = null;
        setStickyScope(null);
        return;
      }
      try {
        const cmScrollTop = wrapper.getBoundingClientRect().top - view.documentTop;
        const line = view.lineBlockAtHeight(Math.max(0, cmScrollTop));
        const tree = syntaxTree(view.state);
        let node: SyntaxNode | null = tree.resolve(line.from, -1);
        let found: { from: number } | null = null;
        while (node && node !== tree.topNode) {
          if (scopeTypes.has(node.type.name)) {
            found = { from: node.from };
            break;
          }
          node = node.parent;
        }
        if (found) {
          const text = view.state.doc.lineAt(found.from).text.trimEnd();
          if (stickyScopeRef.current !== text) {
            stickyScopeRef.current = text;
            setStickyScope(text);
          }
        } else {
          if (stickyScopeRef.current !== null) {
            stickyScopeRef.current = null;
            setStickyScope(null);
          }
        }
      } catch {
        if (stickyScopeRef.current !== null) {
          stickyScopeRef.current = null;
          setStickyScope(null);
        }
      }
    });
  }, [scopeTypes]);

  useEffect(() => {
    handleScroll();
  }, [content, handleScroll]);

  useEffect(() => {
    handleScroll();
  }, [langExtension, handleScroll]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      setCmLineHeight(view.defaultLineHeight);
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
              : (node.parentElement as Element | null)?.closest(".cm-line");
          lineEl?.scrollIntoView({ block: "center" });
        } catch {
          // Ignore scroll errors (view may not be fully rendered)
        }
      });
    },
    [initialLine]
  );

  return (
    <div {...{ [CODE_VIEWER_OWNER_ATTR]: "" }} className={cn("flex min-h-0 flex-col", className)}>
      <div ref={mountPanelHost} className="sticky top-0 z-10 shrink-0" />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-code-viewer-scroll=""
        // `isolate` keeps CodeMirror's own stacking (its gutters sit at z-index
        // 200) from painting over the sticky find bar as the document scrolls.
        // The ring sits on this wrapper, which stays put while the document
        // scrolls inside it, and not on the content node, which is as tall as
        // the file.
        className={cn(
          "isolate min-h-0 flex-1 overflow-auto text-sm leading-[inherit] [&_.cm-editor]:min-h-full [&_.cm-scroller]:!overflow-visible",
          "has-[.cm-content:focus-visible]:outline-2 has-[.cm-content:focus-visible]:-outline-offset-2 has-[.cm-content:focus-visible]:outline-accent-primary"
        )}
      >
        <div
          className={cn(
            "sticky top-0 z-10 pointer-events-none flex items-center px-2 truncate border-b whitespace-pre",
            stickyScope !== null
              ? "border-[var(--theme-border-default)] bg-[var(--theme-surface-sidebar)] text-[var(--theme-text-secondary)]"
              : "border-transparent bg-transparent text-transparent"
          )}
          style={{
            height: `${cmLineHeight}px`,
            lineHeight: `${cmLineHeight}px`,
          }}
        >
          {stickyScope ?? " "}
        </div>
        <CodeMirror
          value={content}
          theme={editorTheme}
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
    </div>
  );
});
