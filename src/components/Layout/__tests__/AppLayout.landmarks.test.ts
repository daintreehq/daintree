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

    it("uses an <aside> landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[^>]*aria-label="Sidebar"/);
    });
  });

  describe("TerminalDockRegion <aside>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(TERMINAL_DOCK_PATH, "utf-8");
    });

    it("uses an <aside> complementary landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[\s\S]*?aria-label="Dock"/);
      expect(source).not.toMatch(/role="region"/);
    });

    it("keeps tabIndex=-1 so the macro-focus cycler can target it", () => {
      expect(source).toMatch(/<aside[\s\S]*?tabIndex=\{-1\}/);
    });

    it("does not aria-hide the dock landmark", () => {
      // The dock always renders interactive content (Help Agent button,
      // status containers), so aria-hidden would trap focusable controls
      // beneath aria-hidden=true and fail axe's aria-hidden-focus rule.
      expect(source).not.toMatch(/aria-hidden=\{[^}]*hasDocked[^}]*\}/);
      expect(source).not.toMatch(/aria-hidden="true"/);
    });
  });

  describe("PortalDock <aside>", () => {
    let source: string;
    beforeEach(async () => {
      source = await fs.readFile(PORTAL_DOCK_PATH, "utf-8");
    });

    it("uses an <aside> complementary landmark with an accessible name", () => {
      expect(source).toMatch(/<aside[\s\S]*?aria-label="Portal"/);
      expect(source).not.toMatch(/role="region"/);
    });

    it("keeps tabIndex=-1 so the macro-focus cycler can target it", () => {
      expect(source).toMatch(/<aside[\s\S]*?tabIndex=\{-1\}/);
    });
  });
});
