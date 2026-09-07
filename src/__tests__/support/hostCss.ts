import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");
export const DESIGN_CONTRACT_CSS_PATH = path.join(REPO_ROOT, "src/styles/design-contract.css");

/**
 * The host's full CSS surface: `src/index.css` plus the design contract it
 * imports.
 *
 * These two files were one until #12220 split the `@theme` and
 * `@custom-variant` blocks out so the renderer's plugin Tailwind compiler could
 * consume the same bytes. Every contract suite that scans "the host's CSS" for
 * tokens wants both halves — reading `index.css` alone after the split finds no
 * `--color-*` declarations at all, which does not fail loudly so much as make a
 * token guard pass over an empty set.
 *
 * Concatenation is exact rather than approximate: the split moved text, it did
 * not duplicate any, so what any scan finds here is what it found before.
 */
export function readHostCss(): string {
  return `${fs.readFileSync(DESIGN_CONTRACT_CSS_PATH, "utf8")}\n${fs.readFileSync(INDEX_CSS_PATH, "utf8")}`;
}
