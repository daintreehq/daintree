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
      //
      // Matched on the div rather than on `<header>` being adjacent to it: the
      // toolbar's brand marks are wrapped in a `BrandSurface` provider, which
      // renders no DOM of its own and so leaves the landmark shape untouched
      // while sitting between the two tags in source.
      expect(source).toMatch(/<div\s+ref=\{toolbarRef\}\s+role="toolbar"/);
      expect(source).not.toMatch(/<header[^>]*(?:role=|ref=)/);
      // The banner still has to CONTAIN the toolbar — only a provider, which
      // renders no DOM, is allowed between the two tags.
      expect(source).toMatch(/<header>[\s\S]{0,400}?<div\s+ref=\{toolbarRef\}\s+role="toolbar"/);
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

    it("uses an <aside> region landmark with an accessible name when populated", () => {
      // The landmark role/name are conditional on dock contents (#9527): a
      // populated dock is a named "Dock" region; an empty one drops both.
      expect(source).toMatch(/aria-label=\{shouldInertDock \? undefined : "Dock"\}/);
      expect(source).toMatch(/role=\{shouldInertDock \? "none" : "region"\}/);
    });

    it("keeps tabIndex=-1 so the macro-focus cycler can target it", () => {
      expect(source).toMatch(/<aside[\s\S]*?tabIndex=\{-1\}/);
    });

    it("does not aria-hide the dock landmark", () => {
      // The dock always renders interactive content (Help Agent button,
      // status containers), so aria-hidden would trap focusable controls
      // beneath aria-hidden=true and fail axe's aria-hidden-focus rule.
      // role="none" drops the empty landmark instead — see test below.
      expect(source).not.toMatch(/aria-hidden/);
    });

    it("drops the landmark role instead of inerting the empty dock (#9527)", () => {
      // When no panels are docked and no status affordances are visible, the
      // aside is a dead-end landmark, so its role/name are dropped. It must NOT
      // be `inert` — the launch button and context menu are always rendered and
      // must stay interactive so users can spawn an agent from an empty dock.
      expect(source).toMatch(/const shouldInertDock = !hasDocked && !hasStatus;/);
      expect(source).not.toMatch(/inert=/);
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
