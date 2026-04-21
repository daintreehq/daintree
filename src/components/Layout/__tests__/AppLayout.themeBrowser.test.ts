import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");

describe("AppLayout theme browser mount gate — issue #5738", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports useThemeBrowserStore for the mount gate", () => {
    expect(source).toContain(
      'import { useThemeBrowserStore } from "@/store/themeBrowserStore"'
    );
  });

  it("reads the mount gate from the store, not from the overlay claim", () => {
    // The overlay claim is registered by ThemeBrowser's own useEffect, so using
    // it as the mount gate produces a chicken-and-egg deadlock (the regression
    // from PR #5721). The gate must be driven by the store's isOpen flag.
    expect(source).toContain("const themeBrowserOpen = useThemeBrowserStore((s) => s.isOpen)");
    expect(source).toMatch(/\{themeBrowserOpen && \(\s*\n\s*<ErrorBoundary[^>]*ThemeBrowser/);
    expect(source).not.toMatch(/\{isThemeBrowserOpen && \(\s*\n\s*<ErrorBoundary[^>]*ThemeBrowser/);
  });

  it("keeps the overlay-claim variable for inert and scrim treatment", () => {
    // The overlay claim is the correct signal for inert/scrim because it fires
    // after ThemeBrowser has mounted — this is the intended PR #5721 behavior.
    expect(source).toContain('const isThemeBrowserOpen = overlayClaims.has("theme-browser")');
    expect(source).toContain("isThemeBrowserOpen ? { inert: true } : {}");
    expect(source).toContain('isThemeBrowserOpen && "bg-scrim-soft/30 backdrop-blur-[2px]"');
  });
});
