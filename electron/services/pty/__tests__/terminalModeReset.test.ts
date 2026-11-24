import { describe, expect, it } from "vitest";
import headless, { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { TERMINAL_MODE_RESET } from "../terminalModeReset.js";

const { Terminal } = headless;

const ROWS = 10;

function createMirror(): HeadlessTerminal {
  return new Terminal({ cols: 40, rows: ROWS, scrollback: 100, allowProposedApi: true });
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

/** The DECRQM answer for a private mode: 1 set, 2 reset. */
async function privateModeState(terminal: HeadlessTerminal, mode: number): Promise<number> {
  let reply = "";
  const sub = terminal.onData((data) => (reply += data));
  await write(terminal, `\x1b[?${mode}$p`);
  sub.dispose();
  const match = new RegExp(`\\x1b\\[\\?${mode};(\\d)\\$y`).exec(reply);
  if (!match) throw new Error(`no DECRQM reply for ${mode}: ${JSON.stringify(reply)}`);
  return Number(match[1]);
}

const STUCK_INPUT_MODES = "\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?1004h";

describe("TERMINAL_MODE_RESET", () => {
  it("turns off the input modes a dead program left on", async () => {
    const t = createMirror();
    // Every mode starts away from its default, so a reset that skipped one shows.
    await write(t, "$ tui" + STUCK_INPUT_MODES + "\x1b[?66h\x1b[?6h\x1b[?7l\x1b[?25l\x1b[?2026h");
    expect(await privateModeState(t, 1006)).toBe(1);

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
    expect(await privateModeState(t, 1006)).toBe(2);
    t.dispose();
  });

  it("keeps the cursor and scrollback where they are on the normal screen", async () => {
    const t = createMirror();
    // A stale DECSC at the top-left: a bare `?1049l` would restore it after
    // DECSTR and move the prompt's cursor there.
    const history = Array.from({ length: ROWS * 2 }, (_, i) => `line ${i}`).join("\r\n");
    await write(t, "\x1b7" + history + "\r\n$ prompt" + STUCK_INPUT_MODES);
    const before = cursor(t);
    const scrolledBack = t.buffer.active.baseY;
    expect(scrolledBack).toBeGreaterThan(0);

    await write(t, TERMINAL_MODE_RESET);

    expect(t.buffer.active.type).toBe("normal");
    expect(cursor(t)).toEqual(before);
    expect(t.buffer.active.baseY).toBe(scrolledBack);
    expect(line(t, 0)).toBe("line 0");
    expect(line(t, t.buffer.active.baseY + before.y)).toBe("$ prompt");
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

  it("leaves a later cursor restore with the reset modes, not the program's", async () => {
    const t = createMirror();
    await write(t, "\x1b[?6h\x1b[?7l\x1b7$ prompt");

    await write(t, TERMINAL_MODE_RESET + "\x1b8");

    expect(t.modes.originMode).toBe(false);
    expect(t.modes.wraparoundMode).toBe(true);
    t.dispose();
  });

  it("drops an escape string the program died inside instead of dispatching it", async () => {
    const t = createMirror();
    const titles: string[] = [];
    t.onTitleChange((title) => titles.push(title));
    await write(t, "$ tui\x1b[?1003h\x1b]0;half a title");

    await write(t, TERMINAL_MODE_RESET + "after");

    expect(titles).toEqual([]);
    expect(t.modes.mouseTrackingMode).toBe("none");
    expect(line(t, 0)).toBe("$ tuiafter");
    t.dispose();
  });
});
