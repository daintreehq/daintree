import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

/**
 * Structural rules for the toolbar forge stats strip. The strip is one
 * overflow-hidden rounded container of equal segments, and three of its
 * rendering bugs came from that shape rather than from any one segment.
 */

const LAYOUT = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFile(path.join(LAYOUT, file), "utf-8");

let button: string;
let pill: string;
let paused: string;
let stripe: string;
let placeholderToolbar: string;
let css: string;

beforeAll(async () => {
  [button, pill, paused, stripe, placeholderToolbar, css] = await Promise.all([
    read("ForgeStatsToolbarButton.tsx"),
    read("ForgeStatPill.tsx"),
    read("PRDetectionPausedIndicator.tsx"),
    read("ForgeStatusIndicator.tsx"),
    read("Toolbar.tsx"),
    fs.readFile(path.resolve(__dirname, "../../../styles/components/toolbar.css"), "utf-8"),
  ]);
});

/** Every opening tag in `source` whose class list contains `fragment`. */
function tagsWithClass(source: string, fragment: string): string[] {
  return [...source.matchAll(/<(?:div|Button)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(fragment));
}

describe("forge stats strip segments", () => {
  it("draws dividers per segment, never with divide-x on the container", () => {
    // divide-x borders every child but the DOM-last, and the DOM-last child is
    // the absolutely positioned status stripe — the visually last segment kept
    // a right border that doubled the container edge.
    for (const source of [button, placeholderToolbar]) {
      for (const tag of tagsWithClass(source, "toolbar-stats ")) {
        expect(tag).not.toMatch(/\bdivide-x\b/);
      }
    }
    expect(css).toMatch(/\[data-stat-segment\]\s*~\s*\[data-stat-segment\]/);
  });

  it("marks every visual slot as a segment and leaves the stripe out", () => {
    const slots = [...tagsWithClass(button, "w-7"), ...tagsWithClass(paused, "w-7")];
    expect(slots.length).toBeGreaterThan(0);
    for (const tag of slots) expect(tag).toContain("data-stat-segment");
    expect(pill).toMatch(/data-stat-segment=""/);
    expect(stripe).not.toContain("data-stat-segment");
  });

  it("insets the pill focus ring, because the container clips an outward one", () => {
    expect(tagsWithClass(button, "toolbar-stats ").join()).toContain("overflow-hidden");
    expect(pill).toMatch(/focus-visible:(-outline-offset-\d|outline-offset-\[-\d)/);
  });

  it("never dims a pill with whole-button opacity", () => {
    // Opacity takes the focus ring and hover tint down with the content, and
    // made the token-repair click read as disabled.
    const pills = button.split("<ForgeStatPill").slice(1);
    expect(pills).toHaveLength(3);
    for (const props of pills) expect(props.slice(0, 4000)).not.toMatch(/"opacity-\d+"/);
  });

  it("draws the open state inside the segment, where the container cannot clip it", () => {
    expect(css).toMatch(/\.toolbar-stat-pill\[aria-expanded="true"\]::after\s*\{[^}]*inset:\s*0/);
    expect(pill).not.toMatch(/\bring-\d/);
  });
});
