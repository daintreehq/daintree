// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    renderToolbar("a");
    const first = screen.getByRole("tab", { name: "Claude" });
    const last = screen.getByRole("tab", { name: "New Tab" });
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(last, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("navigates from the focused tab, not the selected one", () => {
    renderToolbar("a");
    fireEvent.keyDown(screen.getByRole("tab", { name: "ChatGPT" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "New Tab" }));
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

  it("moves focus without selecting on arrow keys and Home/End, and selects on Enter", () => {
    // Manual activation, like every document tab strip: selecting swaps the native page
    // view in, which is too much to do on every arrow press.
    const onTabClick = renderToolbar("a");
    const first = screen.getByRole("tab", { name: "Claude" });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    const last = screen.getByRole("tab", { name: "New Tab" });
    expect(document.activeElement).toBe(last);
    expect(onTabClick).not.toHaveBeenCalled();
    // The tab stop stays with the selection.
    expect(tabStops().map((t) => t.getAttribute("aria-label"))).toEqual(["Claude"]);
    fireEvent.keyDown(last, { key: "Enter" });
    expect(onTabClick).toHaveBeenLastCalledWith("c");
  });

  it("hands focus to the following tab once the focused tab is actually gone", () => {
    // The close only asks; focus moves when the tab has left the strip, not a frame
    // after the ask.
    function Host() {
      const [tabs, setTabs] = useState(TABS);
      return (
        <TooltipProvider>
          <PortalToolbar
            tabs={tabs}
            activeTabId="b"
            onTabClick={vi.fn()}
            onTabClose={(id) => setTabs((prev) => prev.filter((t) => t.id !== id))}
            onNewTab={vi.fn()}
            defaultNewTabUrl={null}
            onClose={vi.fn()}
            enabledLinks={[]}
          />
        </TooltipProvider>
      );
    }
    render(<Host />);
    const first = screen.getByRole("tab", { name: "Claude" });
    first.focus();
    act(() => {
      fireEvent.keyDown(first, { key: "Delete" });
    });
    expect(screen.queryByRole("tab", { name: "Claude" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "ChatGPT" }));
  });

  it("points every tab at the page region it switches", () => {
    renderToolbar("a");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-controls")).toBe("portal-placeholder");
    }
  });

  it("announces tabs as tabs, not as sortable items", () => {
    renderToolbar("a");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-roledescription")).toBeNull();
    }
  });

  it("gives the control row one tab stop, with arrow keys between its buttons", () => {
    renderToolbar("a");
    const row = screen.getByRole("toolbar", { name: "Portal controls" });
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);

    const [first, second] = buttons;
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
  });

  it("keeps unavailable controls in that order and inert when no page is open", () => {
    const onGoBack = vi.fn();
    render(
      <TooltipProvider>
        <PortalToolbar
          tabs={[{ id: "c", url: null, title: "New Tab" }]}
          activeTabId="c"
          onTabClick={vi.fn()}
          onTabClose={vi.fn()}
          onNewTab={vi.fn()}
          defaultNewTabUrl={null}
          onClose={vi.fn()}
          enabledLinks={[]}
          onGoBack={onGoBack}
        />
      </TooltipProvider>
    );
    const back = screen.getByRole("button", { name: "Go back" });
    expect(back.getAttribute("aria-disabled")).toBe("true");
    expect(back.hasAttribute("disabled")).toBe(false);
    back.focus();
    fireEvent.keyDown(back, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Go forward" }));
    fireEvent.click(back);
    expect(onGoBack).not.toHaveBeenCalled();
  });
});
