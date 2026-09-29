// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DRAG_GHOST_OPACITY } from "@/lib/animationUtils";
import { PortalToolbar } from "../PortalToolbar";

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: () => {},
}));

const TABS: PortalTab[] = [
  { id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" },
  { id: "b", url: "https://chatgpt.com/", title: "ChatGPT", icon: "codex" },
];

function renderToolbar(activeTabId: string) {
  const onTabClick = vi.fn();
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

const tab = (name: string) => screen.getByRole("tab", { name });
const pressSpace = (el: HTMLElement) => fireEvent.keyDown(el, { key: " ", code: "Space" });

afterEach(() => cleanup());

describe("PortalToolbar tab drag — the tab strip family's pickup and ghost", () => {
  it("selects a background tab on Space rather than picking it up", () => {
    const onTabClick = renderToolbar("a");
    const background = tab("ChatGPT");
    background.focus();
    pressSpace(background);
    expect(onTabClick).toHaveBeenCalledWith("b");
    expect(background.style.opacity).toBe("");
  });

  it("picks up the selected tab from the keyboard and dims it to the shared ghost", async () => {
    const onTabClick = renderToolbar("a");
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
    renderToolbar("a");
    const selected = tab("Claude");
    const describedBy = selected.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/to pick up/i);
    expect(selected.getAttribute("aria-roledescription")).toBeNull();
  });
});
