import { describe, expect, it } from "vitest";
import headless, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { TERMINAL_MODE_RESET } from "../terminalModeReset.js";

const { Terminal } = headless;

function createMirror(): HeadlessTerminal {
  return new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true });
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function cursor(terminal: HeadlessTerminal): { x: number; y: number } {
  return { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY };
}

function line(terminal: HeadlessTerminal, row: number): string {
  return terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
}

const STUCK_INPUT_MODES = "\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?1004h";

describe("TERMINAL_MODE_RESET", () => {
  it("turns off the input modes a dead program left on", async () => {
    const t = createMirror();
    await write(t, "$ tui" + STUCK_INPUT_MODES + "\x1b[?66h\x1b[?2026h");
    expect(t.modes.mouseTrackingMode).toBe("vt200");

    await write(t, TERMINAL_MODE_RESET);

    expect(t.modes).toMatchObject({
      mouseTrackingMode: "none",
      bracketedPasteMode: false,
      applicationCursorKeysMode: false,
      applicationKeypadMode: false,
      sendFocusMode: false,
      synchronizedOutputMode: false,
      originMode: false,
      wraparoundMode: true,
      showCursor: true,
    });
    t.dispose();
  });

  it("keeps the cursor and scrollback where they are on the normal screen", async () => {
    const t = createMirror();
    // A stale DECSC at the top-left: a bare `?1049l` would restore it after
    // DECSTR and move the prompt's cursor there.
    await write(t, "\x1b7line one\r\nline two\r\n$ prompt" + STUCK_INPUT_MODES);
    const before = cursor(t);

    await write(t, TERMINAL_MODE_RESET);

    expect(t.buffer.active.type).toBe("normal");
    expect(cursor(t)).toEqual(before);
    expect(line(t, 0)).toBe("line one");
    expect(line(t, 2)).toBe("$ prompt");
    t.dispose();
  });

  it("leaves the alternate screen for the cursor the program entered it from", async () => {
    const t = createMirror();
    await write(t, "line one\r\n$ vim");
    const entered = cursor(t);
    await write(t, "\x1b[?1049h\x1b[2J\x1b[Hfull screen\r\nmore" + STUCK_INPUT_MODES);
    expect(t.buffer.active.type).toBe("alternate");

    await write(t, TERMINAL_MODE_RESET);

    expect(t.buffer.active.type).toBe("normal");
    expect(cursor(t)).toEqual(entered);
    expect(line(t, 1)).toBe("$ vim");
    expect(t.modes.mouseTrackingMode).toBe("none");
    expect(t.modes.bracketedPasteMode).toBe(false);
    t.dispose();
  });

  it("is not swallowed by a sequence the program died in the middle of", async () => {
    const t = createMirror();
    await write(t, "$ tui\x1b[?1003h\x1b[38;2;10");

    await write(t, TERMINAL_MODE_RESET + "after");

    expect(t.modes.mouseTrackingMode).toBe("none");
    expect(line(t, 0)).toBe("$ tuiafter");
    t.dispose();
  });
});
