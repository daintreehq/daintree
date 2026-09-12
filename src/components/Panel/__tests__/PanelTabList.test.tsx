// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelTabList } from "../PanelTabList";
import type { TabInfo } from "../TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

vi.mock("framer-motion", () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  m: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const tabs: TabInfo[] = [
  {
    id: "tab-1",
    title: "Tab one",
    chrome: deriveTerminalChrome(),
    kind: "terminal",
    isActive: true,
  },
];

const baseProps = {
  layoutGroupId: "group-1",
  tabs,
  tabListRef: () => {},
  onKeyDown: () => {},
  addTabTooltipContent: "Add",
  overflowTrigger: null,
  renderTab: (tab: TabInfo) => <span data-testid={`tab-${tab.id}`}>{tab.title}</span>,
};

describe("PanelTabList", () => {
  it("marks the tab strip container with [data-no-dnd] so it opts out of the panel-move drag (issue #10443)", () => {
    const { container } = render(<PanelTabList {...baseProps} />);
    const noDnd = container.querySelector("[data-no-dnd]");
    expect(noDnd).not.toBeNull();
    // The tablist (and therefore the rendered tabs) must live inside the opt-out
    // boundary, so a mousedown anywhere in the strip never arms the parent panel.
    const tablist = screen.getByRole("tablist");
    expect(noDnd?.contains(tablist)).toBe(true);
    expect(noDnd?.contains(screen.getByTestId("tab-tab-1"))).toBe(true);
  });

  it("keeps the add-tab button inside the [data-no-dnd] boundary", () => {
    const { container } = render(<PanelTabList {...baseProps} onAddTab={vi.fn()} />);
    const noDnd = container.querySelector("[data-no-dnd]");
    const addButton = screen.getByLabelText("Duplicate panel as new tab");
    expect(noDnd?.contains(addButton)).toBe(true);
  });

  it("keeps the overflow trigger inside the [data-no-dnd] boundary", () => {
    // The overflow trigger renders as a sibling of the tablist (outside the inner
    // tab-wrapping div), so it only stays protected as long as the boundary sits
    // on the outer container. This guards against narrowing it and re-exposing
    // the bug for that button.
    const { container } = render(
      <PanelTabList {...baseProps} overflowTrigger={<button data-testid="overflow">More</button>} />
    );
    const noDnd = container.querySelector("[data-no-dnd]");
    expect(noDnd?.contains(screen.getByTestId("overflow"))).toBe(true);
  });

  it("parks tabs the overflow observer cannot fit, and never the active one", () => {
    const three: TabInfo[] = [
      { ...tabs[0]!, id: "tab-1", isActive: false },
      { ...tabs[0]!, id: "tab-2", isActive: true },
      { ...tabs[0]!, id: "tab-3", isActive: false },
    ];
    render(<PanelTabList {...baseProps} tabs={three} hiddenTabIds={new Set(["tab-2", "tab-3"])} />);
    const wrapperOf = (id: string) => screen.getByTestId(`tab-${id}`).parentElement!;
    // A tab that does not fit must not paint a fragment at the strip's edge —
    // it stays in layout (the observer still measures it) but not on screen.
    expect(wrapperOf("tab-3").classList.contains("invisible")).toBe(true);
    expect(wrapperOf("tab-3").getAttribute("data-tab-parked")).toBe("true");
    expect(wrapperOf("tab-1").classList.contains("invisible")).toBe(false);
    // The active tab is scrolled into view and can be flagged mid-scroll; it
    // is never parked or the strip would blink.
    expect(wrapperOf("tab-2").classList.contains("invisible")).toBe(false);
  });
});
