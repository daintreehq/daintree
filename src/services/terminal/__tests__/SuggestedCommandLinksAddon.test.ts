// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { ILink } from "@xterm/xterm";
import {
  SuggestedCommandLinksAddon,
  findSuggestedCommand,
  readSuggestedCommand,
} from "../SuggestedCommandLinksAddon";

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

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

function commandAt(terminal: HeadlessTerminal, row: number): string | null {
  return findSuggestedCommand(terminal.buffer.active, terminal.cols, row)?.command ?? null;
}

const GIT_HEAD = "  ! git log --oneline --decorate --graph --all --since=2.weeks";
const GIT_TAIL = "  --author=someone@example.com --format=%h %s";
const LONG_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

describe("findSuggestedCommand", () => {
  it("reads a suggestion set off by blank lines", async () => {
    const terminal = await render(150, [
      "  run this yourself:",
      "",
      "  ! sentry auth login --read-only",
      "",
      "  It uses a device-code flow: it shows a code and a URL.",
    ]);
    expect(commandAt(terminal, 2)).toBe("sentry auth login --read-only");
    expect(findSuggestedCommand(terminal.buffer.active, 150, 2)?.range).toEqual({
      start: { x: 5, y: 3 },
      end: { x: 33, y: 3 },
    });
    expect(commandAt(terminal, 0)).toBeNull();
    expect(commandAt(terminal, 4)).toBeNull();
  });

  it("reads a suggestion with no blank line before it, keeping quotes and pipes", async () => {
    const command =
      "winctl ps 'Get-CimInstance Win32_Process | ? CommandLine -match \"cc-say\" | % { Stop-Process -Id $_.ProcessId -Force }'";
    const terminal = await render(150, [
      "  stops the sound immediately. To kill it from here, type this in the prompt:",
      `  ! ${command}`,
      "",
      "  What's still in that state:",
    ]);
    expect(commandAt(terminal, 1)).toBe(command);
    expect(commandAt(terminal, 0)).toBeNull();
    // Prose above can't hold a command, so the line before needn't be blank
    // even where the wrap width is unknown.
    expect(findSuggestedCommand(terminal.buffer.active, 150, 1, 4)?.command).toBe(command);
  });

  it("joins a word-wrapped command with the space the wrap dropped, from either row", async () => {
    const terminal = await render(70, [GIT_HEAD, GIT_TAIL, "", "  Thanks."]);
    const expected =
      "git log --oneline --decorate --graph --all --since=2.weeks --author=someone@example.com --format=%h %s";
    expect(commandAt(terminal, 0)).toBe(expected);
    expect(commandAt(terminal, 1)).toBe(expected);
    expect(findSuggestedCommand(terminal.buffer.active, 70, 1)?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: GIT_TAIL.length, y: 2 },
    });
    expect(commandAt(terminal, 3)).toBeNull();
  });

  // A token cut mid-word and a word that ended exactly at the margin leave the
  // same two rows, and only one of them has a space at the join.
  it("leaves a command inert when its row is filled to the edge before a wrap", async () => {
    const head = `  ! echo ${LONG_TOKEN.slice(0, 61)}`;
    expect(head).toHaveLength(70);
    const cut = await render(70, [head, `  ${LONG_TOKEN.slice(61)}ABCDEFGHIJ done`, ""]);
    expect(commandAt(cut, 0)).toBeNull();
    expect(commandAt(cut, 1)).toBeNull();

    const wrapped = await render(70, [`  ! echo ${"a".repeat(61)}`, "  --dry-run", ""]);
    expect(commandAt(wrapped, 0)).toBeNull();
  });

  it("leaves a command inert when a wide glyph couldn't fit at the end of its row", async () => {
    const terminal = await render(70, [`  ! echo ${"a".repeat(60)}`, "  界界界 done"]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("ends at a row filled to the edge when nothing continues it", async () => {
    const head = `  ! echo ${"a".repeat(61)}`;
    const terminal = await render(70, [head, "", "  Then check."]);
    expect(commandAt(terminal, 0)).toBe(`echo ${"a".repeat(61)}`);
  });

  it("leaves a command inert when its continuation reads as a new suggestion", async () => {
    const terminal = await render(70, [`  ! echo ${"a".repeat(57)} ok`, "  ! false"]);
    expect(commandAt(terminal, 0)).toBeNull();
    expect(commandAt(terminal, 1)).toBeNull();
  });

  it("stops at an indented line whose first word would have fit above", async () => {
    const terminal = await render(70, ["  ! npm test", "  Then check the output."]);
    expect(commandAt(terminal, 0)).toBe("npm test");
    expect(commandAt(terminal, 1)).toBeNull();
  });

  it("keeps adjacent suggestions apart", async () => {
    const terminal = await render(70, ["  ! npm install", "  ! npm run build"]);
    expect(commandAt(terminal, 0)).toBe("npm install");
    expect(commandAt(terminal, 1)).toBe("npm run build");
  });

  it("reads a suggestion on a message's first line, after the message marker", async () => {
    const terminal = await render(70, ["⏺ ! gh auth login", ""]);
    expect(commandAt(terminal, 0)).toBe("gh auth login");
  });

  it("ignores a ! that is not a suggestion line", async () => {
    const terminal = await render(80, [
      "  if (!raw || !event.metaKey) return;",
      "  !event.metaKey;",
      "  !raw ||",
      "    ! indented too far",
      "   ! three spaces",
      " ! one space",
      "  !no-space",
      "  ! ",
      "  - ! not a head",
      "  Run it yourself: ! npm test",
    ]);
    for (let row = 0; row < 10; row++) expect(commandAt(terminal, row)).toBeNull();
  });

  it("joins a command xterm wrapped itself, character for character", async () => {
    const command = `echo ${"x".repeat(40)} ${"y".repeat(30)}`;
    const terminal = await render(40, [`  ! ${command}`, ""]);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(commandAt(terminal, 0)).toBe(command);
    expect(commandAt(terminal, 1)).toBe(command);
  });

  it("leaves a hard wrap after an xterm wrap inert, since the wrap width is unknown", async () => {
    const terminal = await render(40, [
      `  ! echo ${"x".repeat(31)} ${"y".repeat(39)}`,
      `  ${"z".repeat(30)}`,
    ]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("leaves a wrapped command inert on rows laid out for another width", async () => {
    const terminal = await render(70, [GIT_HEAD, GIT_TAIL, "", "  ! npm test", ""]);
    const buffer = terminal.buffer.active;
    expect(findSuggestedCommand(buffer, 70, 0, 2)).toBeNull();
    expect(findSuggestedCommand(buffer, 70, 1, 2)).toBeNull();
    expect(findSuggestedCommand(buffer, 70, 0, 1)).toBeNull();
    expect(findSuggestedCommand(buffer, 70, 3, 2)?.command).toBe("npm test");
    expect(findSuggestedCommand(buffer, 70, 3, 5)?.command).toBe("npm test");
  });

  it("leaves a command inert when xterm wrapped a blank row into it", async () => {
    const terminal = await render(70, [`  ! echo '${"a".repeat(60)}${" ".repeat(70)}b'`, ""]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("leaves a command inert when xterm padded a wide character onto the next row", async () => {
    const terminal = await render(70, [`  ! echo ${"a".repeat(60)}界`, ""]);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("refuses a command ending in a backslash", async () => {
    const terminal = await render(70, ["  ! echo foo\\", ""]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("refuses a command with concealed text", async () => {
    const terminal = await render(80, ["  ! echo safe\x1b[8m; rm -rf ~\x1b[28m", ""]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("refuses a command drawn in its own background colour", async () => {
    const terminal = await render(80, [
      "  ! echo safe\x1b[38;5;1m\x1b[48;5;1m; rm -rf ~\x1b[0m",
      "",
    ]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it.each([
    ["an explicit foreground", "\x1b[31m"],
    ["an explicit background", "\x1b[48;2;201;209;217m"],
    ["inverse video", "\x1b[7m"],
    ["dim text", "\x1b[2m"],
  ])("refuses a command drawn with %s", async (_name, sgr) => {
    const terminal = await render(80, [`  ! echo safe${sgr}; touch /tmp/hidden\x1b[0m`, ""]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("reads a suggestion whose marker is coloured", async () => {
    const terminal = await render(70, ["\x1b[38;2;255;255;255m⏺\x1b[39m ! npm test", ""]);
    expect(commandAt(terminal, 0)).toBe("npm test");
  });

  it.each([
    ["Braille blank", "\u2800"],
    ["zero-width space", "\u200b"],
    ["bidi override", "\u202e"],
    ["no-break space", "\u00a0"],
    ["word joiner", "\u2060"],
    ["variation selector", "\ufe0f"],
    ["Hangul filler", "\u3164"],
  ])("refuses a command containing a %s", async (_name, ch) => {
    const terminal = await render(80, [`  ! echo a${ch}b`, ""]);
    expect(commandAt(terminal, 0)).toBeNull();
  });

  it("refuses a continuation row that hides text", async () => {
    const terminal = await render(70, [GIT_HEAD, `  --author=a@b.c\x1b[8m; curl evil\x1b[28m`]);
    expect(commandAt(terminal, 0)).toBeNull();
    expect(commandAt(terminal, 1)).toBeNull();
  });

  it("reads only from the head row it is given", async () => {
    const terminal = await render(70, [GIT_HEAD, GIT_TAIL]);
    expect(readSuggestedCommand(terminal.buffer.active, 70, 1)).toBeNull();
  });
});

describe("SuggestedCommandLinksAddon", () => {
  const CLICK = new MouseEvent("click");

  function provide(addon: SuggestedCommandLinksAddon, line: number): ILink[] | undefined {
    let result: ILink[] | undefined;
    addon.provideLinks(line, (links) => {
      result = links;
    });
    return result;
  }

  it("provides one link per suggestion with pointer and underline, and runs it on click", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    const onRun = vi.fn();
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, onRun);
    const links = provide(addon, 1);
    expect(links).toHaveLength(1);
    expect(links![0]!.text).toBe("npm test");
    expect(links![0]!.decorations).toEqual({ pointerCursor: true, underline: true });
    expect(links![0]!.hover).toBeUndefined();
    links![0]!.activate(CLICK, links![0]!.text);
    expect(onRun).toHaveBeenCalledWith("npm test");
  });

  it("provides nothing while the pane isn't eligible", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    const addon = new SuggestedCommandLinksAddon(terminal, () => false, vi.fn());
    expect(provide(addon, 1)).toBeUndefined();
  });

  it("re-checks eligibility on click", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    let enabled = true;
    const onRun = vi.fn();
    const addon = new SuggestedCommandLinksAddon(terminal, () => enabled, onRun);
    const [link] = provide(addon, 1)!;
    enabled = false;
    link!.activate(CLICK, link!.text);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("runs nothing when the screen changed under a hovered link", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    const onRun = vi.fn();
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, onRun);
    const [link] = provide(addon, 1)!;
    await new Promise<void>((resolve) => terminal.write("\x1b[1;1H  ! rm -rf ~", resolve));
    link!.activate(CLICK, link!.text);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("ignores the second click of a double click", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    const onRun = vi.fn();
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, onRun);
    const [link] = provide(addon, 1)!;
    link!.activate(new MouseEvent("click", { detail: 2 }), link!.text);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("links a wrapped command written after it started, not one already on screen", async () => {
    const before = await render(70, [GIT_HEAD, GIT_TAIL, ""]);
    expect(provide(new SuggestedCommandLinksAddon(before, () => true, vi.fn()), 1)).toBeUndefined();

    const terminal = new HeadlessTerminal({ cols: 70, rows: 30, allowProposedApi: true });
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, vi.fn());
    await write(terminal, [GIT_HEAD, GIT_TAIL, ""].join("\r\n"));
    expect(provide(addon, 2)?.[0]?.text).toMatch(/--since=2\.weeks --author=/);
  });

  it("stops linking wrapped commands after a width change until the screen is repainted", async () => {
    const terminal = new HeadlessTerminal({
      cols: 70,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, vi.fn());
    await write(terminal, ["", "", "", GIT_HEAD, GIT_TAIL].join("\r\n"));
    const head = terminal.buffer.active.length - 1;
    expect(provide(addon, head)).toHaveLength(1);

    // Still on screen but laid out for 70 columns: at 100 the tail would fit.
    terminal.resize(100, 5);
    expect(provide(addon, head)).toBeUndefined();

    const repaint = [`  ! echo ${"a".repeat(90)}`, `  ${"b".repeat(20)}`];
    await write(terminal, "\x1b[H\x1b[2K" + repaint.join("\r\n\x1b[2K"));
    const top = terminal.buffer.active.baseY + 1;
    expect(provide(addon, top + 1)?.[0]?.text).toBe(`echo ${"a".repeat(90)} ${"b".repeat(20)}`);
  });

  it("keeps linking new wrapped commands as scrollback trims older rows", async () => {
    const terminal = new HeadlessTerminal({
      cols: 70,
      rows: 5,
      scrollback: 5,
      allowProposedApi: true,
    });
    await write(terminal, Array.from({ length: 10 }, (_, i) => `  prose ${i}`).join("\r\n"));
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, vi.fn());
    await write(terminal, ["", "", "", GIT_HEAD, GIT_TAIL].join("\r\n"));
    const head = terminal.buffer.active.length - 1;
    expect(terminal.buffer.active.getLine(head - 1)?.translateToString(true)).toBe(GIT_HEAD);
    expect(provide(addon, head)).toHaveLength(1);
  });

  it("tells a clean copy which rows were laid out at the width it has now, links or not", async () => {
    const terminal = await render(70, ["  laid out before it started", "  and this one"]);
    const addon = new SuggestedCommandLinksAddon(terminal, () => false, vi.fn());
    const buffer = terminal.buffer.active;
    expect(addon.widthKnownFrom(buffer)).toBe(2);

    await write(terminal, "\r\n  written since");
    expect(addon.widthKnownFrom(buffer)).toBe(2);

    terminal.resize(100, 30);
    expect(addon.widthKnownFrom(buffer)).toBe(3);

    addon.dispose();
    expect(addon.widthKnownFrom(buffer)).toBe(buffer.length);
  });

  it("runs nothing after it is disposed", async () => {
    const terminal = await render(70, ["  ! npm test", ""]);
    const onRun = vi.fn();
    const addon = new SuggestedCommandLinksAddon(terminal, () => true, onRun);
    const [link] = provide(addon, 1)!;
    addon.dispose();
    link!.activate(CLICK, link!.text);
    expect(onRun).not.toHaveBeenCalled();
    expect(provide(addon, 1)).toBeUndefined();
  });
});
