// Chromium in Electron 45 ignores a canvas `font` assignment that starts with
// whitespace, leaving the context on its previous font (`10px sans-serif` on a
// fresh one). xterm 6.1 builds glyph-atlas fonts as `${italic} ${weight} ${size}px
// ${family}`, which leads with a space for every upright glyph, so WebGL
// terminals rasterized all text at 10px device pixels into full-size cells:
// tiny, widely spaced glyphs while box drawing (drawn as geometry) stayed right.
// Trimming is lossless because surrounding whitespace never changes the meaning
// of a CSS font shorthand. The probe makes the shim retire itself once Chromium
// accepts the padded form again.

type FontPrototype = { font: string };

const PROBE_FONT = " 13px monospace";

function rejectsPaddedFont(ctx: FontPrototype | null): boolean {
  if (!ctx) return false;
  try {
    ctx.font = PROBE_FONT;
    return ctx.font !== PROBE_FONT.trim();
  } catch {
    return false;
  }
}

export function patchFontSetter(proto: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(proto, "font");
  const set = descriptor?.set;
  if (!descriptor || !set || !descriptor.configurable) return false;
  Object.defineProperty(proto, "font", {
    ...descriptor,
    set(this: unknown, value: unknown) {
      set.call(this, typeof value === "string" ? value.trim() : value);
    },
  });
  return true;
}

export function installCanvasFontWhitespaceShim(): void {
  if (typeof document === "undefined") return;

  if (typeof CanvasRenderingContext2D !== "undefined") {
    const ctx = document.createElement("canvas").getContext("2d");
    if (rejectsPaddedFont(ctx)) patchFontSetter(CanvasRenderingContext2D.prototype);
  }

  if (
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvasRenderingContext2D !== "undefined"
  ) {
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    if (rejectsPaddedFont(ctx)) patchFontSetter(OffscreenCanvasRenderingContext2D.prototype);
  }
}

installCanvasFontWhitespaceShim();
