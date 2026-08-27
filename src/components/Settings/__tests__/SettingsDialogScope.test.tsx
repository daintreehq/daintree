// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScopeContext, ScopeChip, NavItem } from "../SettingsDialog";
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
  describe("ScopeContext", () => {
    it("renders whatever project it is handed, rather than a fixed word", () => {
      const { unmount } = render(<ScopeContext scope="project" projectLabel="Helios Dashboard" />);
      expect(screen.getByText("Helios Dashboard")).toBeTruthy();
      unmount();

      render(<ScopeContext scope="project" projectLabel="Kestrel API" />);
      expect(screen.getByText("Kestrel API")).toBeTruthy();
      expect(screen.queryByText("Helios Dashboard")).toBeNull();
    });

    it("distinguishes the two scopes by more than the entity name", () => {
      const { container: globalEl, unmount } = render(
        <ScopeContext scope="global" projectLabel="Helios Dashboard" />
      );
      const globalScope = globalEl.querySelector("[data-settings-scope-context]");
      expect(globalScope?.getAttribute("data-settings-scope-context")).toBe("global");
      const globalHtml = globalEl.innerHTML;
      unmount();

      const { container: projectEl } = render(
        <ScopeContext scope="project" projectLabel="Helios Dashboard" />
      );
      expect(
        projectEl
          .querySelector("[data-settings-scope-context]")
          ?.getAttribute("data-settings-scope-context")
      ).toBe("project");
      // Same entity string on both, so any difference here is a real scope signal —
      // the icon and the screen-reader prefix — not just a different name.
      expect(projectEl.innerHTML).not.toBe(globalHtml);
    });

    it("never claims a project when none is open", () => {
      render(<ScopeContext scope="project" projectLabel={null} />);
      expect(
        document
          .querySelector("[data-settings-scope-context]")
          ?.getAttribute("data-settings-scope-context")
      ).toBe("global");
    });

    it("is decorative — the dialog's own labelled title carries the announced name", () => {
      // Both the header eyebrow and the dialog title name the scope and the entity.
      // Only one of them should reach a screen reader, or every open announces it
      // twice; the title wins, because that is what aria-labelledby points at.
      const { container } = render(
        <ScopeContext scope="project" projectLabel="Helios Dashboard" />
      );
      const line = container.querySelector("[data-settings-scope-context]");
      expect(line?.getAttribute("aria-hidden")).toBe("true");
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
