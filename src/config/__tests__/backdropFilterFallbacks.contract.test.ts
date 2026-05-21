import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const STYLES_ROOT = path.join(REPO_ROOT, "src/styles/components");

// Surfaces that apply `backdrop-filter` unconditionally must degrade to a
// solid background for engines without backdrop-filter and for users who set
// the OS "reduce transparency" accessibility preference (issue #8166). The
// two gates are independent concerns and must be separate at-rules (a
// GPU-capable machine can still have Reduce Transparency enabled), and they
// must appear after the base rule so source-order cascade wins.
const SURFACES = [
  { file: "toolbar.css", selector: ".surface-toolbar" },
  { file: "panels.css", selector: ".surface-chrome" },
] as const;

describe("backdrop-filter fallbacks contract (#8166)", () => {
  for (const { file, selector } of SURFACES) {
    const css = fs.readFileSync(path.join(STYLES_ROOT, file), "utf8");

    const baseIdx = css.indexOf(`${selector} {`);
    const supportsIdx = css.indexOf("@supports not (backdrop-filter: blur(1px))");
    const mediaIdx = css.indexOf("@media (prefers-reduced-transparency: reduce)");

    if (baseIdx < 0) throw new Error(`Missing selector ${selector} in ${file}`);
    if (supportsIdx < 0) throw new Error(`Missing @supports in ${file}`);
    if (mediaIdx < 0) throw new Error(`Missing @media in ${file}`);

    describe(`${file} — ${selector}`, () => {
      it("has an @supports not (backdrop-filter: blur(1px)) fallback", () => {
        expect(supportsIdx).toBeGreaterThan(-1);
      });

      it("has a @media (prefers-reduced-transparency: reduce) fallback", () => {
        // Guards against the common `reduced` typo — the spec value is `reduce`.
        expect(mediaIdx).toBeGreaterThan(-1);
        expect(css).not.toMatch(/prefers-reduced-transparency:\s*reduced\b/);
      });

      it("declares both fallback blocks after the base rule (source-order cascade)", () => {
        expect(baseIdx).toBeGreaterThan(-1);
        expect(supportsIdx).toBeGreaterThan(baseIdx);
        expect(mediaIdx).toBeGreaterThan(baseIdx);
      });

      it("nulls both prefixed and unprefixed backdrop-filter and restores a solid bg", () => {
        // Both fallback blocks scope to the surface selector and zero out the
        // filter; the solid background uses an opaque --theme-surface-* token,
        // never a translucent color-mix.
        // @ts-expect-error - indices verified not -1 by guard checks above
        const blocks = css
          .slice(supportsIdx)
          .split("@media (prefers-reduced-transparency: reduce)")[0]
          .concat(css.slice(mediaIdx));
        expect(blocks).toMatch(new RegExp(`\\${selector}\\s*{`));
        expect(blocks).toMatch(/-webkit-backdrop-filter:\s*none/);
        expect(blocks).toMatch(/[^-]backdrop-filter:\s*none/);
        expect(blocks).toMatch(/background-color:\s*var\(--theme-surface-(toolbar|sidebar)\)/);
      });

      it("does not use !important (cross-file perf-mode override owns that layer)", () => {
        const supportsBlock = css
          .slice(supportsIdx)
          .split("@media (prefers-reduced-transparency: reduce)")[0];
        const mediaBlock = css.slice(mediaIdx).split("\n}")[0];
        expect(supportsBlock).not.toMatch(/!important/);
        expect(mediaBlock).not.toMatch(/!important/);
      });
    });
  }
});
