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
import { TERMINAL_LINK_SCAN_MAX_CHARS } from "@shared/utils/pluginTerminalLinks";

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

function terminalWith(line: BufferLine | undefined): PluginLinkTerminal {
  return { buffer: { active: { getLine: () => line } } };
}

const ENTRY = {
  key: "acme::invoice",
  pluginId: "acme",
  pluginName: "Acme",
  projectId: null,
  actionId: "acme.open",
  link: { id: "invoice", actionId: "acme.open", pattern: "INV-\\d{1,4}" },
} satisfies PluginTerminalLink;

/** Finds `INV-<digits>` the way the live matcher would, without the stores. */
function findInvoices(text: string): PluginPatternLinkMatch[] {
  return Array.from(text.matchAll(/INV-\d{1,4}/g), (m) => ({
    entry: ENTRY,
    index: m.index,
    text: m[0],
    groups: [],
  }));
}

function provide(addon: PluginTerminalLinksAddon, y = 1): ILink[] | undefined {
  let result: ILink[] | undefined;
  addon.provideLinks(y, (links) => {
    result = links;
  });
  return result;
}

function setup(text: string | undefined, overrides: Partial<PluginTerminalLinkHandlers> = {}) {
  const handlers: PluginTerminalLinkHandlers = {
    find: vi.fn(findInvoices),
    activate: vi.fn(),
    hover: vi.fn(),
    leave: vi.fn(),
    ...overrides,
  };
  const terminal = terminalWith(text === undefined ? undefined : lineOf(text));
  return { addon: new PluginTerminalLinksAddon(terminal, handlers), handlers, terminal };
}

describe("PluginTerminalLinksAddon", () => {
  it("links each match on the hovered row, with 1-based inclusive cell ranges", () => {
    const { addon } = setup("see INV-42 and INV-7");
    const links = provide(addon, 3);
    expect(links?.map((l) => [l.text, l.range])).toEqual([
      ["INV-42", { start: { x: 5, y: 3 }, end: { x: 10, y: 3 } }],
      ["INV-7", { start: { x: 16, y: 3 }, end: { x: 20, y: 3 } }],
    ]);
    expect(links?.[0]?.decorations).toEqual({ pointerCursor: true, underline: true });
  });

  it("maps a match after wide characters back to the cells they were drawn in", () => {
    const { addon } = setup("界😀 INV-9");
    // 界 and 😀 take two cells each, so INV-9 starts at column 6 (1-based).
    expect(provide(addon)?.[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 10, y: 1 } });
  });

  it("asks for nothing on a missing or blank row", () => {
    const missing = setup(undefined);
    expect(provide(missing.addon)).toBeUndefined();
    expect(provide(missing.addon, 0)).toBeUndefined();
    const blank = setup("     ");
    expect(provide(blank.addon)).toBeUndefined();
    expect(blank.handlers.find).not.toHaveBeenCalled();
  });

  it("returns no links when the row has no match", () => {
    expect(provide(setup("nothing here").addon)).toBeUndefined();
  });

  it("hands the plugin no more of the row than the scan cap", () => {
    const { addon, handlers } = setup("x".repeat(TERMINAL_LINK_SCAN_MAX_CHARS + 100));
    provide(addon);
    expect(vi.mocked(handlers.find).mock.calls[0]?.[0]).toHaveLength(TERMINAL_LINK_SCAN_MAX_CHARS);
  });

  it("routes activation, hover and leave to the handlers with the match", () => {
    const { addon, handlers } = setup("INV-1");
    const link = provide(addon)![0]!;
    const event = new MouseEvent("click");
    link.hover?.(event, link.text);
    link.activate(event, link.text);
    link.leave?.(event, link.text);
    const match = vi.mocked(handlers.find).mock.results[0]?.value[0];
    expect(handlers.hover).toHaveBeenCalledWith(match, event);
    expect(handlers.activate).toHaveBeenCalledWith(match, event);
    expect(handlers.leave).toHaveBeenCalledTimes(1);
  });
});
