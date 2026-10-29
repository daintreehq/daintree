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

function renderToolbar(history: { canGoBack?: boolean; canGoForward?: boolean }) {
  const onGoBack = vi.fn();
  const onGoForward = vi.fn();
  render(
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
        {...history}
      />
    </TooltipProvider>
  );
  return {
    back: screen.getByRole("button", { name: "Go back" }),
    forward: screen.getByRole("button", { name: "Go forward" }),
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

    expect(back.getAttribute("aria-disabled")).toBe("true");
    expect(forward.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(back);
    fireEvent.click(forward);
    expect(onGoBack).not.toHaveBeenCalled();
    expect(onGoForward).not.toHaveBeenCalled();
  });

  it("enables only the direction the tab can go", () => {
    const { back, forward, onGoBack, onGoForward } = renderToolbar({
      canGoBack: true,
      canGoForward: false,
    });

    expect(back.getAttribute("aria-disabled")).toBeNull();
    expect(forward.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(back);
    fireEvent.click(forward);
    expect(onGoBack).toHaveBeenCalledTimes(1);
    expect(onGoForward).not.toHaveBeenCalled();
  });

  it("disables both when history is unknown", () => {
    const { back, forward } = renderToolbar({});

    expect(back.getAttribute("aria-disabled")).toBe("true");
    expect(forward.getAttribute("aria-disabled")).toBe("true");
  });
});
