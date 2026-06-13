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
});
