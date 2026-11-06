import { describe, expect, it } from "vitest";
import { patchFontSetter } from "../canvasFontWhitespaceShim";

// Mirrors the Electron 45 Chromium behaviour: a padded shorthand is rejected and
// the previous font is kept.
class StrictFontContext {
  private value = "10px sans-serif";
  get font(): string {
    return this.value;
  }
  set font(next: string) {
    if (next !== next.trim()) return;
    this.value = next;
  }
}

describe("patchFontSetter", () => {
  it("trims the leading space xterm puts on upright glyph fonts", () => {
    expect(patchFontSetter(StrictFontContext.prototype)).toBe(true);

    const ctx = new StrictFontContext();
    ctx.font = ' normal 24px "JetBrains Mono", monospace';
    expect(ctx.font).toBe('normal 24px "JetBrains Mono", monospace');

    ctx.font = 'italic 700 24px "JetBrains Mono", monospace';
    expect(ctx.font).toBe('italic 700 24px "JetBrains Mono", monospace');
  });

  it("leaves a prototype without a configurable font accessor alone", () => {
    const proto = {};
    Object.defineProperty(proto, "font", { value: "x", writable: true, configurable: false });
    expect(patchFontSetter(proto)).toBe(false);
    expect(patchFontSetter({})).toBe(false);
  });
});
