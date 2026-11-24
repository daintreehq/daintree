import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../DiffViewer.lines.css"), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("hunk expander buttons", () => {
  const rest = ruleBody(".diff-viewer .diff-hunk-header-expanders button");

  it("hold a 24px target (WCAG 2.5.8) pulled back into the header's height", () => {
    expect(rest).toMatch(/min-height:\s*24px/);
    expect(rest).toMatch(/margin-block:\s*-4px/);
  });

  it("show a pointer and ride the overlay ladder, not the border token", () => {
    expect(rest).toMatch(/cursor:\s*pointer/);
    expect(rest).toMatch(/background:\s*var\(--color-overlay-soft\)/);
    expect(rest).not.toContain("--color-border-default");
    expect(ruleBody(".diff-viewer .diff-hunk-header-expanders button:hover")).toMatch(
      /background:\s*var\(--color-overlay-hover\)/
    );
  });
});
