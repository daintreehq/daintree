import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_TREE_ICON_CLASS } from "@/panels/file-browser/fileTypeIcons";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const INDEX_CSS = path.join(REPO_ROOT, "src/index.css");

// Issue #11596: the file-browser tree tints file icons with category-* hues so
// types separate at a glance. Those hues are tuned for restrained chroma, not
// for maximum contrast, so Increase Contrast repaints them monochrome — the
// glyph shapes already carry the type, and the hue is the expendable half.
// jsdom never evaluates media queries, so the rule is guarded here in source.

/** CSS with every `/* … *​/` comment blanked, so a marker quoted in prose can't match. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Bodies of every `@media (<query>)` block in a stylesheet, brace-matched. */
function readMediaBlocks(file: string, query: string): string {
  const content = stripComments(fs.readFileSync(file, "utf8"));
  const marker = `@media (${query})`;
  const blocks: string[] = [];

  let searchFrom = 0;
  for (;;) {
    const start = content.indexOf(marker, searchFrom);
    if (start === -1) break;

    const open = content.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(content.slice(open, end + 1));
    searchFrom = end + 1;
  }

  return blocks.join("\n");
}

// The class name is imported, not spelled out, so the component and this test
// can never drift onto two different selectors.
const SELECTOR = new RegExp(`\\.${FILE_TREE_ICON_CLASS}\\s*\\{([^}]*)\\}`);

describe("file-tree icon contrast contract (#11596)", () => {
  it("repaints entry icons with the solid text token under Increase Contrast", () => {
    const block = readMediaBlocks(INDEX_CSS, "prefers-contrast: more");
    // Fail loudly rather than vacuously if the whole block ever disappears.
    expect(block).not.toBe("");

    const rule = block.match(SELECTOR);
    expect(rule, `no .${FILE_TREE_ICON_CLASS} rule under prefers-contrast`).toBeTruthy();

    const body = rule![1]!;
    // Specifically the `color` property set to the solid primary-text token.
    // The leading boundary matters: without it `background-color` or
    // `border-color` would satisfy this while the glyph itself stayed tinted.
    // And `transparent`, `inherit` or a category hue would all satisfy a bare
    // "sets a color" assertion while leaving Increase Contrast users exactly
    // where they started.
    expect(body).toMatch(/(^|[;{\s])color:\s*var\(--color-daintree-text\)/);
    expect(body).not.toMatch(/category/);
  });

  it("leaves the icons opted in to forced-colors", () => {
    // These icons paint from `currentColor`, and forced-colors already forces
    // `color` to a system keyword — so no rule is needed there. But opting out
    // with `forced-color-adjust: none` would strand High Contrast users on the
    // category hues, so guard that no rule naming these icons ever does.
    //
    // Scoped to rules that name the icon class: the property inherits, so an
    // ancestor opting out would defeat this too, but enumerating every possible
    // ancestor selector is not something a source scan can do honestly.
    const content = stripComments(fs.readFileSync(INDEX_CSS, "utf8"));
    const rules = [
      ...content.matchAll(new RegExp(`\\.${FILE_TREE_ICON_CLASS}[^{}]*\\{([^}]*)\\}`, "g")),
    ];
    // Non-vacuous: there is at least one such rule to inspect.
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule[1]).not.toMatch(/forced-color-adjust:\s*none/);
    }
  });
});
