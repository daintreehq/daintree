import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const SIDEBAR_CONTENT_PATH = path.resolve(__dirname, "../SidebarContent.tsx");

describe("SidebarContent header reveal — issue #6964", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(SIDEBAR_CONTENT_PATH, "utf-8");
  });

  it("uses invisible + group-*:visible to remove hidden buttons from the tab order", () => {
    expect(source).toMatch(/\binvisible\b[^"']*group-hover\/header:visible/);
    expect(source).toMatch(/\binvisible\b[^"']*group-focus-within\/header:visible/);
  });

  it("retains opacity + pointer-events for the visual fade and mouse-event gating", () => {
    expect(source).toContain("opacity-0");
    expect(source).toContain("pointer-events-none");
    expect(source).toContain("group-hover/header:opacity-100");
    expect(source).toContain("group-hover/header:pointer-events-auto");
    expect(source).toContain("group-focus-within/header:opacity-100");
    expect(source).toContain("group-focus-within/header:pointer-events-auto");
  });

  it("keeps the named group/header parent so focus-within and hover variants resolve", () => {
    // Matched on the class name itself, not on `className="…` — the header
    // composes its classes through cn() now that the bottom border is
    // conditional, and the rule being protected is "the named group exists",
    // not which attribute syntax declares it.
    expect(source).toMatch(/["'\s]group\/header\b/);
  });

  it("uses a scoped transition covering opacity and visibility at Tier 1 duration-150", () => {
    expect(source).toMatch(/transition-\[opacity,visibility\][^"]*duration-150/);
  });

  it("applies a symmetric 75ms enter/exit delay on the hover/focus state — issue #7602", () => {
    expect(source).toContain("delay-75");
    expect(source).toContain("group-hover/header:delay-75");
    expect(source).toContain("group-focus-within/header:delay-75");
    expect(source).not.toMatch(/transition-\[opacity,visibility\][^"]*\bdelay-0\b/);
  });

  // Slice the header region so assertions about the four header icon buttons
  // aren't perturbed by unrelated buttons elsewhere in the file (e.g. the
  // arm-matching affordance, which carries the same focus-visible treatment).
  function headerSlice(src: string): string {
    const start = src.indexOf("group/header");
    const end = src.indexOf("Inline search bar", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("builds all four header actions from the shared ghost icon button — issue #7602", () => {
    // The Button primitive owns the focus ring, hover and press for every one
    // of them, so none of the four can drift into its own treatment.
    const header = headerSlice(source);
    const buttons = header.match(/<Button\s+variant="ghost"\s+size="icon-xs"/g) ?? [];
    expect(buttons).toHaveLength(4);
    expect(header).not.toMatch(/<button\b/);
    expect(header).not.toMatch(/focus-visible:outline-accent-primary/);
  });

  it("gives the always-visible create button the same treatment as its revealed siblings", () => {
    // Visibility is the cluster's only hierarchy: the three secondary actions
    // are hidden until the header is hovered or focused, and create is not.
    // Once shown, all four read as one family.
    const header = headerSlice(source);
    expect(header).not.toMatch(/text-daintree-text\//);
    const classNames = [...header.matchAll(/className=\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    expect(classNames).toHaveLength(4);
    expect(classNames.every((cls) => cls.includes("SIDEBAR_HEADER_ACTION"))).toBe(true);
  });

  it("keeps the reveal's fade under reduced motion", () => {
    // The reveal is opacity and visibility only — not motion — so it must not
    // be switched off under reduced motion.
    const reveal = source.match(/className="([^"]*group-hover\/header:visible[^"]*)"/)?.[1];
    expect(reveal).toBeTruthy();
    expect(reveal).toMatch(/transition-\[opacity,visibility\]/);
    expect(reveal).not.toMatch(/motion-reduce:/);
  });

  it("delegates the refresh spin to SpinningIcon driven by the raw refresh flag (#11323)", () => {
    // The refresh spin is owned by the shared SpinningIcon primitive, which
    // finishes the current rotation before stopping instead of snapping back.
    // It must be driven by the raw `isRefreshing` transition flag — the old
    // `useSkeletonDisplayFloor` wall-clock floor gated duration, not rotation
    // phase, so it snapped mid-turn and is deliberately gone from this button.
    // Scope the positive match to the header so an unrelated SpinningIcon
    // elsewhere in the file can't mask a regression to a static header icon.
    const header = headerSlice(source);
    expect(header).toMatch(/<SpinningIcon\b[^>]*icon=\{RefreshCw\}[^>]*active=\{isRefreshing\}/);
    expect(source).not.toContain("useSkeletonDisplayFloor");
    expect(source).not.toContain("showRefreshSpinner");
    // No hand-rolled conditional class toggle survives on the refresh icon.
    expect(source).not.toMatch(/showRefreshSpinner\s*\?\s*"animate-spin"/);
    expect(source).not.toMatch(/isRefreshing\s*\?\s*"animate-spin"/);
  });
});
