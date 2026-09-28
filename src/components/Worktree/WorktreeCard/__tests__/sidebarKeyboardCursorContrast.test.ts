/**
 * The sidebar's keyboard cursor is marked by a 2px left inset edge, and it is
 * the only mark a keyboard user has there: the row's focus ring is suppressed
 * and hover reveals the same toolbar. So the edge owes WCAG 1.4.11's 3:1 on
 * every built-in theme.
 *
 * This reads whichever theme token the rule names and measures it, rather
 * than pinning the token: any ink that clears 3:1 everywhere passes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  BUILT_IN_APP_SCHEMES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "../../../../../shared/theme/index.js";
import type { AppThemeTokenKey } from "../../../../../shared/theme/index.js";

const CSS = readFileSync(
  path.resolve(__dirname, "../../../../styles/components/sidebar.css"),
  "utf8"
);

function keyboardCursorEdgeToken(): AppThemeTokenKey {
  const selector = CSS.indexOf('[data-keyboard-cursor="true"]\n  .sidebar-worktree-card');
  expect(selector, "keyboard-cursor card rule not found in sidebar.css").toBeGreaterThan(-1);
  const block = CSS.slice(CSS.indexOf("{", selector), CSS.indexOf("}", selector));
  const match = block.match(/--card-edge:\s*inset 2px 0 0 var\(--theme-([a-z-]+)\)/);
  expect(match, "keyboard-cursor edge must be a single theme token").not.toBeNull();
  return match![1] as AppThemeTokenKey;
}

describe("sidebar keyboard cursor edge", () => {
  const key = keyboardCursorEdgeToken();

  it.each(BUILT_IN_APP_SCHEMES.map((s) => [s.id, s] as const))(
    "clears 3:1 on the sidebar in %s",
    (_, scheme) => {
      const ink = scheme.tokens[key];
      const bg = scheme.tokens["surface-sidebar"];
      const alpha = parseRgba(ink);
      const painted = alpha ? blendOverBackground(alpha.hex, bg, alpha.opacity) : ink;
      const ratio = contrastRatio(painted, bg);
      expect(
        ratio,
        `${scheme.id} ${key} (${ink}) is ${ratio.toFixed(2)}:1 on ${bg}`
      ).toBeGreaterThanOrEqual(3);
    }
  );
});
