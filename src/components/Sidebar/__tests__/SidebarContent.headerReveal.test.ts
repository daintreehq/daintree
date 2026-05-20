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
    expect(source).toMatch(/className="[^"]*\bgroup\/header\b/);
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

  it("renders focus-visible outlines on all four header icon buttons — issue #7602", () => {
    const header = headerSlice(source);
    const focusVisibleCount = (header.match(/focus-visible:outline-daintree-accent/g) ?? []).length;
    expect(focusVisibleCount).toBe(4);
    expect(header).toContain("focus-visible:outline focus-visible:outline-2");
  });

  it("lifts the always-visible create button to text-daintree-text/60 while siblings stay at /40 — issue #7602", () => {
    const header = headerSlice(source);
    expect(header).toContain("text-daintree-text/60");
    const fortyCount = (header.match(/text-daintree-text\/40/g) ?? []).length;
    expect(fortyCount).toBe(4);
  });

  it("respects prefers-reduced-motion via motion-reduce:transition-none", () => {
    expect(source).toContain("motion-reduce:transition-none");
  });

  it("gates the refresh spinner on useDeferredLoading + UI_DOHERTY_THRESHOLD to avoid sub-threshold flashes", () => {
    expect(source).toContain("useDeferredLoading");
    expect(source).toContain("UI_DOHERTY_THRESHOLD");
    expect(source).toMatch(
      /showRefreshSpinner\s*=\s*useDeferredLoading\(\s*isRefreshing\s*,\s*UI_DOHERTY_THRESHOLD\s*\)/
    );
    expect(source).toMatch(/showRefreshSpinner\s*\?\s*"animate-spin"/);
    expect(source).not.toMatch(/isRefreshing\s*\?\s*"animate-spin"/);
  });
});
