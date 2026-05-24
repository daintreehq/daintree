import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const APP_LAYOUT_PATH = path.resolve(__dirname, "../AppLayout.tsx");
const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");
const TERMINAL_DOCK_PATH = path.resolve(__dirname, "../TerminalDockRegion.tsx");
const PORTAL_DOCK_PATH = path.resolve(__dirname, "../../Portal/PortalDock.tsx");
const SIDEBAR_PATH = path.resolve(__dirname, "../Sidebar.tsx");

describe("ARIA page landmarks — issue #5416", () => {
  describe("AppLayout <main>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(APP_LAYOUT_PATH, "utf-8");
    });

    it("labels the main content landmark", () => {
      expect(source).toMatch(/<main[^>]*aria-label="Content"/);
    });
  });

  describe("Toolbar <header> banner wrapper", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(TOOLBAR_PATH, "utf-8");
    });

    it("wraps the toolbar in a <header> for the banner landmark", () => {
      expect(source).toMatch(/return \(\s*<header>/);
      expect(source).toMatch(/<\/header>\s*\);/);
    });

    it("keeps role=toolbar and toolbarRef on the inner div, not on <header>", () => {
      // The roving-tabindex contract relies on toolbarRef pointing at the
      // role=toolbar container so its [data-toolbar-item] descendants can be
      // queried. Moving the ref onto <header> would break that lookup.
      expect(source).toMatch(/<header>\s*<div\s+ref=\{toolbarRef\}\s+role="toolbar"/);
    });
  });

  describe("Sidebar <aside>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(SIDEBAR_PATH, "utf-8");
    });

    it("uses an <aside> region landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[\s\S]*?aria-label="Sidebar"/);
      expect(source).toMatch(/<aside[\s\S]*?role="region"/);
    });
  });

  describe("TerminalDockRegion <aside>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(TERMINAL_DOCK_PATH, "utf-8");
    });

    it("uses an <aside> region landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[\s\S]*?aria-label="Dock"/);
      expect(source).toMatch(/<aside[\s\S]*?role="region"/);
    });

    it("keeps tabIndex=-1 so the macro-focus cycler can target it", () => {
      expect(source).toMatch(/<aside[\s\S]*?tabIndex=\{-1\}/);
    });

    it("does not aria-hide the dock landmark", () => {
      // The dock always renders interactive content (Help Agent button,
      // status containers), so aria-hidden would trap focusable controls
      // beneath aria-hidden=true and fail axe's aria-hidden-focus rule.
      // `inert` is used instead — see test below.
      expect(source).not.toMatch(/aria-hidden=\{[^}]*hasDocked[^}]*\}/);
      expect(source).not.toMatch(/aria-hidden="true"/);
    });

    it("uses `inert` to hide the empty dock from focus / a11y tree", () => {
      // When no panels are docked, the aside has no interactive descendants
      // worth presenting as a landmark. `inert` removes it from the a11y
      // tree and the focus chain without tripping `aria-hidden-focus`.
      expect(source).toMatch(/inert=\{!hasDocked \|\| undefined\}/);
    });
  });

  describe("PortalDock <aside>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(PORTAL_DOCK_PATH, "utf-8");
    });

    it("uses an <aside> region landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[\s\S]*?aria-label="Portal"/);
      expect(source).toMatch(/<aside[\s\S]*?role="region"/);
    });

    it("keeps tabIndex=-1 so the macro-focus cycler can target it", () => {
      expect(source).toMatch(/<aside[\s\S]*?tabIndex=\{-1\}/);
    });

    it("links the resize separator to the panel it controls via aria-controls", () => {
      expect(source).toMatch(/role="separator"[\s\S]*?aria-controls="portal-placeholder"/);
    });
  });
});
