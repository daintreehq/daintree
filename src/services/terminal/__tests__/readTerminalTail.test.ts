import { describe, expect, it } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IBuffer, IBufferLine } from "@xterm/xterm";
import { CLIPPED_LINE_MARKER, readTerminalTail } from "../readTerminalTail";

async function render(
  cols: number,
  output: string,
  { rows = 10, scrollback = 1000 }: { rows?: number; scrollback?: number } = {}
): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({ cols, rows, scrollback, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  return terminal;
}

function tail(terminal: HeadlessTerminal, maxLines = 100, maxRows = 400): string {
  return readTerminalTail(terminal.buffer.active, maxLines, maxRows);
}

const url = "https://example.com/a/very/long/path/without/any/breaks/index.html?q=1&r=2";

describe("readTerminalTail", () => {
  it("joins the rows xterm wrapped an unbroken URL across, narrow or wide", async () => {
    const output = `$ open\r\n${url}\r\n$`;
    const narrow = await render(8, output);
    expect(narrow.buffer.active.getLine(2)?.isWrapped).toBe(true);
    expect(tail(narrow)).toBe(`$ open\n${url}\n$`);
    expect(tail(await render(80, output))).toBe(`$ open\n${url}\n$`);
  });

  it("keeps a command's spaces where they fall on either side of a wrap", async () => {
    // At 8 columns the space after `ab` is the row's last cell.
    const command = "echo ab def ghi";
    expect(tail(await render(8, command))).toBe(command);
    // At 7 columns a space opens the continuation row instead.
    expect(tail(await render(7, command))).toBe(command);
    expect(tail(await render(80, command))).toBe(command);
  });

  it("drops the margin cell a wide character skipped when it wrapped", async () => {
    const text = "1234567界abc";
    const terminal = await render(8, text);
    expect(terminal.buffer.active.getLine(0)?.translateToString(false)).toBe("1234567 ");
    expect(tail(terminal)).toBe(text);
  });

  it("keeps the breaks and blank lines the program wrote", async () => {
    const terminal = await render(10, "first\r\n\r\nsecond line here\r\nthird");
    expect(tail(terminal)).toBe("first\n\nsecond line here\nthird");
  });

  it("counts lines, not rows, so the pane's width doesn't change what's read", async () => {
    const output = Array.from({ length: 6 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\r\n");
    const expected = [4, 5].map((i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    expect(tail(await render(8, output), 2)).toBe(expected);
    expect(tail(await render(80, output), 2)).toBe(expected);
  });

  it("reads the same lines after the pane is resized", async () => {
    // Ends on a fresh row: xterm doesn't reflow the cursor's own line.
    const terminal = await render(10, `$ ls\r\n${url}\r\n`);
    const before = tail(terminal);
    expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(true);
    terminal.resize(60, 10);
    expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(false);
    expect(tail(terminal)).toBe(before);
    terminal.resize(6, 10);
    expect(terminal.buffer.active.getLine(3)?.isWrapped).toBe(true);
    expect(tail(terminal)).toBe(before);
    expect(before).toBe(`$ ls\n${url}`);
  });

  it("doesn't spend the line budget on blank rows below the output", async () => {
    const terminal = await render(20, "a\r\nb\r\nc\r\n ", { rows: 30 });
    expect(terminal.buffer.active.length).toBe(30);
    expect(tail(terminal, 2)).toBe("b\nc");
  });

  // Ten columns of a different letter per row, so the rows a read takes show.
  const rowsOf = (count: number) =>
    Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i).repeat(10)).join("");

  it("keeps the tail of a line longer than the row cap, under the marker", async () => {
    const long = rowsOf(5);
    // Six rows tall, so no blank row sits below the output.
    const terminal = await render(10, `before\r\n${long}`, { rows: 6 });
    expect(tail(terminal, 100, 3)).toBe(`${CLIPPED_LINE_MARKER}\n${long.slice(20)}`);
    expect(tail(terminal, 100, 6)).toBe(`before\n${long}`);
  });

  it("marks a line whose start the scrollback already dropped", async () => {
    const long = rowsOf(10);
    const terminal = await render(10, long, { rows: 5, scrollback: 2 });
    expect(terminal.buffer.active.getLine(0)?.isWrapped).toBe(true);
    expect(tail(terminal)).toBe(`${CLIPPED_LINE_MARKER}\n${long.slice(30)}`);
  });

  /** A 5,000-row buffer with `text(y)` on each row, and the rows a read asked for. */
  function fakeBuffer(text: (y: number) => string) {
    const read = new Set<number>();
    const buffer: Pick<IBuffer, "length" | "getLine"> = {
      length: 5000,
      getLine: (y): IBufferLine => {
        read.add(y);
        return {
          isWrapped: false,
          length: 80,
          getCell: () => undefined,
          translateToString: () => text(y),
        };
      },
    };
    return { buffer, read };
  }

  it("reads no row outside the last maxRows, however many blank ones there are", () => {
    const blank = fakeBuffer(() => "");
    expect(readTerminalTail(blank.buffer, 100, 400)).toBe("");
    expect(blank.read.size).toBe(400);
    expect(Math.min(...blank.read)).toBe(4600);
  });

  it("counts the blank rows below the output against maxRows", () => {
    const below = fakeBuffer((y) => (y < 4990 ? `row ${y}` : ""));
    const lines = readTerminalTail(below.buffer, 1000, 400).split("\n");
    expect(Math.min(...below.read)).toBe(4600);
    expect(lines).toHaveLength(390);
    expect(lines[0]).toBe("row 4600");
  });

  it("reads nothing from a blank screen", async () => {
    expect(tail(await render(20, "\r\n   \r\n"))).toBe("");
  });
});
