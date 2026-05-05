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
    expect(source).toContain('import { useThemeBrowserStore } from "@/store/themeBrowserStore"');
  });

  it("reads the mount gate from the store, not from the overlay claim", () => {
    // The overlay claim is registered by ThemeBrowser's own useEffect, so using
    // it as the mount gate produces a chicken-and-egg deadlock (the regression
    // from PR #5721). The gate must be driven by the store's isOpen flag.
    expect(source).toContain("const themeBrowserOpen = useThemeBrowserStore((s) => s.isOpen)");
    expect(source).toMatch(/\{themeBrowserOpen &&\s*\n\s*createPortal\(/);
  });

  it("keeps the overlay-claim variable for inert on blocked wrappers", () => {
    // The overlay claim is the correct signal for inert because it fires after
    // ThemeBrowser has mounted — intended PR #5721 behavior. inert on the
    // toolbar + main-content wrappers prevents interaction with blocked UI.
    expect(source).toContain('const isThemeBrowserOpen = overlayClaims.has("theme-browser")');
    expect(source).toContain("isThemeBrowserOpen ? { inert: true } : {}");
  });
});

describe("AppLayout theme browser overlay structure — issue #5791", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
  });

  it("portals the ThemeBrowser out of the inert subtree", () => {
    // Bug 1: rendering inside the inert main-content wrapper made the picker
    // itself unclickable. Portaling to document.body escapes the inert ancestor.
    expect(source).toContain('import { createPortal } from "react-dom"');
    expect(source).toMatch(/createPortal\([\s\S]*?<ThemeBrowser \/>[\s\S]*?document\.body/);
  });

  it("renders scrim as a sibling of the panel, not an ancestor", () => {
    // Bug 2: backdrop-filter on an ancestor creates a containing block for
    // position:fixed children (lesson #2574). The scrim must be flat sibling
    // to the panel, with hover-driven blur via CSS hit-testing.
    expect(source).toMatch(
      /className="fixed inset-0 z-30 bg-scrim-soft\/30[^"]*hover:backdrop-blur-\[2px\]"/
    );
  });

  it("anchors the panel with fixed positioning for full viewport height", () => {
    // Bug 3: absolute + h-full inside <main> was bounded by the flex cell.
    // fixed inset-y-0 anchors to the viewport regardless of docks/panels below.
    expect(source).toMatch(/className="fixed inset-y-0 z-40 pointer-events-auto"/);
  });

  it("drops the static backdrop-blur from the main-content wrapper", () => {
    // Bug 2: the blur is now hover-driven on the scrim, not a static ancestor
    // effect. A static blur here also traps any position:fixed descendants.
    expect(source).not.toMatch(/isThemeBrowserOpen && "bg-scrim-soft\/30 backdrop-blur-\[2px\]"/);
  });

  it("anchors ThemeBrowser right edge via shared --right-obstruction-offset (issues #6629, #6800)", () => {
    // Both the Portal and the Assistant occupy the right edge of the viewport.
    // ThemeBrowser must step left of whichever is wider — and previously, when
    // only the Assistant was open, ThemeBrowser used `right: "0px"` and
    // overlapped the panel. Routing through the shared CSS var fixes both
    // cases with a single source of truth. The var was renamed from
    // --portal-right-offset to --right-obstruction-offset in #6800 so that
    // toolbar dropdowns can keep using --portal-right-offset (portal-only)
    // without dodging the Assistant.
    expect(source).toContain('right: "var(--right-obstruction-offset, 0px)"');
    // The old hand-computed ternary must not be reintroduced.
    expect(source).not.toMatch(/right: layout\.portalOpen \? `\$\{layout\.portalWidth\}px` :/);
  });
});

describe("Right-obstruction CSS var consumers (issue #6800)", () => {
  // Source-scan guard: every fixed body-portaled consumer that should dodge
  // both Portal and Assistant must read --right-obstruction-offset, NOT
  // --portal-right-offset. The latter is portal-only and reserved for
  // toolbar dropdowns (FixedDropdown).
  const consumers = [
    {
      name: "popover collision boundary",
      file: path.resolve(__dirname, "../../ui/popover.tsx"),
    },
    { name: "toaster", file: path.resolve(__dirname, "../../ui/toaster.tsx") },
    {
      name: "ReEntrySummary",
      file: path.resolve(__dirname, "../../ui/ReEntrySummary.tsx"),
    },
    {
      name: "GettingStartedChecklist",
      file: path.resolve(__dirname, "../../Onboarding/GettingStartedChecklist.tsx"),
    },
  ];

  for (const { name, file } of consumers) {
    it(`${name} reads --right-obstruction-offset, not --portal-right-offset`, async () => {
      const source = await fs.readFile(file, "utf-8");
      expect(source).toContain("--right-obstruction-offset");
      expect(source).not.toContain("--portal-right-offset");
    });
  }
});
