// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavGroup, NavItem, SettingsScopeMenu } from "../SettingsDialog";
import type { SettingsTab } from "../settingsTabRegistry";

/**
 * Two nav groups, mirroring the real dialog: NavItems live in separate NavGroup
 * subtrees rather than as flat siblings.
 */
function Nav({
  activeTab,
  isSearching = false,
}: {
  activeTab: SettingsTab;
  isSearching?: boolean;
}) {
  const item = (tab: SettingsTab, label: string) => (
    <NavItem
      key={tab}
      tab={tab}
      icon={<svg />}
      label={label}
      activeTab={activeTab}
      isSearching={isSearching}
      onSelect={() => {}}
    />
  );
  return (
    <div role="tablist">
      <NavGroup label="Group one">
        {item("general", "General")}
        {item("keyboard", "Keyboard")}
      </NavGroup>
      <NavGroup label="Group two">
        {item("agents", "Agents")}
        {item("plugins", "Plugins")}
      </NavGroup>
    </div>
  );
}

describe("settings nav current page", () => {
  const activeItems = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][data-active="true"]'));

  it("marks exactly one item, the page being shown, across groups", () => {
    render(<Nav activeTab="agents" />);

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(activeItems().map((el) => el.getAttribute("data-tab"))).toEqual(["agents"]);
  });

  it("marks it with the list-detail fill alone — no edge marker", () => {
    // The nav used to slide a 2px accent bar between items. The page shown is a
    // selected record like any list-detail list's, so the fill is the mark.
    render(<Nav activeTab="general" />);
    const active = activeItems()[0]!;

    expect(active.querySelector("[aria-hidden='true'][class*='w-[2px]']")).toBeNull();
    expect(active.querySelectorAll(":scope > [aria-hidden='true']")).toHaveLength(0);
  });

  it("drops the mark while searching but leaves the tab selected", () => {
    // `active` is suppressed during search; `selected` is not. The fill keys off
    // the former, ARIA off the latter.
    render(<Nav activeTab="general" isSearching />);

    expect(activeItems()).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /general/i }).getAttribute("aria-selected")).toBe(
      "true"
    );
  });
});

describe("Settings sidebar heading", () => {
  it.each(["global", "project"] as const)(
    "names the %s scope in the scope trigger's accessible name, as it reads on screen",
    (scope) => {
      // WCAG 2.5.3: a speech user says what they see. A generic "Settings scope" label
      // over visible "Global settings" is the failure this pins.
      render(<SettingsScopeMenu scope={scope} projectLabel="Helios" onScopeChange={() => {}} />);
      const trigger = document.querySelector<HTMLElement>("[data-settings-scope-trigger]")!;

      expect(trigger.getAttribute("aria-label")).toBeNull();
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.textContent?.toLowerCase()).toContain(scope);
      expect(screen.getByRole("heading", { level: 2 }).contains(trigger)).toBe(true);
    }
  );

  it("drops a group label only when asked, keeping its rows", () => {
    render(
      <>
        <NavGroup label="Shown">
          <span>row a</span>
        </NavGroup>
        <NavGroup label="Hidden" hideLabel>
          <span>row b</span>
        </NavGroup>
      </>
    );

    expect(screen.queryByText("Shown")).not.toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
    expect(screen.queryByText("row b")).not.toBeNull();
  });
});
