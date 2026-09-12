import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const TOOLBAR_CSS_PATH = path.resolve(__dirname, "../../../styles/components/toolbar.css");
const BUTTON_PATH = path.resolve(__dirname, "../../ui/button.tsx");

// The strip as a composed whole. Static-source assertions, like the rest of
// the Toolbar.* suite — Toolbar.tsx has too many IPC dependencies to render in
// jsdom — each pinning the rule a rendered-pixel review exposed, not the value
// that happened to satisfy it.
describe("Toolbar strip — composition invariants", () => {
  let source: string;
  let css: string;
  let button: string;

  beforeEach(async () => {
    [source, css, button] = await Promise.all([
      fs.readFile(TOOLBAR_PATH, "utf-8"),
      fs.readFile(TOOLBAR_CSS_PATH, "utf-8"),
      fs.readFile(BUTTON_PATH, "utf-8"),
    ]);
  });

  describe("eviction keeps keyboard focus somewhere real", () => {
    it("redirects while the evicted button is still activeElement, not only once focus has hit body", () => {
      // The browser only drops focus from a newly hidden button at its next
      // rendering update — after the layout effect that notices the eviction.
      // A body-only gate therefore never fired, and focus was lost.
      const effect = source.match(/useLayoutEffect\(\(\) => \{[\s\S]*?\n {2}\}\);/);
      expect(effect).not.toBeNull();
      expect(effect![0]).toMatch(
        /document\.activeElement === document\.body \|\| document\.activeElement === prevFocused/
      );
    });
  });

  describe("the measured rows clip without cropping the focus ring", () => {
    it("both rows use the shared clip class, never a bare overflow-hidden", () => {
      const rows = source.match(/ref=\{(left|right)GroupRef\}\s*className="([^"]+)"/g) ?? [];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toContain("toolbar-measured-row");
        expect(row).not.toContain("overflow-hidden");
      }
    });

    it("the clip margin covers the focus ring's full extent (offset plus width)", () => {
      const rule = css.match(/\.toolbar-measured-row\s*\{([^}]*)\}/);
      expect(rule).not.toBeNull();
      const body = rule![1]!;
      expect(body).toMatch(/overflow:\s*clip/);
      const margin = Number(/overflow-clip-margin:\s*(\d+)px/.exec(body)?.[1]);
      // The ring the rows must not cut: outline width + outline-offset from
      // the toolbar button focus rule.
      const ring = css.match(
        /\.toolbar-icon-button:focus-visible,[\s\S]*?\{[^}]*outline:\s*(\d+)px[^}]*outline-offset:\s*(\d+)px/
      );
      expect(ring).not.toBeNull();
      const extent = Number(ring![1]) + Number(ring![2]);
      expect(margin).toBeGreaterThanOrEqual(extent);
    });
  });

  describe("forced colours", () => {
    it("the project pill carries no at-rest outline suppressor — forced-colors paints its transparent outline as a second ring", () => {
      const pill = source.match(/data-testid="project-switcher-trigger"[\s\S]{0,400}/)?.[0] ?? "";
      const trigger = source.match(
        /<button\s+data-toolbar-item=""\s+className="([^"]+)"[\s\S]{0,200}data-testid="project-switcher-trigger"/
      );
      expect(trigger).not.toBeNull();
      const className = trigger![1]!;
      expect(className).not.toMatch(/(^|\s)outline-hidden(\s|$)/);
      expect(className).toMatch(/focus-visible:outline-/);
      expect(pill).toBeTruthy();
    });

    it("every toolbar badge gets a Canvas outline in place of its stripped ring, so a dot cannot fuse with its glyph", () => {
      const block = css.match(
        /@media \(forced-colors: active\) \{[\s\S]*?\.toolbar-badge,[\s\S]*?\n\}/
      );
      expect(block).not.toBeNull();
      expect(block![0]).toMatch(/\.toolbar-badge,[\s\S]*?outline:\s*\d+(\.\d+)?px solid Canvas/);
    });

    it("group dividers survive forced colours — their background is otherwise reset to Canvas", () => {
      const block = css.match(
        /@media \(forced-colors: active\) \{[\s\S]*?\.toolbar-divider\s*\{([^}]*)\}/
      );
      expect(block).not.toBeNull();
      expect(block![1]).toMatch(/background-color:\s*CanvasText/);
    });
  });

  describe("geometry", () => {
    it("measurement ghosts are the size of the button they stand in for", () => {
      const icon = button.match(/icon:\s*"([^"]+)"/);
      expect(icon).not.toBeNull();
      const size = icon![1]!.match(/\b(h-\d+)\b[^"]*\b(w-\d+)\b/);
      expect(size).not.toBeNull();
      const ghost = source.match(
        /function DevServerPlaceholder\(\)[\s\S]*?className=\{cn\(toolbarIconButtonClass, "([^"]+)"\)\}/
      );
      expect(ghost).not.toBeNull();
      expect(ghost![1]).toContain(size![1]!);
      expect(ghost![1]).toContain(size![2]!);
    });

    it("the grid keeps a gutter between the side groups and the pill", () => {
      const root = source.match(/role="toolbar"[\s\S]*?className="([^"]+)"/);
      expect(root).not.toBeNull();
      expect(root![1]).toMatch(/\bgap-x-[1-9]\d*\b/);
    });

    it("the strip's content is centred in its height — no top padding pushing it low", () => {
      const root = source.match(/role="toolbar"[\s\S]*?className="([^"]+)"/);
      expect(root).not.toBeNull();
      expect(root![1]).toMatch(/\bh-12\b/);
      expect(root![1]).toMatch(/\bitems-center\b/);
      expect(root![1]).not.toMatch(/\bp[tby]-\d/);
    });

    it("dividers never shrink to nothing under width pressure", () => {
      const classes = source.match(/const toolbar(?:Fixed)?DividerClass = "([^"]+)"/g) ?? [];
      expect(classes.length).toBeGreaterThanOrEqual(2);
      for (const c of classes) expect(c).toContain("shrink-0");
    });

    it("every divider gets the same clearance as its neighbours' gap", () => {
      // Inside a measured row: gap-0.5 + mx-1 on each side. In the outer
      // groups: gap-1.5 alone. Both come to the same 6px, so the fixed
      // dividers carry no margin of their own.
      const fixed = source.match(/const toolbarFixedDividerClass = "([^"]+)"/);
      expect(fixed).not.toBeNull();
      expect(fixed![1]).not.toMatch(/\bm[xlr]-\d/);
      const inner = source.match(/const toolbarDividerClass = "([^"]+)"/);
      expect(inner).not.toBeNull();
      expect(inner![1]).toMatch(/\bmx-1\b/);
      // And the two outer-group dividers use the fixed class.
      expect(source.match(/className=\{toolbarFixedDividerClass\}/g)).toHaveLength(2);
    });

    it("an empty overflow trigger leaves no wrapper behind to own a gap", () => {
      // The trigger is display:none when nothing is hidden; a wrapper around
      // it would still be a zero-width flex item costing gap-1.5.
      expect(source).not.toMatch(/<div className="app-no-drag">\s*\{renderOverflowMenu\(/);
      expect(source).toMatch(
        /data-toolbar-overflow-trigger=""[\s\S]{0,600}?className=\{cn\(toolbarIconButtonClass, "app-no-drag"\)\}/
      );
    });

    it("a collapsed platform spacer folds its flex gap away too", () => {
      // Both spacers: a w-0 item still owns a gap on each side of it.
      const collapsed =
        source.match(/isFullscreen \? "w-0[^"]*"|isFullscreen && "w-0[^"]*"/g) ?? [];
      expect(collapsed).toHaveLength(2);
      for (const c of collapsed) expect(c).toMatch(/-m[lr]-/);
    });
  });

  describe("both sides share one rulebook", () => {
    it("the right side is grouped and divided exactly like the left", () => {
      expect(source).toContain("renderGroupedButtons(effectiveLeftButtons");
      expect(source).toContain("renderGroupedButtons(effectiveRightButtons");
      const left =
        source.match(/const positionedLeftButtons = useMemo\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
      const right =
        source.match(/const positionedRightButtons = useMemo\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
      expect(left).toContain("orderToolbarButtonsByGroup(");
      expect(right).toContain("orderToolbarButtonsByGroup(");
    });

    it("the overflow engine is told what a group boundary costs", () => {
      expect(source).toMatch(/useToolbarOverflow\([\s\S]*?pinnedIds,\s*resolveToolbarGroup\s*\)/);
    });
  });
});
