// xterm's TextureAtlas is module-global and shared by every terminal whose
// font/theme config matches, so it outlives any single terminal's dispose
// (CharAtlasCache only frees it when the last owner goes away). Its glyph cache
// is keyed by code + bg + fg + ext with no per-entry eviction, so truecolor
// agent output only ever adds to it.
//
// Pages are allocated at 512px and only grow by merging 4 same-size pages into
// one of double the size, gated on `page.width * 2 <= maxTextureSize`. Left at
// the hardware default (gl.MAX_TEXTURE_SIZE, often 16384) pages ratchet
// 512 -> 1024 -> ... -> 16384, and because a merge always succeeds there is
// effectively no path to _evictAllPages — which is the only thing that clears
// the glyph cache maps. That is why a streaming view never plateaus.
//
// Capping maxTextureSize is what makes eviction reachable: once every page has
// merged to the cap none are merge-eligible, so the next page demand evicts,
// dropping the pages AND both cache maps. Empty glyphs (a colored space
// rasterizes to a shared NULL_RASTERIZED_GLYPH) never consume pixels and so
// never create page pressure themselves, but they are cached, and the eviction
// this cap induces is what bounds them too.
//
// 1024 rather than the 512 page size: pinning the cap to the page size would bar
// merging entirely, but it also quarters glyph capacity, and a working set that
// outgrows the atlas evicts on a loop — sustained re-rasterization across every
// co-owning pane. 1024 keeps ~3.5x the slots for the tiled truecolor fleet this
// bounds, and both settings plateau.
//
// Bound: maxAtlasPages * 1024^2 * 4 bytes of page backing store, i.e. 64MB at 16
// texture units and 128MB at 32. That covers the regular pages of one atlas
// config in this renderer — not the single hardware-sized overflow page for
// glyphs wider than a page (pre-existing, reset by the same eviction), and not
// the per-context copies each GlyphRenderer uploads to the GPU process.
export const ATLAS_MAX_TEXTURE_SIZE = 1024;

type AtlasStatics = {
  maxTextureSize?: number;
  maxAtlasPages?: number;
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

// The statics live on the class, and a class is a function.
function isAtlasStatics(value: unknown): value is AtlasStatics {
  return typeof value === "function";
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// The TextureAtlas class is private to the addon bundle: neither the package
// exports nor the typings expose it, and deep-importing its source would yield a
// different class than the one closed over by the shipped bundle. A live atlas
// instance's constructor is that class.
function readAtlasStatics(addon: object): AtlasStatics | null {
  if (!("_renderer" in addon) || !isObject(addon._renderer)) return null;
  const renderer = addon._renderer;
  if (!("_charAtlas" in renderer) || !isObject(renderer._charAtlas)) return null;
  const ctor: unknown = renderer._charAtlas.constructor;
  return isAtlasStatics(ctor) ? ctor : null;
}

// Returns whether the atlas is bounded. False means the internals were
// unreachable or the atlas cannot be bounded, and the caller should retry on a
// later attach. Every read is guarded: an addon whose internal shape has drifted
// must degrade to "not capped" rather than throw, since this runs inside the
// attach path and an escaping error would drop the terminal to DOM rendering.
export function applyAtlasPageSizeCap(addon: object): boolean {
  try {
    const statics = readAtlasStatics(addon);
    if (!statics) return false;

    // A live atlas proves GlyphRenderer's constructor already ran, and with it
    // the hardware probe that assigns both statics — gated on maxAtlasPages
    // alone — so it can no longer overwrite the cap. maxAtlasPages also gates
    // reclaim itself (`if (maxAtlasPages && pages.length >= ...)`), so without a
    // positive value there is nothing to bound and the cap would be inert.
    if (!isPositiveFinite(statics.maxAtlasPages)) return false;

    if (
      !isPositiveFinite(statics.maxTextureSize) ||
      statics.maxTextureSize > ATLAS_MAX_TEXTURE_SIZE
    ) {
      statics.maxTextureSize = ATLAS_MAX_TEXTURE_SIZE;
    }

    // Read back rather than trust the write: a getter-only or proxied static
    // swallows it, and reporting success would retire the retry.
    return (
      isPositiveFinite(statics.maxTextureSize) && statics.maxTextureSize <= ATLAS_MAX_TEXTURE_SIZE
    );
  } catch {
    return false;
  }
}
