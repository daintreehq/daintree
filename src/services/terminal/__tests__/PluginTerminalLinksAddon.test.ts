// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";
import {
  PluginTerminalLinksAddon,
  type PluginLinkTerminal,
  type PluginTerminalLinkHandlers,
} from "../PluginTerminalLinksAddon";
import type { PluginPatternLinkMatch } from "../pluginTerminalLinks";
import type { PluginTerminalLink } from "@/store/pluginRuntimeStore";
import {
  TERMINAL_LINK_SCAN_MAX_CHARS,
  compileTerminalLinkPattern,
  findTerminalLinkMatches,
} from "@shared/utils/pluginTerminalLinks";

const WIDE = new Set(["界", "😀"]);

type BufferLine = NonNullable<ReturnType<PluginLinkTerminal["buffer"]["active"]["getLine"]>>;

/** A buffer line drawn from `text`, wide characters taking two cells as xterm draws them. */
function lineOf(text: string): BufferLine {
  const cells: { chars: string; width: number }[] = [];
  for (const ch of text) {
    if (WIDE.has(ch)) {
      cells.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
    } else {
      cells.push({ chars: ch, width: 1 });
    }
  }
  return {
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      if (!cell) return undefined;
      return { getChars: () => cell.chars, getWidth: () => cell.width };
    },
  };
}

/** A terminal whose one row can be rewritten between asks. */
function terminalWith(initial: BufferLine | undefined) {
  const state = { line: initial };
  const terminal: PluginLinkTerminal = { buffer: { active: { getLine: () => state.line } } };
  return { terminal, state };
}

const ENTRY = {
  key: "acme::invoice",
  pluginId: "acme",
  pluginName: "Acme",
  projectId: null,
  actionId: "acme.open",
  link: { id: "invoice", actionId: "acme.open", pattern: "INV-\\d{1,4}" },
} satisfies PluginTerminalLink;

/** Runs a pattern the way the worker does, without the stores or a worker. */
function finder(pattern: string): (text: string) => Promise<PluginPatternLinkMatch[]> {
  const regex = compileTerminalLinkPattern(pattern)!;
  return (text) =>
    Promise.resolve(
      findTerminalLinkMatches(regex, text).map((match) => ({ ...match, entry: ENTRY }))
    );
}

/** The links xterm would be handed for row `y`, or undefined. */
function provide(addon: PluginTerminalLinksAddon, y = 1): Promise<ILink[] | undefined> {
  return new Promise((resolve) => addon.provideLinks(y, resolve));
}

function setup(text: string | undefined, overrides: Partial<PluginTerminalLinkHandlers> = {}) {
  const handlers: PluginTerminalLinkHandlers = {
    find: vi.fn(finder("INV-\\d{1,4}")),
    activate: vi.fn(),
    hover: vi.fn(),
    leave: vi.fn(),
    ...overrides,
  };
  const { terminal, state } = terminalWith(text === undefined ? undefined : lineOf(text));
  return { addon: new PluginTerminalLinksAddon(terminal, handlers), handlers, state };
}

describe("PluginTerminalLinksAddon", () => {
  it("links each match on the hovered row, with 1-based inclusive cell ranges", async () => {
    const { addon } = setup("see INV-42 and INV-7");
    const links = await provide(addon, 3);
    expect(links?.map((l) => [l.text, l.range])).toEqual([
      ["INV-42", { start: { x: 5, y: 3 }, end: { x: 10, y: 3 } }],
      ["INV-7", { start: { x: 16, y: 3 }, end: { x: 20, y: 3 } }],
    ]);
    expect(links?.[0]?.decorations).toEqual({ pointerCursor: true, underline: true });
  });

  it("maps a match after wide characters back to the cells they were drawn in", async () => {
    const { addon } = setup("界😀 INV-9");
    // 界 and 😀 take two cells each, so INV-9 starts at column 6 (1-based).
    expect((await provide(addon))?.[0]?.range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 10, y: 1 },
    });
  });

  it("asks for nothing on a missing or blank row", async () => {
    const missing = setup(undefined);
    expect(await provide(missing.addon)).toBeUndefined();
    expect(await provide(missing.addon, 0)).toBeUndefined();
    const blank = setup("     ");
    expect(await provide(blank.addon)).toBeUndefined();
    expect(blank.handlers.find).not.toHaveBeenCalled();
  });

  it("returns no links when the row has no match", async () => {
    expect(await provide(setup("nothing here").addon)).toBeUndefined();
  });

  it("refuses a match the scan cap cut short", async () => {
    // `ID-12345` would end exactly at the cap, where `\b` sees the end of text.
    const row = " ".repeat(TERMINAL_LINK_SCAN_MAX_CHARS - 8) + "ID-123456789";
    const { addon, handlers } = setup(row, { find: vi.fn(finder("ID-\\d{1,5}\\b")) });
    expect(await provide(addon)).toBeUndefined();
    expect(vi.mocked(handlers.find).mock.calls[0]?.[0].length).toBeLessThan(row.length);
  });

  it("drops a reply when output rewrote the row while matching", async () => {
    let finish!: (matches: PluginPatternLinkMatch[]) => void;
    const { addon, state } = setup("INV-1", {
      find: () => new Promise((resolve) => (finish = resolve)),
    });
    const links = provide(addon);
    state.line = lineOf("other text");
    finish(await finder("INV-\\d{1,4}")("INV-1"));
    expect(await links).toBeUndefined();
  });

  it("never answers after it was disposed", async () => {
    let finish!: (matches: PluginPatternLinkMatch[]) => void;
    const { addon } = setup("INV-1", { find: () => new Promise((resolve) => (finish = resolve)) });
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    addon.dispose();
    finish(await finder("INV-\\d{1,4}")("INV-1"));
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it("answers nothing once disposed, and its earlier links go inert", async () => {
    const { addon, handlers } = setup("INV-1");
    const link = (await provide(addon))![0]!;
    addon.dispose();
    const callback = vi.fn();
    addon.provideLinks(1, callback);
    addon.provideLinks(0, callback);
    expect(callback).not.toHaveBeenCalled();

    const event = new MouseEvent("click");
    link.hover?.(event, link.text);
    link.activate(event, link.text);
    expect(handlers.hover).not.toHaveBeenCalled();
    expect(handlers.activate).not.toHaveBeenCalled();
  });

  it("routes activation, hover and leave to the handlers with the match", async () => {
    const { addon, handlers } = setup("INV-1");
    const link = (await provide(addon))![0]!;
    const event = new MouseEvent("click");
    link.hover?.(event, link.text);
    link.activate(event, link.text);
    link.leave?.(event, link.text);
    const [match] = await vi.mocked(handlers.find).mock.results[0]!.value;
    expect(handlers.hover).toHaveBeenCalledWith(match, event);
    expect(handlers.activate).toHaveBeenCalledWith(match, event);
    expect(handlers.leave).toHaveBeenCalledTimes(1);
  });
});
