// The MarkdownEditor toolbar's edits, as pure functions over the text and its
// selection, so every one is a single replacement the textarea can apply as
// one native edit (one undo step) and a test can check without a DOM.

export type MarkdownFormat = "bold" | "italic" | "code" | "link" | "bullets" | "numbers";

/** Replace `from`..`to` with `insert`, then select `selectionStart`..`selectionEnd` of the result. */
export interface MarkdownEdit {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

const INLINE_MARK: Record<"bold" | "italic" | "code", string> = {
  bold: "**",
  italic: "_",
  code: "`",
};

function toggleInline(text: string, start: number, end: number, mark: string): MarkdownEdit {
  const selected = text.slice(start, end);
  const size = mark.length;
  // A selection holding a mark of its own spans more than one run (`**a** and
  // **b**`): taking marks off at its edges would pair the wrong ones, so it
  // is wrapped instead.
  const single = !selected.slice(size, Math.max(size, selected.length - size)).includes(mark);
  // Marks just outside the selection: take them off.
  if (
    !selected.includes(mark) &&
    start >= size &&
    text.slice(start - size, start) === mark &&
    text.slice(end, end + size) === mark
  ) {
    const from = start - size;
    return {
      from,
      to: end + size,
      insert: selected,
      selectionStart: from,
      selectionEnd: from + selected.length,
    };
  }
  // Marks just inside it: the same.
  if (
    single &&
    selected.length >= size * 2 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark)
  ) {
    const inner = selected.slice(size, selected.length - size);
    return {
      from: start,
      to: end,
      insert: inner,
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  return {
    from: start,
    to: end,
    insert: mark + selected + mark,
    selectionStart: start + size,
    selectionEnd: start + size + selected.length,
  };
}

function codeBlock(text: string, start: number, end: number): MarkdownEdit {
  const raw = text.slice(start, end);
  const selected = raw.replace(/\n$/, "");
  const lead = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
  // The closing fence ends its line: the selection's own newline goes back
  // after it, or one is added when text follows on the same line.
  const trail = raw.endsWith("\n") || (end < text.length && text[end] !== "\n") ? "\n" : "";
  const insert = `${lead}\`\`\`\n${selected}\n\`\`\`${trail}`;
  const bodyStart = start + lead.length + 4;
  return {
    from: start,
    to: end,
    insert,
    selectionStart: bodyStart,
    selectionEnd: bodyStart + selected.length,
  };
}

function link(text: string, start: number, end: number): MarkdownEdit {
  const selected = text.slice(start, end);
  // A selected address becomes the target, and the caret waits for its text.
  if (/^(?:https?:\/\/|mailto:)\S+$/.test(selected)) {
    return {
      from: start,
      to: end,
      insert: `[](${selected})`,
      selectionStart: start + 1,
      selectionEnd: start + 1,
    };
  }
  const insert = `[${selected}](url)`;
  const urlStart = start + selected.length + 3;
  return { from: start, to: end, insert, selectionStart: urlStart, selectionEnd: urlStart + 3 };
}

const BULLET = /^(\s*)[-*+] /;
const NUMBER = /^(\s*)\d+[.)] /;

function lists(
  text: string,
  start: number,
  end: number,
  kind: "bullets" | "numbers"
): MarkdownEdit {
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending just after a newline stops at the line before it.
  const stop = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const next = text.indexOf("\n", stop);
  const to = next === -1 ? text.length : next;
  const lines = text.slice(from, to).split("\n");
  const pattern = kind === "bullets" ? BULLET : NUMBER;
  const filled = lines.filter((line) => line.trim() !== "");
  const allListed = filled.length > 0 && filled.every((line) => pattern.test(line));
  let count = 0;
  const changed = lines.map((line) => {
    if (allListed) return line.replace(pattern, "$1");
    if (line.trim() === "" && lines.length > 1) return line;
    // Any marker already there is replaced rather than stacked.
    const bare = line.replace(BULLET, "$1").replace(NUMBER, "$1");
    const indent = /^\s*/.exec(bare)?.[0] ?? "";
    count++;
    return `${indent}${kind === "bullets" ? "-" : `${count}.`} ${bare.slice(indent.length)}`;
  });
  const insert = changed.join("\n");
  const single = lines.length === 1;
  return {
    from,
    to,
    insert,
    selectionStart: single ? from + insert.length : from,
    selectionEnd: from + insert.length,
  };
}

export function formatMarkdown(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat
): MarkdownEdit {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, text.length));
  const end = Math.min(text.length, Math.max(selectionStart, selectionEnd));
  switch (format) {
    case "code":
      return text.slice(start, end).includes("\n")
        ? codeBlock(text, start, end)
        : toggleInline(text, start, end, INLINE_MARK.code);
    case "bold":
    case "italic":
      return toggleInline(text, start, end, INLINE_MARK[format]);
    case "link":
      return link(text, start, end);
    case "bullets":
    case "numbers":
      return lists(text, start, end, format);
  }
}

/** The text with `edit` applied. */
export function applyMarkdownEdit(text: string, edit: MarkdownEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}
