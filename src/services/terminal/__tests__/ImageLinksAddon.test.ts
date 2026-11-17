// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { IBufferRange, ILink } from "@xterm/xterm";
import { ImageLinksAddon } from "../ImageLinksAddon";

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function render(
  cols: number,
  data: string,
  size: { rows: number; scrollback: number } = { rows: 10, scrollback: 2000 }
): Promise<HeadlessTerminal> {
  const terminal = new HeadlessTerminal({ cols, ...size });
  await write(terminal, data);
  return terminal;
}

function provide(addon: ImageLinksAddon, y: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => addon.provideLinks(y, resolve));
}

async function setup(data: string, figureNumbers: number[], cols = 80) {
  const terminal = await render(cols, data);
  const onActivate = vi.fn();
  const addon = new ImageLinksAddon(terminal, () => figureNumbers, onActivate);
  return { terminal, addon, onActivate };
}

function range(startX: number, startY: number, endX: number, endY: number): IBufferRange {
  return { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
}

const mouseEvent = (mods: Partial<MouseEvent> = {}): MouseEvent =>
  ({ metaKey: false, ctrlKey: false, ...mods }) as unknown as MouseEvent;

describe("ImageLinksAddon", () => {
  describe("matching", () => {
    it("matches a bracketed reference when the figure exists", async () => {
      const { addon } = await setup("See [image #2] for details", [1, 2, 3]);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[image #2]");
    });

    it("matches a bare reference when the figure exists", async () => {
      const { addon } = await setup("Compare with image #3 above", [3]);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #3");
    });

    it("matches case-insensitively", async () => {
      const { addon } = await setup("See [IMAGE #2]", [2]);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[IMAGE #2]");
    });

    it("matches multiple references on one line", async () => {
      const { addon } = await setup("[image #1] and [image #2]", [1, 2]);
      const links = await provide(addon, 1);
      expect(links?.map((link) => link.text)).toEqual(["[image #1]", "[image #2]"]);
    });

    it("computes a 1-based inclusive range on the hovered row", async () => {
      const { addon } = await setup("\r\n".repeat(6) + "ab [image #5]", [5]);
      const links = await provide(addon, 7);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(4, 7, 13, 7));
    });
  });

  describe("cell columns", () => {
    it("starts after wide characters at the cell the reference is drawn in", async () => {
      const { terminal, addon } = await setup("日本語 [image #1]", [1]);
      expect(terminal.buffer.active.getLine(0)!.getCell(0)!.getWidth()).toBe(2);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[image #1]");
      expect(links![0]!.range).toEqual(range(8, 1, 17, 1));
    });

    it("counts a combining mark as part of its base character's cell", async () => {
      const { addon } = await setup("café [image #1]", [1]);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(6, 1, 15, 1));
    });

    it("counts a surrogate pair as the one cell it was drawn in", async () => {
      const { terminal, addon } = await setup("\u{10400} image #4", [4]);
      expect(terminal.buffer.active.getLine(0)!.getCell(0)!.getWidth()).toBe(1);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #4");
      expect(links![0]!.range).toEqual(range(3, 1, 10, 1));
    });

    it("ends before a wide character the next row took", async () => {
      const { terminal, addon } = await setup(" image #1界", [1], 10);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(2, 1, 9, 1));
      expect(await provide(addon, 2)).toBeUndefined();
    });

    it("maps a reference after a wide character pushed past the edge", async () => {
      // The wide character can't fit in the last column, so xterm leaves that
      // cell empty and draws it at the start of the next row.
      const { terminal, addon } = await setup("abcdefghijk日[image #1]", [1], 12);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      expect(await provide(addon, 1)).toBeUndefined();
      const links = await provide(addon, 2);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(3, 2, 12, 2));
    });

    it("reads a cell the cursor skipped over as a space", async () => {
      const { addon } = await setup("[image\x1b[C#1]", [1]);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[image #1]");
      expect(links![0]!.range).toEqual(range(1, 1, 10, 1));
    });

    it("keeps the text of a zero-width cell that isn't half of a wide character", async () => {
      // An SGR reset ends the join, so xterm gives the accent a cell of its own.
      const { terminal, addon } = await setup("[ima\x1b[0m\u0301ge #1]", [1]);
      const accent = terminal.buffer.active.getLine(0)!.getCell(4)!;
      expect([accent.getChars(), accent.getWidth()]).toEqual(["\u0301", 0]);
      expect(await provide(addon, 1)).toBeUndefined();
    });
  });

  describe("soft wraps", () => {
    it("links a reference xterm wrapped onto the next row from either row", async () => {
      const { terminal, addon } = await setup("see [image #1] ok", [1], 10);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      for (const y of [1, 2]) {
        const links = await provide(addon, y);
        expect(links).toHaveLength(1);
        expect(links![0]!.text).toBe("[image #1]");
        expect(links![0]!.range).toEqual(range(5, 1, 4, 2));
      }
    });

    it("links a reference after wide characters that the wrap splits", async () => {
      const { addon } = await setup("日本語 [image #1]", [1], 12);
      for (const y of [1, 2]) {
        const links = await provide(addon, y);
        expect(links).toHaveLength(1);
        expect(links![0]!.range).toEqual(range(8, 1, 5, 2));
      }
    });

    it("keeps a space printed in the last column", async () => {
      const { addon } = await setup("[image #1]", [1], 7);
      for (const y of [1, 2]) {
        const links = await provide(addon, y);
        expect(links).toHaveLength(1);
        expect(links![0]!.text).toBe("[image #1]");
        expect(links![0]!.range).toEqual(range(1, 1, 3, 2));
      }
    });

    it("links a reference spread over three rows from each of them", async () => {
      const { addon } = await setup("[image #12]", [12], 4);
      for (const y of [1, 2, 3]) {
        const links = await provide(addon, y);
        expect(links).toHaveLength(1);
        expect(links![0]!.text).toBe("[image #12]");
        expect(links![0]!.range).toEqual(range(1, 1, 3, 3));
      }
    });

    it("reads a figure number the wrap splits as the whole number", async () => {
      const { addon, onActivate } = await setup("image #12", [1, 12], 8);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #12");
      links![0]!.activate(mouseEvent(), links![0]!.text);
      expect(onActivate).toHaveBeenCalledWith(12, false);
    });

    it("leaves a split figure number inert when only its prefix is a figure", async () => {
      const { addon } = await setup("image #12", [1], 8);
      expect(await provide(addon, 1)).toBeUndefined();
      expect(await provide(addon, 2)).toBeUndefined();
    });

    it("guards the bare form with the word the wrap broke before it", async () => {
      const { addon } = await setup("abcdefreimage #2", [2], 8);
      expect(await provide(addon, 2)).toBeUndefined();
    });

    it("reports only the references that touch the hovered row", async () => {
      const { addon } = await setup("[image #1] " + "x".repeat(20) + " [image #2]", [1, 2], 10);
      expect((await provide(addon, 1))?.map((link) => link.text)).toEqual(["[image #1]"]);
      expect(await provide(addon, 2)).toBeUndefined();
      expect((await provide(addon, 4))?.map((link) => link.text)).toEqual(["[image #2]"]);
    });

    it("finds a reference at the end of a long wrapped run without reading the whole run", async () => {
      const { terminal, addon } = await setup("x".repeat(5000) + " [image #3]", [3], 10);
      const last = terminal.buffer.active.length;
      const getLine = vi.spyOn(terminal.buffer.active, "getLine");
      const links = await provide(addon, last);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[image #3]");
      expect(getLine.mock.calls.length).toBeLessThan(100);
    });

    it("finds a reference at the start of a long wrapped run without reading the whole run", async () => {
      const { terminal, addon } = await setup("[image #3] " + "x".repeat(5000), [3], 10);
      const getLine = vi.spyOn(terminal.buffer.active, "getLine");
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("[image #3]");
      expect(getLine.mock.calls.length).toBeLessThan(100);
    });
  });

  describe("hard line breaks", () => {
    it("keeps a reference broken by a newline as two fragments", async () => {
      const { terminal, addon } = await setup("see [image\r\n#1] ok", [1], 11);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(false);
      expect(await provide(addon, 1)).toBeUndefined();
      expect(await provide(addon, 2)).toBeUndefined();
    });

    it("keeps the fragments apart when the first fills the row to the edge", async () => {
      const { terminal, addon } = await setup("see [image\r\n #1] ok", [1], 10);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(false);
      expect(await provide(addon, 1)).toBeUndefined();
      expect(await provide(addon, 2)).toBeUndefined();
    });

    it("reads digits before a newline as their own figure number", async () => {
      const { addon } = await setup("image #1\r\n2", [1, 12], 8);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #1");
      expect(await provide(addon, 2)).toBeUndefined();
    });
  });

  describe("clipped lines", () => {
    it("leaves a bare match inert when scrollback dropped the row before it", async () => {
      const terminal = await render(4, "abc[image #1]\r\nz", { rows: 3, scrollback: 1 });
      const first = terminal.buffer.active.getLine(0)!;
      expect(first.isWrapped).toBe(true);
      expect(first.translateToString(true)).toBe("imag");
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      for (const y of [1, 2]) expect(await provide(addon, y)).toBeUndefined();
    });

    it("leaves a bare match inert when a narrowed pane hides the rest of its row", async () => {
      const terminal = await render(9, "\x1b[?1049himage #12");
      terminal.resize(8, 10);
      expect(terminal.buffer.active.getLine(0)!.length).toBeGreaterThan(terminal.cols);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("still links a bracketed reference cut off from what came before it", async () => {
      const terminal = await render(10, "abcdefghij[image #1]\r\ny\r\nz", {
        rows: 2,
        scrollback: 1,
      });
      expect(terminal.buffer.active.getLine(0)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(1, 1, 10, 1));
    });

    it("links a bare match a space separates from the clipped start", async () => {
      const terminal = await render(10, "abcdefghijx image #1\r\ny\r\nz", {
        rows: 2,
        scrollback: 1,
      });
      expect(terminal.buffer.active.getLine(0)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #1");
      expect(links![0]!.range).toEqual(range(3, 1, 10, 1));
    });

    it("never reads past the last row into the scrollback's first", async () => {
      // Row 0 is the wrapped tail of an evicted line; a full ring buffer hands
      // it back for the index one past the end.
      const terminal = await render(8, "abcdefgh2\r\nx\r\nimage #1", { rows: 2, scrollback: 1 });
      expect(terminal.buffer.active.length).toBe(3);
      expect(terminal.buffer.active.getLine(0)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1, 12], vi.fn());
      const links = await provide(addon, 3);
      expect(links).toHaveLength(1);
      expect(links![0]!.text).toBe("image #1");
      expect(links![0]!.range).toEqual(range(1, 3, 8, 3));
    });

    it("doesn't join a narrowed row to a wrap that may have been made at the old width", async () => {
      // `image #1`, an erased cell, then `2` on the wrapped row: once the pane
      // narrows past the erased cell, the rows read like a wrapped `image #12`.
      const terminal = await render(9, "\x1b[?1049himage #1X2\x1b[1;9H\x1b[X");
      terminal.resize(8, 10);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe("image #1");
      const addon = new ImageLinksAddon(terminal, () => [1, 12], vi.fn());
      for (const y of [1, 2]) expect(await provide(addon, y)).toBeUndefined();
    });

    it("doesn't join a wrap a widening cut back to the pane's width", async () => {
      // The wrap was made at 9 columns; widening from 7 to 8 trims the row to
      // 8, dropping the `X`, so nothing in the row's length shows the old width.
      const terminal = await render(9, "\x1b[?1049himage #1X2");
      terminal.resize(7, 10);
      terminal.resize(8, 10);
      const first = terminal.buffer.active.getLine(0)!;
      expect(first.length).toBe(terminal.cols);
      expect(first.translateToString(true)).toBe("image #1");
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1, 12], vi.fn());
      for (const y of [1, 2]) expect(await provide(addon, y)).toBeUndefined();
    });

    it("reads an alternate-buffer wrap as an edge, since its width can't be known", async () => {
      const terminal = await render(10, "\x1b[?1049hsee [image #1]\r\n[image #2]");
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1, 2], vi.fn());
      for (const y of [1, 2]) expect(await provide(addon, y)).toBeUndefined();
      expect((await provide(addon, 3))?.map((link) => link.text)).toEqual(["[image #2]"]);
    });

    it("links a reference ending a narrowed row when nothing is hidden or wrapped", async () => {
      const terminal = await render(9, "\x1b[?1049himage #1\r\nok");
      terminal.resize(8, 10);
      expect(terminal.buffer.active.getLine(0)!.length).toBeGreaterThan(terminal.cols);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(1, 1, 8, 1));
    });

    it("leaves a bracketed reference inert when a narrowed pane hides its end", async () => {
      const terminal = await render(10, "\x1b[?1049h[image #1]");
      terminal.resize(8, 10);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("doesn't join the visible parts of a row across the text a narrowing hid", async () => {
      const terminal = await render(9, "\x1b[?1049hxx[imageX #1]");
      terminal.resize(8, 10);
      expect(terminal.buffer.active.getLine(1)!.isWrapped).toBe(true);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      for (const y of [1, 2]) expect(await provide(addon, y)).toBeUndefined();
    });

    it("still links a bracketed reference that ends where a narrowing hid the rest", async () => {
      const terminal = await render(11, "\x1b[?1049h[image #1]X");
      terminal.resize(10, 10);
      const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      expect(links![0]!.range).toEqual(range(1, 1, 10, 1));
    });
  });

  describe("inert cases", () => {
    it("returns undefined for an unknown figure number", async () => {
      const { addon } = await setup("See [image #9]", [1, 2]);
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("returns undefined without reading the buffer when no figures exist", async () => {
      const { terminal, addon } = await setup("See [image #1]", []);
      const getLine = vi.spyOn(terminal.buffer.active, "getLine");
      expect(await provide(addon, 1)).toBeUndefined();
      expect(getLine).not.toHaveBeenCalled();
    });

    it("does not match an unterminated bracketed reference", async () => {
      const { addon } = await setup("see [image #1 here", [1]);
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("links only the known figures on a mixed line", async () => {
      const { addon } = await setup("[image #1] then [image #9]", [1]);
      const links = await provide(addon, 1);
      expect(links?.map((link) => link.text)).toEqual(["[image #1]"]);
    });

    it("does not match when preceded by a word character", async () => {
      const { addon } = await setup("reimage #2 done", [2]);
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("does not match when followed by a word character", async () => {
      const { addon } = await setup("image #2abc", [2]);
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("does not match a missing figure number", async () => {
      const { addon } = await setup("see [image #] here", [1, 2]);
      expect(await provide(addon, 1)).toBeUndefined();
    });

    it("returns undefined for line numbers below 1", async () => {
      const { addon } = await setup("[image #1]", [1]);
      expect(await provide(addon, 0)).toBeUndefined();
    });

    it("returns undefined when the buffer line is missing", async () => {
      const { addon } = await setup("[image #1]", [1]);
      expect(await provide(addon, 500)).toBeUndefined();
    });
  });

  describe("activation", () => {
    it("ignores a click once output rewrote part of a wrapped reference", async () => {
      const { terminal, addon, onActivate } = await setup("[image #1]", [1, 2], 8);
      const links = await provide(addon, 1);
      expect(links).toHaveLength(1);
      await write(terminal, "\x1b[2;1H2]");
      links![0]!.activate(mouseEvent(), links![0]!.text);
      expect(onActivate).not.toHaveBeenCalled();
      expect((await provide(addon, 1))?.map((link) => link.text)).toEqual(["[image #2]"]);
    });

    it("activates with openLightbox=false on a plain click", async () => {
      const { addon, onActivate } = await setup("[image #2]", [2]);
      const links = await provide(addon, 1);
      links![0]!.activate(mouseEvent(), links![0]!.text);
      expect(onActivate).toHaveBeenCalledWith(2, false);
    });

    it("activates with openLightbox=true on a meta click", async () => {
      const { addon, onActivate } = await setup("[image #2]", [2]);
      const links = await provide(addon, 1);
      links![0]!.activate(mouseEvent({ metaKey: true }), links![0]!.text);
      expect(onActivate).toHaveBeenCalledWith(2, true);
    });

    it("activates with openLightbox=true on a ctrl click", async () => {
      const { addon, onActivate } = await setup("[image #2]", [2]);
      const links = await provide(addon, 1);
      links![0]!.activate(mouseEvent({ ctrlKey: true }), links![0]!.text);
      expect(onActivate).toHaveBeenCalledWith(2, true);
    });
  });

  describe("live figure state", () => {
    it("reflects figure changes without re-registration", async () => {
      const terminal = await render(80, "[image #4]");
      let figures: number[] = [];
      const addon = new ImageLinksAddon(terminal, () => figures, vi.fn());
      expect(await provide(addon, 1)).toBeUndefined();
      figures = [4];
      const after = await provide(addon, 1);
      expect(after).toHaveLength(1);
      expect(after![0]!.text).toBe("[image #4]");
    });
  });
});
