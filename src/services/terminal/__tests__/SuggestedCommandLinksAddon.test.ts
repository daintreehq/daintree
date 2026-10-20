// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { ILink } from "@xterm/xterm";
import {
  SuggestedCommandLinksAddon,
  findSuggestedCommand,
  readSuggestedCommand,
} from "../SuggestedCommandLinksAddon";

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

  it("rejoins a token cut mid-word at the right edge without a space", async () => {
    const head = `  ! echo ${LONG_TOKEN.slice(0, 61)}`;
    expect(head).toHaveLength(70);
    const terminal = await render(70, [head, `  ${LONG_TOKEN.slice(61)}ABCDEFGHIJ done`, ""]);
    expect(commandAt(terminal, 1)).toBe(`echo ${LONG_TOKEN}ABCDEFGHIJ done`);
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
