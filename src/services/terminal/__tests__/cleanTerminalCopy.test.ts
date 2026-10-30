// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IBuffer, IBufferRange } from "@xterm/xterm";
import {
  cleanCopyText,
  cleanTerminalSelection,
  type CleanCopyTerminal,
  type RowLayoutWidth,
} from "../cleanTerminalCopy";

const ALL_KNOWN: RowLayoutWidth = { widthKnownFrom: () => 0 };
const NONE_KNOWN: RowLayoutWidth = { widthKnownFrom: (buffer: IBuffer) => buffer.length };

async function render(cols: number, lines: string[]): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({
    cols,
    rows: 30,
    scrollback: 100,
    allowProposedApi: true,
  });
  await new Promise<void>((resolve) => terminal.write(lines.join("\r\n"), resolve));
  return terminal;
}

/** The text xterm's linear selection hands Copy for `range`. */
function linearText(terminal: HeadlessTerminal, range: IBufferRange): string {
  const buffer = terminal.buffer.active;
  const out: string[] = [];
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y)!;
    const from = y === range.start.y ? range.start.x : 0;
    const to = y === range.end.y ? range.end.x : undefined;
    const piece = line.translateToString(true, from, to);
    if (y > range.start.y && line.isWrapped) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out.join("\n");
}

