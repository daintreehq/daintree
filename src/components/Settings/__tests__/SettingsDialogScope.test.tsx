// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScopeChip, NavItem, scopeAnnouncement } from "../SettingsDialog";
import {
  contentScopeForTab,
  scopeForTab,
  SETTINGS_REGISTRY,
  type SettingsTab,
} from "../settingsTabRegistry";

vi.mock("framer-motion", () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  m: {
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
  },
}));

/**
 * These assert the RULES the scope work exists to hold, not the strings it currently
 * ships. The words in the shell will change again; what must not is that the frame
 * names whatever entity it was handed, that the two scopes stay distinguishable, and
 * that "changed" and "broken" never collapse into one another.
 */
describe("settings scope orientation", () => {
  describe("scopeAnnouncement", () => {
    /**
     * The only place the scope reaches a screen reader. Nothing paints it, so a
     * refactor can delete or invert it without a single pixel moving — these are what
     * would notice.
     */
    it("names whatever project it is handed, rather than a fixed word", () => {
      expect(scopeAnnouncement("project", "Helios Dashboard")).toContain("Helios Dashboard");
      expect(scopeAnnouncement("project", "Kestrel API")).toContain("Kestrel API");
      expect(scopeAnnouncement("project", "Kestrel API")).not.toContain("Helios Dashboard");
    });

    it("never announces a project the user does not have open", () => {
      // "project" is projectLabel's own fallback string, so a regression that leaked
      // the label through would still read as a plausible sentence. The entity clause
      // is what has to be absent, not the word.
      expect(scopeAnnouncement("project", null)).not.toMatch(/\bfor\b/);
    });

    it("never claims global over a tab whose content is project-scoped", () => {
      // The failure this exists for: `integrations` is filed under the global nav but
      // writes per-project, so it is reachable with NO project open. Branching on the
      // project before the scope announces "Global settings for Daintree" over a pane
      // where every control saves against a project. Driven off the registry so a tab
      // added with that same shape later is covered without touching this test.
      const projectContentTabs = SETTINGS_REGISTRY.map((e) => e.id as SettingsTab).filter(
        (id) => contentScopeForTab(id) === "project"
      );
      expect(projectContentTabs.length).toBeGreaterThan(0);

      for (const id of projectContentTabs) {
        for (const project of ["Helios Dashboard", null]) {
          expect(
            scopeAnnouncement(contentScopeForTab(id), project),
            `${id} announced the global scope`
          ).not.toBe(scopeAnnouncement("global", project));
        }
      }
    });
  });

  describe("ScopeChip", () => {
    it("names the project a project-scoped result belongs to", () => {
      render(<ScopeChip scope="project" projectLabel="Helios Dashboard" />);
      expect(screen.getByText("Helios Dashboard")).toBeTruthy();
    });

    it("marks a result that will move the user to the other scope", () => {
      const { container: sameScope, unmount } = render(
        <ScopeChip scope="project" projectLabel="Helios Dashboard" />
      );
      const sameHtml = sameScope.innerHTML;
      unmount();

      const { container: crossScope } = render(
        <ScopeChip scope="project" projectLabel="Helios Dashboard" crossScope />
      );
      expect(crossScope.innerHTML).not.toBe(sameHtml);
      // The signal has to reach a screen reader too, not just the eye.
      expect(screen.getByText(/switches to/i)).toBeTruthy();
    });
  });

  describe("sidebar markers", () => {
    const base = {
      tab: "general" as SettingsTab,
      icon: <svg data-testid="tab-icon" />,
      label: "General",
      activeTab: "general" as SettingsTab,
      isSearching: false,
      onSelect: () => {},
    };

    /** The marker wrapper, minus the tab's own icon. */
    function markerHtml(container: HTMLElement): string {
      const marker = container.querySelector('[role="img"]');
      return marker?.innerHTML ?? "";
    }

    it("gives 'modified' and 'has errors' different shapes, not just different colours", () => {
      const { container: modifiedEl, unmount } = render(<NavItem {...base} modified />);
      const modified = markerHtml(modifiedEl);
      unmount();

      const { container: errorEl } = render(<NavItem {...base} hasError />);
      const error = markerHtml(errorEl);

      expect(modified).not.toBe("");
      expect(error).not.toBe("");
      // Strip every colour class: what is left must still differ, or the two meanings
      // collapse the moment colour is removed (achromatopsia, forced colors).
      const shapeOnly = (html: string) => html.replace(/(bg|text)-\[?[\w#()/.,-]+\]?/g, "");
      expect(shapeOnly(error)).not.toBe(shapeOnly(modified));
    });

    it("labels each marker distinctly for assistive tech", () => {
      const { unmount } = render(<NavItem {...base} modified />);
      const modifiedLabel = document.querySelector('[role="img"]')?.getAttribute("aria-label");
      unmount();

      render(<NavItem {...base} hasError />);
      const errorLabel = document.querySelector('[role="img"]')?.getAttribute("aria-label");

      expect(modifiedLabel).toBeTruthy();
      expect(errorLabel).toBeTruthy();
      expect(errorLabel).not.toBe(modifiedLabel);
    });

    it("renders no marker when a tab is neither modified nor broken", () => {
      const { container } = render(<NavItem {...base} />);
      expect(container.querySelector('[role="img"]')).toBeNull();
    });
  });
});

describe("contentScopeForTab", () => {
  /**
   * The rule: the shell's context line follows what a tab WRITES to, not the nav list
   * it is filed under. Every tab whose content saves per-project must report "project"
   * here, or the header states the wrong scope over it.
   */
  it("reports the nav scope for a tab that does not declare otherwise", () => {
    expect(contentScopeForTab("general")).toBe("global");
    expect(contentScopeForTab("project:general")).toBe("project");
  });

  it("reports the content scope for a globally-filed tab that writes per-project", () => {
    expect(scopeForTab("integrations")).toBe("global");
    expect(contentScopeForTab("integrations")).toBe("project");
  });

  it("never reports a scope outside the two the shell knows about", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(["global", "project"]).toContain(contentScopeForTab(entry.id as SettingsTab));
    }
  });
});
