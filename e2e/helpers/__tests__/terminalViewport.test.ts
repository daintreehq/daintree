import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { getTerminalViewport, sliceViewportLines } from "../terminal";

describe("sliceViewportLines", () => {
  const buffer = ["l0", "l1", "l2", "l3", "l4", "l5"].join("\n");

  it("returns exactly the rows on screen", () => {
    expect(sliceViewportLines(buffer, 2, 3)).toEqual(["l2", "l3", "l4"]);
  });

  it("returns the top of the buffer when scrolled fully back", () => {
    expect(sliceViewportLines(buffer, 0, 2)).toEqual(["l0", "l1"]);
  });

  it("is clamped to the buffer", () => {
    expect(sliceViewportLines(buffer, 5, 4)).toEqual(["l5"]);
    expect(sliceViewportLines(buffer, -3, 1)).toEqual(["l0"]);
    expect(sliceViewportLines(buffer, 1, 0)).toEqual([]);
  });
});

describe("getTerminalViewport", () => {
  const globals = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete globals.window;
  });

  /** A page whose evaluate runs the callback against `hooks` as the renderer's window. */
  function pageWith(hooks: Record<string, unknown>): Page {
    return {
      evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
        globals.window = hooks;
        return fn(arg);
      },
    } as unknown as Page;
  }

  it("reads the scroll state and buffer of the named panel and keeps only the visible rows", async () => {
    const asked: string[] = [];
    const page = pageWith({
      __daintreeReadTerminalBuffer: (id: string) => {
        asked.push(`buffer:${id}`);
        return ["a", "b", "c", "d", "e"].join("\n");
      },
      __daintreeGetTerminalScrollState: (id: string) => {
        asked.push(`scroll:${id}`);
        return { viewportY: 1, baseY: 2, rows: 2, isUserScrolledBack: true };
      },
    });

    const viewport = await getTerminalViewport(page, "term-1");

    expect(asked.sort()).toEqual(["buffer:term-1", "scroll:term-1"]);
    expect(viewport).toEqual({
      lines: ["b", "c"],
      text: "b\nc",
      viewportY: 1,
      baseY: 2,
      rows: 2,
      isUserScrolledBack: true,
    });
  });

  it("is null when the hooks or the terminal are missing", async () => {
    expect(await getTerminalViewport(pageWith({}), "t")).toBeNull();
    expect(
      await getTerminalViewport(
        pageWith({
          __daintreeReadTerminalBuffer: () => "",
          __daintreeGetTerminalScrollState: () => null,
        }),
        "t"
      )
    ).toBeNull();
  });
});
