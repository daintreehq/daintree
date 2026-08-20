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
    expect(source).toMatch(
      /<PortalVisibilityController \/>\s*<Suspense fallback=\{null\}>\s*<LazyGlobalBannerCoordinator \/>\s*<\/Suspense>\s*<div \{\.\.\.\(chromeInert \? \{ inert: true \}/
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

  it("hands the hook the toolbar wrapper, whose top edge is the banner height", () => {
    // Argument order matters: the wrapper is what gets MEASURED (its top edge is
    // the banner height, since the app root sits at viewport y=0), the content
    // row is only a resize trigger.
    expect(source).toMatch(/useGlobalBannerHeightVar\(toolbarWrapEl, contentRowEl\)/);
    expect(source).toMatch(/<div(?=[^>]*ref=\{setToolbarWrapEl\})[^>]*>\s*<Toolbar\b/);
  });

  it("attaches the trigger ref to the flex-1 content row", () => {
    // The row is flex-1 + overflow:hidden, so its automatic minimum height
    // resolves to 0 and it absorbs banner growth. A ref on any shrink-0 sibling
    // would never report the change.
    expect(source).toMatch(
      /<div(?=[^>]*ref=\{setContentRowEl\})(?=[^>]*className="(?=[^"]*\bflex-1\b)(?=[^"]*\boverflow-hidden\b)[^"]*")[^>]*>/
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
