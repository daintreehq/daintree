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
  renderTab: (tab: TabInfo, parked: boolean) => (
    <span data-testid={`tab-${tab.id}`} data-parked={parked || undefined}>
      {tab.title}
    </span>
  ),
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
    const parked = (id: string) => screen.getByTestId(`tab-${id}`).getAttribute("data-parked");
    // A tab that does not fit is handed to the renderer as parked — it stays in
    // layout (the observer still measures it) but must not paint a fragment.
    expect(parked("tab-3")).toBe("true");
    expect(parked("tab-1")).toBeNull();
    // The active tab is scrolled into view and can be flagged mid-scroll; it
    // is never parked or the strip would blink.
    expect(parked("tab-2")).toBeNull();
  });

  it("wraps no tab in an extra box in performance mode — a sortable drag is clamped to its parent", () => {
    document.body.dataset.performanceMode = "true";
    try {
      render(<PanelTabList {...baseProps} />);
      const tab = screen.getByTestId("tab-tab-1");
      // The tab's parent is the strip's own row, not a per-tab wrapper.
      expect(tab.parentElement?.children.length).toBeGreaterThanOrEqual(1);
      expect(tab.parentElement?.getAttribute("data-tab-parked")).toBeNull();
      expect(tab.parentElement?.className).toContain("flex");
    } finally {
      delete document.body.dataset.performanceMode;
    }
  });
});
