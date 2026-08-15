import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { hasUsableRenderer } from "../xtermRendererProbe";

type Probed = Pick<Terminal, "dimensions">;

/** An object carrying a `dimensions` accessor that yields whatever is given. */
function withDimensions(produce: () => Terminal["dimensions"]): Probed {
  return {
    get dimensions() {
      return produce();
    },
  };
}

const SOME_DIMENSIONS = {
  css: { canvas: { width: 800, height: 600 }, cell: { width: 8, height: 16 } },
  device: { canvas: { width: 800, height: 600 }, cell: { width: 8, height: 16 } },
} as unknown as NonNullable<Terminal["dimensions"]>;

describe("hasUsableRenderer", () => {
  it("reports healthy when the terminal exposes real dimensions", () => {
    expect(hasUsableRenderer(withDimensions(() => SOME_DIMENSIONS))).toBe(true);
  });

  it("reports broken when the accessor yields undefined", () => {
    // This is the poisoned state from #11776: xterm's `dimensions` getter
    // returns undefined precisely when `_renderService` was never built, which
    // is what a throw between CoreBrowserService and RenderService leaves
    // behind.
    expect(hasUsableRenderer(withDimensions(() => undefined))).toBe(false);
  });

  it("reports broken when reading dimensions throws", () => {
    // RenderService.dimensions dereferences its renderer, so a throw means
    // there is a service but nothing that can paint — just as unusable.
    expect(
      hasUsableRenderer(
        withDimensions(() => {
          throw new Error("Cannot read properties of undefined (reading 'dimensions')");
        })
      )
    ).toBe(false);
  });

  it("reports healthy when the terminal has no dimensions accessor at all", () => {
    // The unknown-shape bias. An xterm without the accessor (a different
    // version, or a hand-built test double) must not be treated as broken —
    // guessing "poisoned" here would push healthy terminals into the rebuild
    // path on every single open.
    expect(hasUsableRenderer({} as Probed)).toBe(true);
  });

  it("distinguishes a missing accessor from a present-but-undefined one", () => {
    // The two cases are one `in` check apart and resolve to OPPOSITE verdicts,
    // so a refactor that collapses them would silently break one of them.
    const absent = {} as Probed;
    const presentButEmpty = withDimensions(() => undefined);

    expect(absent.dimensions).toBeUndefined();
    expect(presentButEmpty.dimensions).toBeUndefined();
    expect(hasUsableRenderer(absent)).not.toBe(hasUsableRenderer(presentButEmpty));
  });
});