/** The terminal with rows `startY`..`endY` selected, as a mouse drag would select them. */
function selecting(
  terminal: HeadlessTerminal,
  startY: number,
  endY: number,
  { startX = 0, endX = terminal.cols, text }: { startX?: number; endX?: number; text?: string } = {}
): CleanCopyTerminal {
  const range = { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
  const selection = text ?? linearText(terminal, range);
  return {
    cols: terminal.cols,
    buffer: terminal.buffer,
    getSelection: () => selection,
    getSelectionPosition: () => range,
  };
}

async function cleanAll(
  cols: number,
  lines: string[],
  layout: RowLayoutWidth | null = ALL_KNOWN
): Promise<string> {
  const terminal = await render(cols, lines);
  return cleanTerminalSelection(selecting(terminal, 0, lines.length - 1), layout);
}

describe("cleanTerminalSelection", () => {
  it("removes the indent every line shares and keeps a nested list's own", async () => {
    expect(
      await cleanAll(80, [
        "  Release notes:",
        "",
        "  - Added a clean copy",
        "    - next to Copy",
        "  - Fixed paste",
      ])
    ).toBe("Release notes:\n\n- Added a clean copy\n  - next to Copy\n- Fixed paste");
  });

  it("drops padding a TUI painted out to the pane's edge", async () => {
    const padded = (text: string) => text.padEnd(79, " ");
    const terminal = await render(80, [padded("  first line"), padded("  second line")]);
    const selection = selecting(terminal, 0, 1);
    expect(selection.getSelection()).toMatch(/first line {10}/);
    expect(cleanTerminalSelection(selection, ALL_KNOWN)).toBe("first line\nsecond line");
  });

  it("keeps the spacing inside a line and the breaks between paragraphs", async () => {
    expect(
      await cleanAll(80, [
        "⏺ Here is the summary.",
        "",
        "",
        "  Second paragraph, with  two spaces kept.",
        "",
      ])
    ).toBe("Here is the summary.\n\n\nSecond paragraph, with  two spaces kept.");
  });

  it("rejoins a paragraph Claude Code wrapped to the pane", async () => {
    expect(
      await cleanAll(40, [
        "⏺ Copying agent output from a terminal",
        "  gives you the text exactly as the TUI",
        "  drew it, padding and all.",
      ])
    ).toBe(
      "Copying agent output from a terminal gives you the text exactly as the TUI drew it, padding and all."
    );
  });

  it("rejoins a wrapped list item at its hanging indent, keeping the items apart", async () => {
    expect(
      await cleanAll(40, [
        "  - Rows an agent wrapped to fit the",
        "    pane come back as one line when",
        "    nothing else explains the break.",
        "  - A second item stays its own line.",
        "    1. Numbered items wrap at their own",
        "       hanging indent too.",
      ])
    ).toBe(
      [
        "- Rows an agent wrapped to fit the pane come back as one line when nothing else explains the break.",
        "- A second item stays its own line.",
        "  1. Numbered items wrap at their own hanging indent too.",
      ].join("\n")
    );
  });

  it("keeps a break where the next word would have fit", async () => {
    const lines = ["  The first line is short.", "  The second one is too."];
    expect(await cleanAll(40, lines)).toBe("The first line is short.\nThe second one is too.");
  });

  it("keeps a break where the next row starts deeper or further out than the hanging indent", async () => {
    const deeper = ["  A paragraph that runs right to the", "      indented example"];
    expect(await cleanAll(40, deeper)).toBe(
      "A paragraph that runs right to the\n    indented example"
    );
    const outdented = ["    - A list item that runs to the edge", "  outer text resumes here"];
    expect(await cleanAll(40, outdented)).toBe(
      "  - A list item that runs to the edge\nouter text resumes here"
    );
  });

  it("never joins onto a new list item or heading, or onto a quote", async () => {
    // At 37 columns the next row's first word wouldn't fit, so only the shape keeps them apart.
    expect(
      await cleanAll(37, [
        "  A paragraph that runs right to the",
        "  - first item.",
        "  A paragraph that runs right to the",
        "  # Heading.",
      ])
    ).toBe(
      [
        "A paragraph that runs right to the",
        "- first item.",
        "A paragraph that runs right to the",
        "# Heading.",
      ].join("\n")
    );
    expect(
      await cleanAll(40, ["  > A quoted line that runs to the edge", "  and carries on here."])
    ).toBe("> A quoted line that runs to the edge\nand carries on here.");
  });

  it("keeps every line of a block that holds code", async () => {
    expect(
      await cleanAll(40, [
        "  const total = items.length;",
        "  The next line runs right up to the",
        "  edge of the pane.",
        "",
        "  Prose after the code still wraps when",
        "  it runs to the edge of the pane.",
      ])
    ).toBe(
      [
        "const total = items.length;",
        "The next line runs right up to the",
        "edge of the pane.",
        "",
        "Prose after the code still wraps when it runs to the edge of the pane.",
      ].join("\n")
    );
  });

  it("keeps a fenced block whole, inner fences and blank lines included", async () => {
    const lines = [
      "  ````markdown",
      "  ```",
      "",
      "  A line inside the fence that runs to",
      "  the edge of the pane.",
      "",
      "  ````",
    ];
    expect(await cleanAll(40, lines)).toBe(lines.map((line) => line.slice(2)).join("\n"));
  });

  it("keeps lines of code, commands, config, tables and one sentence per line apart", async () => {
    const pairs = [
      ["  from collections import defaultdict", "  import sys"],
      ["  git fetch origin feature/clean-copy", "  git status"],
      ["  description: Read the terminal output", "  summary: Ships the clean copy."],
      ["  Component | Changes in this release", "  Terminal | Adds clean copy."],
      ["  git fetch origin feature/clean-copy", "  git diff ."],
      ["  The implementation is complete now.", "  Documentation remains unchanged."],
    ];
    for (const pair of pairs) {
      expect(await cleanAll(40, pair)).toBe(pair.map((line) => line.trim()).join("\n"));
    }
  });

  it("rejoins a message's first paragraph however it ends", async () => {
    expect(
      await cleanAll(40, ["⏺ Copying agent output from a terminal", "  requires xterm (see notes)"])
    ).toBe("Copying agent output from a terminal requires xterm (see notes)");
  });

  it("looks for code in the whole row, not just the part selected", async () => {
    const terminal = await render(40, [
      "  const value = computeIt(alpha, beta)",
      "  return value.",
    ]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 1, { startX: 16 }), ALL_KNOWN)).toBe(
      "computeIt(alpha, beta)\nreturn value."
    );
  });

  it("rejoins a paragraph with a double space after a full stop", async () => {
    expect(
      await cleanAll(40, [
        "  Copying agent output from a terminal",
        "  gives you the text exactly as the TUI",
        "  drew it.  Keep the spacing.",
      ])
    ).toBe(
      "Copying agent output from a terminal gives you the text exactly as the TUI drew it.  Keep the spacing."
    );
  });

  it("measures a word of CJK text to its first character", async () => {
    expect(await cleanAll(30, ["  第一段说明", "  这是独立的一行中文说明。"])).toBe(
      "第一段说明\n这是独立的一行中文说明。"
    );
  });

  it("keeps a tool-output tree and a diff as drawn", async () => {
    expect(await cleanAll(30, ["  └ Read the source file here", "  continuing output."])).toBe(
      "└ Read the source file here\ncontinuing output."
    );
    const diff = [
      "    12 - an old line of the file here",
      "    12 + a new line of the file there.",
    ];
    expect(await cleanAll(39, diff)).toBe(diff.map((line) => line.trim()).join("\n"));
    const claude = [
      "⏺ Read(src/services/terminal/types.ts)",
      "  ⎿  Read 120 lines from the file here",
    ];
    expect(await cleanAll(40, claude)).toBe(
      "Read(src/services/terminal/types.ts)\n⎿  Read 120 lines from the file here"
    );
  });

  it("keeps a break after a row that leads into what follows, or before one that isn't prose", async () => {
    const colon = ["  The change touches three files here:", "  each one gets its own test."];
    expect(await cleanAll(40, colon)).toBe(colon.map((line) => line.trim()).join("\n"));
    const caret = [
      "  print(value) raised an error at line",
      "  ^^^^ marks the failing column there.",
    ];
    expect(await cleanAll(40, caret)).toBe(caret.map((line) => line.trim()).join("\n"));
  });

  it("keeps a row that ends at the margin, where a cut token and a whole word look alike", async () => {
    const lines = ["  Look in src/services/terminal/clean.ts", "  for the reader."];
    expect(lines[0]).toHaveLength(40);
    expect(await cleanAll(40, lines)).toBe(
      "Look in src/services/terminal/clean.ts\nfor the reader."
    );
  });

  it("joins nothing on rows laid out at another width, or with no width to go by", async () => {
    const lines = ["⏺ Release notes for this build, copied", "  straight out of the reply."];
    const kept = "Release notes for this build, copied\nstraight out of the reply.";
    expect(await cleanAll(40, lines, NONE_KNOWN)).toBe(kept);
    expect(await cleanAll(40, lines, null)).toBe(kept);
    expect(await cleanAll(40, lines)).toBe(
      "Release notes for this build, copied straight out of the reply."
    );
  });

  it("joins nothing across a row xterm wrapped itself, and keeps that row's text whole", async () => {
    const long = `  ${"x".repeat(75)}`;
    const terminal = await render(40, [long, "more text."]);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(cleanTerminalSelection(selecting(terminal, 0, 2), ALL_KNOWN)).toBe(
      `${long}\nmore text.`
    );
  });

  it("counts a selection that starts in the indent from the left edge", async () => {
    const terminal = await render(80, ["    - nested item", "  - outer item"]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 1, { startX: 2 }), ALL_KNOWN)).toBe(
      "  - nested item\n- outer item"
    );
  });

  it("gives a selection that starts mid-line no indent of its own", async () => {
    const terminal = await render(80, ["  - Added a clean copy", "  - Fixed paste"]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 1, { startX: 4 }), ALL_KNOWN)).toBe(
      "Added a clean copy\n- Fixed paste"
    );
  });

  it("stops where the selection stops, joining a paragraph that carries on past it", async () => {
    const terminal = await render(40, [
      "⏺ Copying agent output from a terminal",
      "  gives you the text exactly as the TUI",
      "  drew it, padding and all.",
    ]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 1, { endX: 11 }), ALL_KNOWN)).toBe(
      "Copying agent output from a terminal gives you"
    );
    // A drag past the end of a row ends at the start of the next one.
    expect(cleanTerminalSelection(selecting(terminal, 0, 2, { endX: 0 }), ALL_KNOWN)).toBe(
      "Copying agent output from a terminal gives you the text exactly as the TUI"
    );
  });

  it("cleans the text alone when the selection isn't the rows it spans, as a column selection isn't", async () => {
    const terminal = await render(40, [
      "⏺ Copying agent output from a terminal",
      "  gives you the text exactly as the TUI",
    ]);
    const column = selecting(terminal, 0, 1, {
      startX: 2,
      endX: 20,
      text: "Copying agent outpu   \ngives you the text   ",
    });
    expect(cleanTerminalSelection(column, ALL_KNOWN)).toBe(
      "Copying agent outpu\ngives you the text"
    );
  });

  it("cleans what the menu captured when the selection has changed since", async () => {
    const terminal = await render(80, ["  one", "  two"]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 1), ALL_KNOWN, "    a\n    b  ")).toBe(
      "a\nb"
    );
  });

  it("copies nothing from an empty selection", async () => {
    const terminal = await render(80, ["  one"]);
    expect(cleanTerminalSelection(selecting(terminal, 0, 0, { text: "" }), ALL_KNOWN)).toBe("");
  });
});

describe("cleanCopyText", () => {
  it("removes the shared indent, trailing padding and Claude Code's marker, leaving every break", () => {
    expect(cleanCopyText("⏺ Summary   \n  - item one\n    - nested\n\n  Next paragraph  ")).toBe(
      "Summary\n- item one\n  - nested\n\nNext paragraph"
    );
  });

  it("keeps CRLF line endings and converts NBSP the way xterm does", () => {
    expect(cleanCopyText("  one\u00a0two  \r\n  three\r\n")).toBe("one two\r\nthree");
  });

  it("keeps a bullet that isn't Claude Code's marker", () => {
    expect(cleanCopyText("• Release notes:\n  - Added")).toBe("• Release notes:\n  - Added");
  });
});
