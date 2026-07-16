import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ATLAS_MAX_TEXTURE_SIZE, applyAtlasPageSizeCap } from "../TerminalWebGLAtlasCap";

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

function createProbedAtlasClass() {
  return createAtlasClass({
    maxTextureSize: HARDWARE_MAX_TEXTURE_SIZE,
    maxAtlasPages: HARDWARE_MAX_ATLAS_PAGES,
  });
}

describe("applyAtlasPageSizeCap", () => {
  it("lowers a probed hardware limit to the cap", () => {
    const atlasClass = createProbedAtlasClass();

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxTextureSize).toBeLessThan(HARDWARE_MAX_TEXTURE_SIZE);
    expect(atlasClass.maxTextureSize).toBe(ATLAS_MAX_TEXTURE_SIZE);
  });

  it("leaves maxAtlasPages alone, since it is baked into the shader at GlyphRenderer construction", () => {
    const atlasClass = createProbedAtlasClass();

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxAtlasPages).toBe(HARDWARE_MAX_ATLAS_PAGES);
  });

  it("declines an atlas whose probe has not run, so the cap cannot be overwritten", () => {
    // GlyphRenderer assigns both statics together, gated on maxAtlasPages being
    // undefined. Capping first would be clobbered moments later.
    const atlasClass = createAtlasClass({ maxTextureSize: undefined, maxAtlasPages: undefined });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(false);
    expect(atlasClass.maxTextureSize).toBeUndefined();
  });

  it("caps a probe that set the page count but left the texture size unusable", () => {
    // GlyphRenderer assigns maxAtlasPages before querying MAX_TEXTURE_SIZE, so a
    // throw between the two leaves this state permanently: later renderers skip
    // the probe entirely and the atlas falls back to its own 4096 default.
    const atlasClass = createAtlasClass({
      maxTextureSize: undefined,
      maxAtlasPages: HARDWARE_MAX_ATLAS_PAGES,
    });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxTextureSize).toBe(ATLAS_MAX_TEXTURE_SIZE);
  });

  it("declines when the page count cannot bound the atlas, leaving the cap inert", () => {
    // Reclaim is gated on a truthy maxAtlasPages; without one the atlas grows
    // pages regardless of their size, so reporting success would be a lie.
    for (const maxAtlasPages of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const atlasClass = createAtlasClass({
        maxTextureSize: HARDWARE_MAX_TEXTURE_SIZE,
        maxAtlasPages,
      });

      expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(false);
      expect(atlasClass.maxTextureSize).toBe(HARDWARE_MAX_TEXTURE_SIZE);
    }
  });

  it("never raises a limit that is already below the cap", () => {
    const belowCap = ATLAS_MAX_TEXTURE_SIZE / 2;
    const atlasClass = createAtlasClass({ maxTextureSize: belowCap, maxAtlasPages: 8 });

    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(true);
    expect(atlasClass.maxTextureSize).toBe(belowCap);
  });

  it("does not rewrite a static that is already at the cap", () => {
    let writes = 0;
    let stored: number | undefined = ATLAS_MAX_TEXTURE_SIZE;
    class CountingAtlas {
      public static maxAtlasPages: number | undefined = HARDWARE_MAX_ATLAS_PAGES;
      public static get maxTextureSize(): number | undefined {
        return stored;
      }
      public static set maxTextureSize(value: number | undefined) {
        writes++;
        stored = value;
      }
    }

    expect(applyAtlasPageSizeCap({ _renderer: { _charAtlas: new CountingAtlas() } })).toBe(true);
    expect(writes).toBe(0);
  });

  it("reports failure when the static accepts the write but ignores it", () => {
    // An ignoring setter takes the assignment without throwing and keeps the
    // hardware value. Trusting the write here would retire the retry with the
    // atlas still unbounded, so only a read-back can tell the two apart.
    class SwallowingAtlas {
      public static maxAtlasPages: number | undefined = HARDWARE_MAX_ATLAS_PAGES;
      public static get maxTextureSize(): number | undefined {
        return HARDWARE_MAX_TEXTURE_SIZE;
      }
      public static set maxTextureSize(_value: number | undefined) {
        // accepted and dropped
      }
    }

    expect(applyAtlasPageSizeCap({ _renderer: { _charAtlas: new SwallowingAtlas() } })).toBe(false);
  });

  it("reports failure rather than throwing when the internal shape has drifted", () => {
    class ThrowingAtlas {
      public static get maxAtlasPages(): number {
        throw new Error("internal shape drifted");
      }
    }

    const drifted: object[] = [
      createAddon(),
      {},
      { _renderer: null },
      { _renderer: "not-an-object" },
      { _renderer: { _charAtlas: null } },
      { _renderer: { _charAtlas: 42 } },
      { _renderer: { _charAtlas: { constructor: undefined } } },
      { _renderer: { _charAtlas: { constructor: "not-a-class" } } },
      { _renderer: { _charAtlas: new ThrowingAtlas() } },
    ];

    for (const addon of drifted) {
      expect(applyAtlasPageSizeCap(addon)).toBe(false);
    }
  });

  it("caps a frozen class only if the write lands", () => {
    const atlasClass = createProbedAtlasClass();
    Object.freeze(atlasClass);

    // Strict mode makes the assignment throw; the guard must swallow it and
    // report the atlas as unbounded rather than break the attach path.
    expect(applyAtlasPageSizeCap(createAddon(atlasClass))).toBe(false);
    expect(atlasClass.maxTextureSize).toBe(HARDWARE_MAX_TEXTURE_SIZE);
  });
});

// The cap reaches through the addon's private shape and degrades silently by
// design, so a bump that moved any of this would restore the unbounded growth it
// fixes with no other signal. These match the surrounding mechanism rather than
// bare identifiers: `_charAtlas` alone occurs elsewhere in the bundle, so a
// rename of the one member the cap reaches would slip past a plain search.
describe("pinned @xterm/addon-webgl contract", () => {
  const bundle = readFileSync(
    createRequire(import.meta.url).resolve("@xterm/addon-webgl/lib/addon-webgl.mjs"),
    "utf8"
  );

  it("still grows pages only by the merge rule the cap constrains", () => {
    expect(bundle).toMatch(/canvas\.width\s*\*\s*2\s*<=\s*\(?\s*\w+\.maxTextureSize\s*\|\|/);
  });

  it("still probes both statics together, which is why the cap has to run after activation", () => {
    expect(bundle).toMatch(/MAX_TEXTURE_IMAGE_UNITS[\s\S]{0,120}\.maxTextureSize\s*=/);
  });

  it("still gates page reclaim on the page count the cap leaves at its hardware value", () => {
    expect(bundle).toMatch(/\w+\.maxAtlasPages\s*&&/);
  });

  it("still exposes the renderer and atlas the cap reaches through", () => {
    expect(bundle).toMatch(/this\._renderer\s*=/);
    expect(bundle).toMatch(/this\._charAtlas\s*=\s*\w+\s*,\s*this\._charAtlas\.warmUp\(\)/);
  });
});
