import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #13408 — the label bar shares the card's leading edge with the status
// tick. A continuous line touching a segmented mark bridges its gaps, and the
// segment count is the only thing telling cleanup from finished, so the bar's
// cut-out has to track the tick's real geometry with 2px of clearance.

const sidebarCss = readFileSync(
  resolve(__dirname, "../../../../styles/components/sidebar.css"),
  "utf-8"
);
const tickSource = readFileSync(resolve(__dirname, "../WorktreeStatusTick.tsx"), "utf-8");
const cardSource = readFileSync(resolve(__dirname, "../../WorktreeCard.tsx"), "utf-8");

const CLEARANCE_PX = 2;

/** Tailwind's stock spacing scale: 1 unit is 4px. */
function spacingPx(token: string): number {
  return Number(token) * 4;
}

function tickBox(collapsed: boolean): { top: number; bottom: number } {
  const top = tickSource.match(/"top-1 start-0"/) ? spacingPx("1") : NaN;
  const sizeMatch = collapsed
    ? tickSource.match(/collapsed \? "grid h-([\d.]+) w-[\d.]+/)
    : tickSource.match(/: "flex h-([\d.]+) w-[\d.]+ flex-col"/);
  if (!sizeMatch) throw new Error("tick size classes not found");
  const height = spacingPx(sizeMatch[1]!);
  return { top, bottom: top + height };
}

function maskStops(cutout: "bar" | "square"): number[] {
  const rule = sidebarCss.match(
    new RegExp(`\\.worktree-label-bar\\[data-cutout="${cutout}"\\]\\s*\\{([^}]*)\\}`)
  );
  if (!rule) throw new Error(`no mask rule for data-cutout="${cutout}"`);
  return [...rule[1]!.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
}

describe("worktree label bar cut-out (#13408)", () => {
  it.each([
    ["bar", false],
    ["square", true],
  ] as const)("clears the %s tick by 2px above and below", (cutout, collapsed) => {
    const tick = tickBox(collapsed);
    const stops = maskStops(cutout);
    const gapStart = Math.min(...stops);
    const gapEnd = Math.max(...stops);
    expect(tick.top - gapStart).toBe(CLEARANCE_PX);
    expect(gapEnd - tick.bottom).toBe(CLEARANCE_PX);
  });

  it("picks the cut-out from the same collapsed flag the tick is drawn with", () => {
    expect(cardSource).toMatch(
      /data-cutout=\{\s*chipState === null \? undefined : effectiveIsCollapsed \? "square" : "bar"\s*\}/
    );
    expect(cardSource).toMatch(/collapsed=\{effectiveIsCollapsed\}/);
  });

  it("moves the keyboard-cursor edge to the right on a labelled card", () => {
    const rule = sidebarCss.match(
      /\.sidebar-worktree-card\[data-label\]:not\(\[data-active="true"\]\)[^{]*\{([^}]*)\}/
    );
    expect(rule?.[1]).toMatch(/--card-edge:\s*inset -2px 0 0 var\(--theme-selection-outline\)/);
  });

  it("keeps the hue under forced colors, bar and swatch alike", () => {
    const block = sidebarCss.slice(sidebarCss.indexOf(".worktree-label-swatch {"));
    const forced = block.match(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/);
    expect(forced?.[1]).toMatch(
      /\.worktree-label-bar,\s*\.worktree-label-swatch\s*\{\s*forced-color-adjust:\s*none/
    );
    // Inside the bar's own box: the cut-out mask clips anything painted outside
    // it, so an outer shadow would vanish on every card that shows a tick.
    const bar = forced?.[1]?.match(/\.worktree-label-bar\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(bar).toMatch(/border-inline-end:\s*1px solid CanvasText/);
    expect(bar).not.toMatch(/box-shadow/);
  });

  it("never paints the label in the accent", () => {
    const barRules = [...sidebarCss.matchAll(/\.worktree-label-[^{]*\{[^}]*\}/g)].map((m) => m[0]);
    for (const rule of barRules) expect(rule).not.toMatch(/accent/);
  });
});
