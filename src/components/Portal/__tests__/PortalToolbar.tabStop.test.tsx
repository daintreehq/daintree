// @vitest-environment jsdom
import { useState } from "react";
import fs from "fs/promises";
import path from "path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { DRAG_GHOST_OPACITY } from "@/lib/animationUtils";
import { PortalToolbar } from "../PortalToolbar";

const { dispatchMock, claimMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  claimMock: vi.fn(),
}));

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: claimMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
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

describe("PortalToolbar tab drag — the tab strip family's pickup and ghost", () => {
  const DRAG_TABS: PortalTab[] = [
    { id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" },
    { id: "b", url: "https://chatgpt.com/", title: "ChatGPT", icon: "codex" },
  ];

  function renderDragToolbar(activeTabId: string) {
    const onTabClick = vi.fn();
    render(
      <TooltipProvider>
        <PortalToolbar
          tabs={DRAG_TABS}
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

  const tab = (name: string) => screen.getByRole("tab", { name });
  const pressSpace = (el: HTMLElement) => fireEvent.keyDown(el, { key: " ", code: "Space" });

  it("selects a background tab on Space rather than picking it up", () => {
    const onTabClick = renderDragToolbar("a");
    const background = tab("ChatGPT");
    background.focus();
    pressSpace(background);
    expect(onTabClick).toHaveBeenCalledWith("b");
    expect(background.style.opacity).toBe("");
  });

  it("picks up the selected tab from the keyboard and dims it to the shared ghost", async () => {
    const onTabClick = renderDragToolbar("a");
    const selected = tab("Claude");
    selected.focus();
    await act(async () => {
      pressSpace(selected);
    });
    expect(onTabClick).not.toHaveBeenCalled();
    expect(selected.style.opacity).toBe(String(DRAG_GHOST_OPACITY));

    // The sensor owns the arrow keys while the tab is in hand.
    fireEvent.keyDown(selected, { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(selected);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
    expect(selected.style.opacity).toBe("");
  });

  it("points each tab at the pickup instructions while it still announces as a tab", () => {
    renderDragToolbar("a");
    const selected = tab("Claude");
    const describedBy = selected.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/to pick up/i);
    expect(selected.getAttribute("aria-roledescription")).toBeNull();
  });
});

describe("PortalToolbar new-tab menu", () => {
  beforeAll(async () => {
    await primeRadix();
  });

  beforeEach(() => {
    dispatchMock.mockReset();
    claimMock.mockReset();
  });

  function renderNewTabToolbar(onNewTab = vi.fn()) {
    render(
      <TooltipProvider>
        <PortalToolbar
          tabs={[{ id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" }]}
          activeTabId="a"
          onTabClick={vi.fn()}
          onTabClose={vi.fn()}
          onNewTab={onNewTab}
          defaultNewTabUrl={null}
          onClose={vi.fn()}
          enabledLinks={[
            {
              id: "claude",
              title: "Claude",
              url: "https://claude.ai/",
              icon: "claude",
              type: "system",
              enabled: true,
              order: 0,
            },
          ]}
        />
      </TooltipProvider>
    );
    return screen.getByRole("button", { name: "New tab" });
  }

  it("opens as a React menu, the same system as the tab menus beside it", () => {
    const plus = renderNewTabToolbar();
    fireEvent.contextMenu(plus);
    const labels = Array.from(
      screen.getByRole("menu").querySelectorAll('[role="menuitem"]'),
      (item) => item.textContent
    );
    expect(labels).toEqual(["Claude", "Open launchpad", "Default new tab", "Portal settings…"]);
  });

  it("hides the native page while it is open so it is not painted underneath", () => {
    const plus = renderNewTabToolbar();
    fireEvent.contextMenu(plus);
    expect(claimMock).toHaveBeenCalledWith("portal-new-tab-menu", true);
  });

  it("opens links only after the menu has released its claim on the page", async () => {
    // portal.openUrl refuses to act while any overlay is claimed, so a link
    // dispatched from inside the still-open menu would silently do nothing.
    const events: string[] = [];
    claimMock.mockImplementation((id: string, active: boolean) => {
      if (id === "portal-new-tab-menu") events.push(`claim:${active}`);
    });
    dispatchMock.mockImplementation(() => {
      events.push("dispatch");
    });
    const plus = renderNewTabToolbar();
    fireEvent.contextMenu(plus);
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));
    await waitFor(() =>
      expect(dispatchMock).toHaveBeenCalledWith(
        "portal.openUrl",
        { url: "https://claude.ai/", title: "Claude" },
        expect.objectContaining({ source: "context-menu" })
      )
    );
    expect(events.slice(0, events.indexOf("dispatch")).at(-1)).toBe("claim:false");
  });

  it("keeps a plain click as new tab", () => {
    const onNewTab = vi.fn();
    fireEvent.click(renderNewTabToolbar(onNewTab));
    expect(onNewTab).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

const PORTAL_TOOLBAR_PATH = path.resolve(__dirname, "../PortalToolbar.tsx");

describe("PortalToolbar shortcut tooltips — issue #3819", () => {
  let source: string;

  beforeEach(async () => {
    source = await fs.readFile(PORTAL_TOOLBAR_PATH, "utf-8");
  });

  describe("useKeybindingDisplay hooks", () => {
    it("uses dynamic hook for panel.togglePortal", () => {
      expect(source).toContain('useEffectiveCombo("panel.togglePortal")');
    });

    it("uses dynamic hook for portal.newTab", () => {
      expect(source).toContain('useEffectiveCombo("portal.newTab")');
    });
  });

  describe("createTooltipContent usage", () => {
    it("uses createTooltipContent for Close portal tooltip", () => {
      expect(source).toContain('createTooltipContent("Close portal", closePortalShortcut)');
    });

    it("uses createTooltipContent for New Tab tooltip", () => {
      expect(source).toContain('createTooltipContent("New tab", newTabShortcut)');
    });
  });

  describe("aria-keyshortcuts exposure (issue #6874)", () => {
    it("calls useAriaKeyshortcuts for each tooltip-bearing button", () => {
      expect(source).toContain('useAriaKeyshortcuts("panel.togglePortal")');
      expect(source).toContain('useAriaKeyshortcuts("portal.newTab")');
    });

    it("renders aria-keyshortcuts on Close portal and New Tab buttons", () => {
      expect(source).toContain("aria-keyshortcuts={closePortalAriaShortcut}");
      expect(source).toContain("aria-keyshortcuts={newTabAriaShortcut}");
    });
  });
});
