// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalToolbar } from "../PortalToolbar";

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: () => {},
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
  it.each([
    ["a", "Claude"],
    ["c", "New Tab"],
    [null, "Claude"],
  ])("makes the %s tab the single tab stop", (active, expected) => {
    renderToolbar(active);
    expect(tabStops().map((t) => t.getAttribute("aria-label"))).toEqual([expected]);
  });

  it("wraps arrow navigation at both ends and honours Home", () => {
    const onTabClick = renderToolbar("a");
    const first = screen.getByRole("tab", { name: "Claude" });
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(onTabClick).toHaveBeenLastCalledWith("c");
    const last = screen.getByRole("tab", { name: "New Tab" });
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(onTabClick).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(last, { key: "Home" });
    expect(onTabClick).toHaveBeenLastCalledWith("a");
  });

  it("navigates from the focused tab, not the selected one", () => {
    const onTabClick = renderToolbar("a");
    fireEvent.keyDown(screen.getByRole("tab", { name: "ChatGPT" }), { key: "ArrowRight" });
    expect(onTabClick).toHaveBeenLastCalledWith("c");
  });

  it("ignores keys another widget already handled", () => {
    const onTabClick = renderToolbar("a");
    const tab = screen.getByRole("tab", { name: "Claude" });
    const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    event.preventDefault();
    tab.dispatchEvent(event);
    expect(onTabClick).not.toHaveBeenCalled();
  });

  it("lets Enter on a tab's close button close, not activate", () => {
    const onTabClick = renderToolbar("a");
    const close = screen.getByRole("tab", { name: "ChatGPT" }).querySelector("button")!;
    fireEvent.keyDown(close, { key: "Enter" });
    expect(onTabClick).not.toHaveBeenCalled();
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

  it("hands focus to the following tab when the focused tab is deleted", async () => {
    const onTabClose = vi.fn();
    render(
      <TooltipProvider>
        <PortalToolbar
          tabs={TABS}
          activeTabId="a"
          onTabClick={vi.fn()}
          onTabClose={onTabClose}
          onNewTab={vi.fn()}
          defaultNewTabUrl={null}
          onClose={vi.fn()}
          enabledLinks={[]}
        />
      </TooltipProvider>
    );
    const first = screen.getByRole("tab", { name: "Claude" });
    first.focus();
    fireEvent.keyDown(first, { key: "Delete" });
    expect(onTabClose).toHaveBeenCalledWith("a");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "ChatGPT" }));
  });

  it("announces tabs as tabs, not as sortable items", () => {
    renderToolbar("a");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-roledescription")).toBeNull();
    }
  });
});
