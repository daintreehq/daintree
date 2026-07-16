// xterm's TextureAtlas is module-global and shared by every terminal whose
// font/theme config matches, so it outlives any single terminal's dispose
// (CharAtlasCache only frees it when the last owner goes away). Its glyph cache
// is keyed by code + bg + fg + ext with no per-entry eviction, so truecolor
// agent output grows it monotonically.
//
// Pages are always created at ATLAS_PAGE_START_SIZE and only grow by merging 4
// same-size pages into one of double the size, gated on
// `page.width * 2 <= TextureAtlas.maxTextureSize`. Left at the hardware default
// (gl.MAX_TEXTURE_SIZE, often 16384) pages ratchet 512 -> 1024 -> ... -> 16384,
// which is why a busy view never plateaus.
//
// Capping maxTextureSize bounds the atlas at maxAtlasPages * cap^2 * 4 bytes and
// caps merging at a single generation (512 -> 1024). That is strictly less
// merging than the default, which matters beyond memory: a merge rewrites glyph
// texturePage indices while each renderer keeps its own model buffers (#8080),
// whereas the alternative capacity path, _evictAllPages, is a clean reset that
// fires onRemoveTextureAtlasCanvas for every co-owner and is already handled by
// scheduleAtlasResync.
//
// 1024 rather than the 512 page size: pinning the cap to the page size would bar
// merging entirely, but it also quarters glyph capacity, and a working set that
// outgrows the atlas evicts on a loop. 1024 keeps ~4x the slots for the tiled
// truecolor fleet this bounds, and stays a hard plateau either way.
export const ATLAS_MAX_TEXTURE_SIZE = 1024;

// Mirrors TextureAtlas's own initial page size. Pages are only ever allocated at
// this size; anything larger is the product of a merge.
export const ATLAS_PAGE_START_SIZE = 512;

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

// The TextureAtlas class is private to the addon bundle: neither the package
// exports nor the typings expose it, and deep-importing its source would yield a
// different class than the one closed over by the shipped bundle. A live atlas
// instance's constructor is that class. Walked defensively so a drifted internal
// shape degrades to "not capped" instead of throwing.
function readAtlasStatics(addon: object): AtlasStatics | null {
  if (!("_renderer" in addon) || !isObject(addon._renderer)) return null;
  const renderer = addon._renderer;
  if (!("_charAtlas" in renderer) || !isObject(renderer._charAtlas)) return null;
  const ctor: unknown = renderer._charAtlas.constructor;
  return isAtlasStatics(ctor) ? ctor : null;
}

// Returns whether the atlas is bounded, i.e. capped now or already at/below the
// cap. False means the statics were unreachable or uninitialized and the caller
// should retry on a later attach.
export function applyAtlasPageSizeCap(addon: object): boolean {
  const statics = readAtlasStatics(addon);
  if (!statics) return false;

  // GlyphRenderer lazily initializes maxAtlasPages and maxTextureSize together
  // on its first construction, gated on maxAtlasPages being undefined. Writing
  // the cap before that runs would be overwritten by the hardware probe, so an
  // uninitialized atlas is left alone rather than capped early.
  if (typeof statics.maxTextureSize !== "number") return false;
  if (statics.maxTextureSize <= ATLAS_MAX_TEXTURE_SIZE) return true;

  try {
    statics.maxTextureSize = ATLAS_MAX_TEXTURE_SIZE;
    return true;
  } catch {
    return false;
  }
}

// Worst-case bytes of atlas pages once every page has merged up to the cap.
// maxAtlasPages is left at the hardware value because it is baked into the
// fragment shader and the renderer's texture-unit binding at GlyphRenderer
// construction; lowering it afterwards would desync the two.
export function atlasByteCeiling(maxAtlasPages: number, maxTextureSize: number): number {
  // Mirrors TextureAtlas._createNewPage, which only reclaims once the page count
  // reaches max(4, maxAtlasPages) — a lower cap cannot shrink the atlas below 4
  // pages.
  const pages = Math.max(4, maxAtlasPages);
  return pages * maxTextureSize * maxTextureSize * 4;
}

// A page is merge-eligible only while doubling it stays within the cap, so the
// cap decides how many merge generations exist above the start size.
export function isPageMergeEligible(pageWidth: number, maxTextureSize: number): boolean {
  return pageWidth * 2 <= maxTextureSize;
}
