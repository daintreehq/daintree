import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CANOPY_CSS = fs.readFileSync(
  path.resolve(TEST_DIR, "../../../styles/components/canopy.css"),
  "utf8"
);
const SIDEBAR_CSS = fs.readFileSync(
  path.resolve(TEST_DIR, "../../../styles/components/sidebar.css"),
  "utf8"
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
}

function edge(body: string, property: string): string {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(body);
  expect(match, "rule sets no edge").not.toBeNull();
  return match![1]!.replace(/\s+/g, " ").trim();
}

describe("canopy row edge", () => {
  it("marks the selected row with the worktree sidebar's own solid accent edge", () => {
    expect(
      edge(ruleBody(CANOPY_CSS, '.canopy-inbox-row[aria-selected="true"]'), "--canopy-row-edge")
    ).toBe(
      edge(ruleBody(SIDEBAR_CSS, '.sidebar-worktree-card[data-active="true"]'), "--card-edge")
    );
  });

  it("turns the edge neutral once the keyboard leaves the list, in the same shape", () => {
    const selected = edge(
      ruleBody(CANOPY_CSS, '.canopy-inbox-row[aria-selected="true"]'),
      "--canopy-row-edge"
    );
    const receded = edge(
      ruleBody(
        CANOPY_CSS,
        '.canopy-inbox:not(:focus-within) .canopy-inbox-row[aria-selected="true"]'
      ),
      "--canopy-row-edge"
    );
    // Accent tints fall below 3:1 on some themes; a text token clears it on all.
    const shape = (value: string) => value.replace(/var\([^)]*\)$/, "");
    expect(shape(receded)).toBe(shape(selected));
    expect(receded).not.toContain("accent");
    expect(receded).toMatch(/var\(--theme-text-[a-z]+\)$/);
  });

  it("insets the forced-colours focus outline, which the full-bleed rows would otherwise clip", () => {
    const forced = CANOPY_CSS.slice(CANOPY_CSS.indexOf("@media (forced-colors: active)"));
    const offset = /\.canopy-inbox-row:focus-visible\s*\{[^}]*outline-offset:\s*(-?\d+)px/.exec(
      forced
    );
    expect(offset).not.toBeNull();
    expect(Number(offset![1])).toBeLessThan(0);
  });
});
