import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");
const APP_PATH = path.resolve(__dirname, "../../../App.tsx");

describe("AppLayout global banner mount — issue #9530", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("imports Suspense and lazy from react", () => {
    // The coordinator now lives inside AppLayout, so AppLayout owns the lazy
    // boundary it previously relied on App.tsx to provide.
    expect(source).toMatch(/import \{[^}]*\bSuspense\b[^}]*\blazy\b[^}]*\} from "react"/);
  });

  it("lazily defines and eagerly preloads the GlobalBannerCoordinator", () => {
    expect(source).toContain(
      'function preloadGlobalBannerCoordinator() {\n  return import("../Recovery/GlobalBannerCoordinator");'
    );
    expect(source).toContain("const LazyGlobalBannerCoordinator = lazy(");
    // safeMode is set synchronously during hydration, so the chunk must be
    // inflight before the first post-hydration render can suspend.
    expect(source).toContain("void preloadGlobalBannerCoordinator();");
  });

  it("mounts the banner inside the flex column, after PortalVisibilityController and before the inert toolbar wrapper", () => {
    // Issue #9530: mounting the coordinator as a block-flow sibling above the
    // 100vh AppLayout root overflowed the viewport and clipped the dock. The
    // banner must be a direct child of the h-screen flex column so its
    // shrink-0 height is subtracted from the flex-1 content area instead.
    // Since #11893 the coordinator sits inside a measured wrapper, which is now
    // the direct flex child carrying shrink-0 — the ordering invariant is
    // unchanged, and the wrapper must hold the coordinator and nothing else.
    expect(source).toMatch(
      /<PortalVisibilityController \/>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div(?=[^>]*className="shrink-0")[^>]*>\s*<Suspense fallback=\{null\}>\s*<LazyGlobalBannerCoordinator \/>\s*<\/Suspense>\s*<\/div>\s*<div \{\.\.\.\(chromeInert \? \{ inert: true \}/
    );
  });
});

describe("AppLayout publishes the global banner height — issue #11893", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  // What the publisher DOES — measure, clamp, republish, clean up — is covered
  // behaviorally in src/hooks/__tests__/useGlobalBannerHeightVar.test.tsx. This
  // suite only pins the wiring that a source scan can see: that AppLayout hands
  // the hook the two elements it needs.

  it("measures the wrapper that holds the coordinator and nothing else", () => {
    // The measured element must contain ONLY the coordinator, so its height IS
    // the banner height. Measuring a neighbour instead (the toolbar wrapper's
    // top edge, or the content row's size) goes stale in the degenerate cases:
    // a banner that grows while FleetArmingRibbon shrinks by the same amount, or
    // one that grows after the content area has collapsed to 0 — both leave
    // every other element's size untouched.
    expect(source).toMatch(/useGlobalBannerHeightVar\(bannerEl\)/);
    expect(source).toMatch(
      /<div(?=[^>]*ref=\{setBannerEl\})[^>]*>\s*<Suspense fallback=\{null\}>\s*<LazyGlobalBannerCoordinator \/>\s*<\/Suspense>\s*<\/div>/
    );
  });
});

describe("App.tsx no longer owns the global banner — issue #9530", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_PATH, "utf-8");
  });

  it("does not import, lazy-define, or mount the GlobalBannerCoordinator", () => {
    expect(source).not.toContain("GlobalBannerCoordinator");
    expect(source).not.toContain("preloadGlobalBannerCoordinator");
    expect(source).not.toContain("LazyGlobalBannerCoordinator");
  });
});
