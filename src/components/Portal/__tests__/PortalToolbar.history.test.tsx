// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalToolbar } from "../PortalToolbar";

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const TABS: PortalTab[] = [{ id: "a", url: "https://claude.ai/", title: "Claude" }];

type History = { canGoBack?: boolean; canGoForward?: boolean };

function renderToolbar(history: History) {
  const onGoBack = vi.fn();
  const onGoForward = vi.fn();
  const toolbar = (h: History) => (
    <TooltipProvider>
      <PortalToolbar
        tabs={TABS}
        activeTabId="a"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
        defaultNewTabUrl={null}
        onClose={vi.fn()}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
        hasActiveUrl
        enabledLinks={[]}
        {...h}
      />
    </TooltipProvider>
  );
  const { rerender } = render(toolbar(history));
  return {
    back: () => screen.getByRole("button", { name: "Go back" }),
    forward: () => screen.getByRole("button", { name: "Go forward" }),
    update: (h: History) => rerender(toolbar(h)),
    onGoBack,
    onGoForward,
  };
}

afterEach(() => cleanup());

describe("PortalToolbar history buttons", () => {
  it("disables Back and Forward on a tab with no history", () => {
    const { back, forward, onGoBack, onGoForward } = renderToolbar({
      canGoBack: false,
      canGoForward: false,
    });

    expect(back().getAttribute("aria-disabled")).toBe("true");
    expect(forward().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(back());
    fireEvent.click(forward());
    expect(onGoBack).not.toHaveBeenCalled();
    expect(onGoForward).not.toHaveBeenCalled();
  });

  it.each([
    ["back", { canGoBack: true, canGoForward: false }],
    ["forward", { canGoBack: false, canGoForward: true }],
  ])("enables only %s when that is the way the tab can go", (_label, history) => {
    const { back, forward, onGoBack, onGoForward } = renderToolbar(history);

    expect(back().getAttribute("aria-disabled")).toBe(history.canGoBack ? null : "true");
    expect(forward().getAttribute("aria-disabled")).toBe(history.canGoForward ? null : "true");
    fireEvent.click(back());
    fireEvent.click(forward());
    expect(onGoBack).toHaveBeenCalledTimes(history.canGoBack ? 1 : 0);
    expect(onGoForward).toHaveBeenCalledTimes(history.canGoForward ? 1 : 0);
  });

  it("follows the history as it changes", () => {
    const { back, forward, update, onGoForward } = renderToolbar({
      canGoBack: true,
      canGoForward: true,
    });

    update({ canGoBack: false, canGoForward: true });
    expect(back().getAttribute("aria-disabled")).toBe("true");
    expect(forward().getAttribute("aria-disabled")).toBeNull();

    update({ canGoBack: true, canGoForward: false });
    fireEvent.click(forward());
    expect(back().getAttribute("aria-disabled")).toBeNull();
    expect(onGoForward).not.toHaveBeenCalled();
  });

  it("disables both when history is unknown", () => {
    const { back, forward } = renderToolbar({});

    expect(back().getAttribute("aria-disabled")).toBe("true");
    expect(forward().getAttribute("aria-disabled")).toBe("true");
  });
});
