import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHostStylesheet } from "../../../scripts/lib/host-css.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const INDEX_CSS_PATH = path.join(REPO_ROOT, "src/index.css");
export const DESIGN_CONTRACT_CSS_PATH = path.join(REPO_ROOT, "src/styles/design-contract.css");

/**
 * `src/index.css` as one text: the entry with the `src/styles/host/` partials it
 * was split into (#13321) expanded in place, in import order. Any suite asserting
 * on a host rule reads this, never the entry file, which holds almost nothing.
 */
export function readIndexCss(): string {
  return readHostStylesheet(INDEX_CSS_PATH).css;
}

/**
 * The host's full CSS surface: `src/index.css` (with its host partials) plus the
 * design contract it imports.
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
  return `${fs.readFileSync(DESIGN_CONTRACT_CSS_PATH, "utf8")}\n${readIndexCss()}`;
}
