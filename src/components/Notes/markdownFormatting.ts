import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

export type MarkdownAction =
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "link"
  | "unordered-list"
  | "task-list";

const INLINE_MARKERS: Record<string, { marker: string; placeholder: string }> = {
  bold: { marker: "**", placeholder: "bold" },
  italic: { marker: "_", placeholder: "italic" },
  code: { marker: "`", placeholder: "code" },
};

function toggleInlineFormat(view: EditorView, marker: string, placeholder: string) {
  const markerLen = marker.length;
  view.dispatch(
    view.state.changeByRange((range) => {
      const { from, to } = range;
      const before = view.state.sliceDoc(from - markerLen, from);
      const after = view.state.sliceDoc(to, to + markerLen);
      const isWrapped = before === marker && after === marker;

      if (isWrapped) {
        return {
          changes: [
            { from: from - markerLen, to: from },
            { from: to, to: to + markerLen },
          ],
          range: EditorSelection.range(from - markerLen, to - markerLen),
        };
      }

      if (range.empty) {
        const insertText = `${marker}${placeholder}${marker}`;
        return {
          changes: { from, insert: insertText },
          range: EditorSelection.range(from + markerLen, from + markerLen + placeholder.length),
        };
      }

      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + markerLen, to + markerLen),
      };
    })
  );
  view.focus();
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const line = view.state.doc.lineAt(range.from);
      const hasPrefix = line.text.startsWith(prefix);
      const delta = hasPrefix ? -prefix.length : prefix.length;
      return {
        changes: hasPrefix
          ? { from: line.from, to: line.from + prefix.length, insert: "" }
          : { from: line.from, insert: prefix },
        range: EditorSelection.range(
          Math.max(line.from, range.from + delta),
          Math.max(line.from, range.to + delta)
        ),
      };
    })
  );
  view.focus();
}

function toggleHeading(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const line = view.state.doc.lineAt(range.from);
      const match = line.text.match(/^(#{1,3}) /);

      if (match) {
        const level = match[1].length;
        const removeLen = level + 1;
        if (level < 3) {
          const insert = "#".repeat(level + 1) + " ";
          const delta = 1;
          return {
            changes: { from: line.from, to: line.from + removeLen, insert },
            range: EditorSelection.range(range.from + delta, range.to + delta),
          };
        }
        // At ### → remove heading
        const delta = -(level + 1);
        return {
          changes: { from: line.from, to: line.from + removeLen, insert: "" },
          range: EditorSelection.range(
            Math.max(line.from, range.from + delta),
            Math.max(line.from, range.to + delta)
          ),
        };
      }

      // No heading → insert ##
      const insert = "## ";
      return {
        changes: { from: line.from, insert },
        range: EditorSelection.range(range.from + insert.length, range.to + insert.length),
      };
    })
  );
  view.focus();
}

function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;

  if (view.state.selection.main.empty) {
    view.dispatch({
      changes: { from, insert: "[text](url)" },
      selection: EditorSelection.range(from + 1, from + 5),
    });
  } else {
    const selectedText = view.state.sliceDoc(from, to);
    const urlStart = from + 1 + selectedText.length + 2;
    view.dispatch({
      changes: { from, to, insert: `[${selectedText}](url)` },
      selection: EditorSelection.range(urlStart, urlStart + 3),
    });
  }
  view.focus();
}

export function applyMarkdownFormat(view: EditorView, action: MarkdownAction): void {
  const inline = INLINE_MARKERS[action];
  if (inline) {
    toggleInlineFormat(view, inline.marker, inline.placeholder);
    return;
  }

  switch (action) {
    case "heading":
      toggleHeading(view);
      break;
    case "link":
      insertLink(view);
      break;
    case "unordered-list":
      toggleLinePrefix(view, "- ");
      break;
    case "task-list":
      toggleLinePrefix(view, "- [ ] ");
      break;
  }
}
