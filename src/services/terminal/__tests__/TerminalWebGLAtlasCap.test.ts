import { describe, expect, it } from "vitest";
import {
  ATLAS_MAX_TEXTURE_SIZE,
  ATLAS_PAGE_START_SIZE,
  applyAtlasPageSizeCap,
  atlasByteCeiling,
  isPageMergeEligible,
} from "../TerminalWebGLAtlasCap";

// Mirrors the shipped addon: TextureAtlas holds the limits as statics on the
// class, and the only handle we get on that class is a live atlas instance's
// constructor.
function createAtlasClass(statics: { maxTextureSize?: number; maxAtlasPages?: number }) {
  class FakeTextureAtlas {
    public static maxTextureSize = statics.maxTextureSize;
    public static maxAtlasPages = statics.maxAtlasPages;
  }
  return FakeTextureAtlas;
}

function createAddon(atlasClass?: ReturnType<typeof createAtlasClass>): object {
  return { _renderer: atlasClass ? { _charAtlas: new atlasClass() } : {} };
}

// GlyphRenderer's hardware probe, which is what runs when the cap is absent.
const HARDWARE_MAX_TEXTURE_SIZE = 16384;
const HARDWARE_MAX_ATLAS_PAGES = 16;

describe("applyAtlasPageSizeCap", () => {
  it("lowers an initialized hardware limit to the cap", () => {
    const atlasClass = createAtlasClass({
      maxTextureSize: HARDWARE_MAX_TEXTURE_SIZE,
      maxAtlasPages: HARDWARE_MAX_ATLAS_PAGES,
    });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxTextureSize).toBeLessThan(HARDWARE_MAX_TEXTURE_SIZE);
    expect(atlasClass.maxTextureSize).toBe(ATLAS_MAX_TEXTURE_SIZE);
  });

  it("leaves maxAtlasPages alone, since it is baked into the shader at GlyphRenderer construction", () => {
    const atlasClass = createAtlasClass({
      maxTextureSize: HARDWARE_MAX_TEXTURE_SIZE,
      maxAtlasPages: HARDWARE_MAX_ATLAS_PAGES,
    });

    applyAtlasPageSizeCap(createAddon(atlasClass));

    expect(atlasClass.maxAtlasPages).toBe(HARDWARE_MAX_ATLAS_PAGES);
  });

  it("declines an uninitialized atlas so the hardware probe cannot overwrite the cap", () => {
    // GlyphRenderer initializes both statics together, gated on maxAtlasPages
    // being undefined. Capping first would be clobbered moments later.
    const atlasClass = createAtlasClass({ maxTextureSize: undefined, maxAtlasPages: undefined });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(false);
    expect(atlasClass.maxTextureSize).toBeUndefined();
  });

  it("never raises a limit that is already below the cap", () => {
    const belowCap = ATLAS_MAX_TEXTURE_SIZE / 2;
    const atlasClass = createAtlasClass({ maxTextureSize: belowCap, maxAtlasPages: 8 });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxTextureSize).toBe(belowCap);
  });

  it("is idempotent across repeated attaches", () => {
    const atlasClass = createAtlasClass({
      maxTextureSize: HARDWARE_MAX_TEXTURE_SIZE,
      maxAtlasPages: HARDWARE_MAX_ATLAS_PAGES,
    });
    const addon = createAddon(atlasClass);

    applyAtlasPageSizeCap(addon);
    const afterFirst = atlasClass.maxTextureSize;

    expect(applyAtlasPageSizeCap(addon)).toBe(true);
    expect(atlasClass.maxTextureSize).toBe(afterFirst);
  });

  it("reports failure rather than throwing when the internal shape has drifted", () => {
    expect(applyAtlasPageSizeCap(createAddon())).toBe(false);
    expect(applyAtlasPageSizeCap({})).toBe(false);
    expect(applyAtlasPageSizeCap({ _renderer: { _charAtlas: null } })).toBe(false);
  });
});

describe("merge generations under the cap", () => {
  it("allows a freshly allocated page to merge exactly once", () => {
    const merged = ATLAS_PAGE_START_SIZE * 2;

    expect(isPageMergeEligible(ATLAS_PAGE_START_SIZE, ATLAS_MAX_TEXTURE_SIZE)).toBe(true);
    expect(isPageMergeEligible(merged, ATLAS_MAX_TEXTURE_SIZE)).toBe(false);
  });

  it("permits far more merge generations at the hardware limit than under the cap", () => {
    const generations = (limit: number): number => {
      let count = 0;
      for (let width = ATLAS_PAGE_START_SIZE; isPageMergeEligible(width, limit); width *= 2) {
        count++;
      }
      return count;
    };

    expect(generations(ATLAS_MAX_TEXTURE_SIZE)).toBeLessThan(
      generations(HARDWARE_MAX_TEXTURE_SIZE)
    );
  });

  it("keeps the cap at or above the size pages are allocated at", () => {
    // A cap below the start size would bar merging outright and quarter the
    // glyph capacity, which trades unbounded growth for eviction churn.
    expect(ATLAS_MAX_TEXTURE_SIZE).toBeGreaterThanOrEqual(ATLAS_PAGE_START_SIZE);
  });
});

describe("atlasByteCeiling", () => {
  it("bounds the atlas far below the uncapped hardware ceiling", () => {
    const capped = atlasByteCeiling(HARDWARE_MAX_ATLAS_PAGES, ATLAS_MAX_TEXTURE_SIZE);
    const uncapped = atlasByteCeiling(HARDWARE_MAX_ATLAS_PAGES, HARDWARE_MAX_TEXTURE_SIZE);

    expect(capped).toBeLessThan(uncapped);
  });

  it("holds the capped ceiling within the renderer's memory budget on the widest hardware", () => {
    // 32 is the most pages xterm will use (Math.min(32, MAX_TEXTURE_IMAGE_UNITS)).
    // The issue reports a view climbing past 1GB, so the bound is what makes a
    // busy view plateau.
    const widestHardware = atlasByteCeiling(32, ATLAS_MAX_TEXTURE_SIZE);

    expect(widestHardware).toBeLessThanOrEqual(128 * 1024 * 1024);
  });

  it("cannot shrink the atlas below the four-page floor the atlas enforces", () => {
    const belowFloor = atlasByteCeiling(1, ATLAS_MAX_TEXTURE_SIZE);
    const atFloor = atlasByteCeiling(4, ATLAS_MAX_TEXTURE_SIZE);

    expect(belowFloor).toBe(atFloor);
  });

  it("scales with page count above the floor", () => {
    expect(atlasByteCeiling(16, ATLAS_MAX_TEXTURE_SIZE)).toBeGreaterThan(
      atlasByteCeiling(8, ATLAS_MAX_TEXTURE_SIZE)
    );
  });
});
