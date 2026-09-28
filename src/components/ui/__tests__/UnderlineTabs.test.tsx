// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TabErrorCount, UnderlineTabs } from "../UnderlineTabs";

const TABS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

function renderTabs(activeId = "a", onChange = vi.fn()) {
  const utils = render(
    <UnderlineTabs
      tabs={TABS}
      activeId={activeId}
      onChange={onChange}
      aria-label="Test tabs"
      tabId={(id) => `t-${id}`}
      panelId={(id) => `p-${id}`}
    />
  );
  const tabs = Array.from(utils.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  return { ...utils, tabs, onChange, tablist: utils.getByRole("tablist") };
}

describe("UnderlineTabs", () => {
  it("is one tab stop, on the selected tab", () => {
    const { tabs } = renderTabs("b");
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toEqual([tabs[1]]);
  });

  it("points every tab at its panel and names itself for it", () => {
    const { tabs } = renderTabs();
    for (const [i, tab] of tabs.entries()) {
      expect(tab.id).toBe(`t-${TABS[i]!.id}`);
      expect(tab.getAttribute("aria-controls")).toBe(`p-${TABS[i]!.id}`);
      expect(tab.getAttribute("type")).toBe("button");
    }
  });

  it("selects as it moves, wrapping at both ends", () => {
    const { tabs, tablist, onChange } = renderTabs("a");
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("leaves keys it does not own alone", () => {
    const { tabs, tablist, onChange } = renderTabs("a");
    tabs[0]!.focus();
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    fireEvent.keyDown(tablist, { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TabErrorCount", () => {
  const read = (count: number) => {
    const { container } = render(<TabErrorCount count={count} />);
    return {
      shown: container.querySelector('[aria-hidden="true"]')?.textContent ?? null,
      spoken: container.querySelector(".sr-only")?.textContent ?? null,
    };
  };

  it("renders nothing without errors", () => {
    expect(read(0)).toEqual({ shown: null, spoken: null });
  });

  it("caps what it shows but never what it says", () => {
    for (const count of [1, 42, 99, 100, 1234]) {
      const { shown, spoken } = read(count);
      expect(spoken).toMatch(new RegExp(`^${count} errors?$`));
      expect(shown!.length).toBeLessThanOrEqual(3);
      expect(Number.parseInt(shown!, 10)).toBe(Math.min(count, 99));
      expect(shown!.endsWith("+")).toBe(count > 99);
    }
  });
});
