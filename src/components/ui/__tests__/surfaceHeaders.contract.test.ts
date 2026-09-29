import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { SURFACE_HEADER_FOCUS_LIFT_CLASS, surfaceHeaderVariants } from "../SurfaceHeader";
import { PANE_STATUS_FOOTER_CLASS } from "../paneToolbarStyles";
import { REVIEW_HUB_SECTION_BAND } from "@/components/Worktree/ReviewHub/reviewHubUtils";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * Every pane, side panel and floating surface whose title bar is compact
 * chrome. Each renders it through `SurfaceHeader density="compact"` rather than
 * spelling its own height, inset and divider — that hand-spelling is how the
 * assistant ended up 40px tall beside 32px grid panes. A new one belongs here.
 */
const COMPACT_HEADER_FILES = [
  "src/components/Panel/PanelHeader.tsx",
  "src/components/Plugin/ProjectSurfaceFrame.tsx",
  "src/components/Terminal/TerminalScratchpad.tsx",
  "src/components/HelpPanel/HelpPanelHeader.tsx",
  "src/components/Worktree/ReviewHub/ReviewHubContent.tsx",
  "src/components/Terminal/ArtifactOverlay.tsx",
  "src/components/ThemeBrowser/ThemeBrowser.tsx",
];

/** Every pane status strip. They share one class string with the header's inset and divider. */
const STATUS_FOOTER_FILES = [
  "src/components/Terminal/TerminalScratchpad.tsx",
  "src/components/HelpPanel/HelpPanelFooter.tsx",
  "src/panels/file-browser/FileBrowserHiddenStrip.tsx",
  "src/panels/file-browser/FileBrowserPane.tsx",
  "src/components/FileViewer/ZoomableImage.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "__preview__" ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("surface header contract", () => {
  it("compact density is the 32px frame with the 12px inset and the divider", () => {
    const cls = tokens(surfaceHeaderVariants({ density: "compact" }));
    expect(cls).toEqual(expect.arrayContaining(["h-8", "px-3", "border-b", "border-divider"]));
    expect(cls.some((t) => /^py-/.test(t))).toBe(false);
  });

  it("every compact-chrome surface renders its title bar through SurfaceHeader", () => {
    const offenders = COMPACT_HEADER_FILES.filter((rel) => {
      const src = read(rel);
      return !/<SurfaceHeader\b[^>]*density="compact"/s.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the focused-pane lift is a neutral overlay step, spelled in one place", () => {
    expect(SURFACE_HEADER_FOCUS_LIFT_CLASS).toMatch(/--color-overlay-[a-z]+/);
    expect(SURFACE_HEADER_FOCUS_LIFT_CLASS).not.toMatch(/accent/);
    const spelled = sourceFiles(path.join(ROOT, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("bg-[var(--panel-header-focus-bg"))
      .map((file) => path.relative(ROOT, file));
    expect(spelled).toEqual(["src/components/ui/SurfaceHeader.tsx"]);
  });

  it("no compact header recolours its divider with an arbitrary border utility", () => {
    // The frame's `.border-divider` is a custom rule in index.css that outranks
    // `border-b-[…]`, so an arbitrary divider colour never paints. The lifted
    // divider is spelled `border-overlay`, the matching custom rule.
    const offenders = [
      ...COMPACT_HEADER_FILES,
      "src/components/DragDrop/GridPlaceholder.tsx",
      "src/components/DragDrop/TerminalDragPreview.tsx",
    ].filter((rel) => /border-b-\[var\(--border-/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it("the assistant header lifts with the grid pane's token, not surface-highlight", () => {
    const src = read("src/components/HelpPanel/HelpPanelHeader.tsx");
    expect(src).toContain("SURFACE_HEADER_FOCUS_LIFT_CLASS");
    expect(src).not.toMatch(/surface-highlight|daintree-text/);
  });
});

describe("pane status footer contract", () => {
  it("sits on the header's inset and divider, at least 24px tall", () => {
    const cls = tokens(PANE_STATUS_FOOTER_CLASS);
    expect(cls).toEqual(
      expect.arrayContaining(["border-t", "border-divider", "px-3", "min-h-6", "text-2xs"])
    );
  });

  it("every status strip uses the shared string and none hand-spells a top divider", () => {
    const offenders = STATUS_FOOTER_FILES.filter((rel) => {
      const src = read(rel);
      return (
        !src.includes("PANE_STATUS_FOOTER_CLASS") || /border-t border-border-default/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe("review hub inset", () => {
  it("section bands share one string on the header's 12px inset", () => {
    expect(tokens(REVIEW_HUB_SECTION_BAND)).toEqual(
      expect.arrayContaining(["px-3", "bg-overlay-subtle"])
    );
    const files = [
      ...sourceFiles(path.join(ROOT, "src/components/Worktree/ReviewHub")),
      path.join(ROOT, "src/panels/review/ReviewPaneSkeleton.tsx"),
    ];
    const handSpelled = files
      .filter((file) => !file.endsWith("reviewHubUtils.ts"))
      .filter((file) => /"[^"]*\bpy-2 bg-overlay-subtle\b[^"]*"/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(handSpelled).toEqual([]);
  });

  it("nothing in the hub sits on the old 16px inset", () => {
    const files = [
      ...sourceFiles(path.join(ROOT, "src/components/Worktree/ReviewHub")),
      path.join(ROOT, "src/panels/review/ReviewPaneSkeleton.tsx"),
    ];
    const offenders = files
      .filter((file) => /["\s]px-4[\s"]/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
