import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import type { Extension } from "@codemirror/state";

const codeBlockLineDecoration = Decoration.line({ class: "cm-code-block-line" });

const codeBlockPlugin = ViewPlugin.fromClass(
  class {
    decorations = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      let lastLine = -1;

      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            if (node.name === "FencedCode" || node.name === "CodeBlock") {
              const startLine = view.state.doc.lineAt(node.from).number;
              const endLine = view.state.doc.lineAt(node.to).number;
              for (let i = startLine; i <= endLine; i++) {
                if (i > lastLine) {
                  const lineStart = view.state.doc.line(i).from;
                  builder.add(lineStart, lineStart, codeBlockLineDecoration);
                  lastLine = i;
                }
              }
            }
          },
        });
      }

      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

const codeBlockTheme = EditorView.baseTheme({
  ".cm-code-block-line": {
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  },
});

const inlineCodeStyle = syntaxHighlighting(
  HighlightStyle.define([{ tag: t.monospace, fontFamily: DEFAULT_TERMINAL_FONT_FAMILY }])
);

export function notesTypographyExtension(): Extension {
  return [inlineCodeStyle, codeBlockPlugin, codeBlockTheme];
}
