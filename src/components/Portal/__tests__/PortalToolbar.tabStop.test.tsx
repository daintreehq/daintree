// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalToolbar } from "../PortalToolbar";

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: () => "",
  useAriaKeyshortcuts: () => undefined,
}));

const TABS: PortalTab[] = [
  { id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" },
  { id: "b", url: "https://chatgpt.com/", title: "ChatGPT", icon: "codex" },
  { id: "c", url: null, title: "New Tab" },
];

function renderToolbar(activeTabId: string | null, onTabClick = vi.fn()) {
  render(
    <TooltipProvider>
      <PortalToolbar
        tabs={TABS}
        activeTabId={activeTabId}
        onTabClick={onTabClick}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
        defaultNewTabUrl={null}
        onClose={vi.fn()}
        enabledLinks={[]}
      />
    </TooltipProvider>
  );
  return onTabClick;
}

function tabStops() {
  return screen.getAllByRole("tab").filter((t) => t.tabIndex === 0);
}

afterEach(() => cleanup());

describe("PortalToolbar tab strip — one way in", () => {
  it.each([["a"], ["c"], [null]])("has exactly one tab stop when %s is active", (active) => {
    renderToolbar(active);
    expect(tabStops()).toHaveLength(1);
  });

  it("keeps close buttons out of the Tab order", () => {
    renderToolbar("a");
    const closes = screen.getAllByRole("tab").map((tab) => tab.querySelector("button"));
    expect(closes).toHaveLength(TABS.length);
    for (const close of closes) expect(close?.tabIndex).toBe(-1);
  });

  it("moves focus with the selection on arrow keys and Home/End", () => {
    const onTabClick = renderToolbar("a");
    const first = screen.getByRole("tab", { name: "Claude" });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(onTabClick).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "New Tab" }));
  });
});
