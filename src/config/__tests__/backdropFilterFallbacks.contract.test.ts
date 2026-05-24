import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const STYLES_ROOT = path.join(REPO_ROOT, "src/styles/components");

// Surfaces that apply `backdrop-filter` unconditionally must degrade to a
// solid background for engines without backdrop-filter, for users who set
// the OS "reduce transparency" preference (issue #8166), and for users who
// set the OS "increase contrast" preference (issue #8939, macOS Increase
// Contrast which fires prefers-contrast: more but NOT forced-colors:active).
// The three gates are independent concerns and must be separate at-rules,
// and they must appear after the base rule so source-order cascade wins.
const SURFACES = [
  { file: "toolbar.css", selector: ".surface-toolbar" },
  { file: "panels.css", selector: ".surface-chrome" },
] as const;

describe("backdrop-filter fallbacks contract (#8166, #8939)", () => {
  for (const { file, selector } of SURFACES) {
    const css = fs.readFileSync(path.join(STYLES_ROOT, file), "utf8");

    const baseIdx = css.indexOf(`${selector} {`);
    const supportsIdx = css.indexOf("@supports not (backdrop-filter: blur(1px))");
    const reducedIdx = css.indexOf("@media (prefers-reduced-transparency: reduce)");
    const contrastIdx = css.indexOf("@media (prefers-contrast: more)");

    if (baseIdx < 0) throw new Error(`Missing selector ${selector} in ${file}`);
    if (supportsIdx < 0) throw new Error(`Missing @supports in ${file}`);
    if (reducedIdx < 0) throw new Error(`Missing prefers-reduced-transparency in ${file}`);
    if (contrastIdx < 0) throw new Error(`Missing prefers-contrast in ${file}`);

    describe(`${file} — ${selector}`, () => {
      it("has an @supports not (backdrop-filter: blur(1px)) fallback", () => {
        expect(supportsIdx).toBeGreaterThan(-1);
      });

      it("has a @media (prefers-reduced-transparency: reduce) fallback", () => {
        // Guards against the common `reduced` typo — the spec value is `reduce`.
        expect(reducedIdx).toBeGreaterThan(-1);
        expect(css).not.toMatch(/prefers-reduced-transparency:\s*reduced\b/);
      });

      it("has a @media (prefers-contrast: more) fallback (#8939)", () => {
        expect(contrastIdx).toBeGreaterThan(-1);
      });

      it("declares all fallback blocks after the base rule (source-order cascade)", () => {
        expect(baseIdx).toBeGreaterThan(-1);
        expect(supportsIdx).toBeGreaterThan(baseIdx);
        expect(reducedIdx).toBeGreaterThan(baseIdx);
        expect(contrastIdx).toBeGreaterThan(baseIdx);
      });

      it("nulls both prefixed and unprefixed backdrop-filter and restores a solid bg", () => {
        // Each fallback block scopes to the surface selector and zeroes out
        // the filter; the solid background uses an opaque --theme-surface-*
        // token, never a translucent color-mix. We concatenate the three
        // fallback blocks so the assertions exercise all of them.
        const supportsBlock = css.slice(supportsIdx, reducedIdx);
        const reducedBlock = css.slice(reducedIdx, contrastIdx);
        const contrastBlock = css.slice(contrastIdx);

        for (const block of [supportsBlock, reducedBlock, contrastBlock]) {
          expect(block).toMatch(new RegExp(`\\${selector}\\s*{`));
          expect(block).toMatch(/-webkit-backdrop-filter:\s*none/);
          expect(block).toMatch(/[^-]backdrop-filter:\s*none/);
          expect(block).toMatch(/background-color:\s*var\(--theme-surface-(toolbar|sidebar)\)/);
        }
      });

      it("does not use !important (cross-file perf-mode override owns that layer)", () => {
        const supportsBlock = css.slice(supportsIdx, reducedIdx);
        const reducedBlock = css.slice(reducedIdx, contrastIdx);
        const contrastBlock = css.slice(contrastIdx).split("\n}")[0];
        expect(supportsBlock).not.toMatch(/!important/);
        expect(reducedBlock).not.toMatch(/!important/);
        expect(contrastBlock).not.toMatch(/!important/);
      });
    });
  }
});
