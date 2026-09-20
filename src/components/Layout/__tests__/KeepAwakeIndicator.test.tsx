// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { KeepAwakeIndicator } from "../KeepAwakeIndicator";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("KeepAwakeIndicator", () => {
  function renderIndicator() {
    return render(<KeepAwakeIndicator />);
  }

  it("names the hold and where it leads", () => {
    const { getByTestId } = renderIndicator();
    const button = getByTestId("keep-awake-indicator");

    expect(button.getAttribute("aria-label")).toBe(
      "Keeping this machine awake, open keep-awake settings"
    );
    // Out of the toolbar, so it must not join the toolbar's roving tab order.
    expect(button.hasAttribute("data-toolbar-item")).toBe(false);
  });

  it("says what is held and what still happens", () => {
    const { getByTestId } = renderIndicator();

    expect(getByTestId("tooltip-content").textContent).toBe(
      "Keeping this machine awakeIdle sleep is held off while an agent is working. The display can still turn off."
    );
  });

  it("carries no status pip or accent", () => {
    const { getByTestId } = renderIndicator();
    const button = getByTestId("keep-awake-indicator");

    expect(button.querySelector(".toolbar-badge")).toBeNull();
    expect(button.className).not.toMatch(/\b(?:text|bg)-(?:accent|status)-/);
  });

  it("opens the keep-awake section of General settings", () => {
    const { getByTestId } = renderIndicator();

    fireEvent.click(getByTestId("keep-awake-indicator"));

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "general", subtab: "overview", sectionId: "general-keep-awake" },
      { source: "user" }
    );
  });

  describe("when the hold ends under keyboard focus", () => {
    function renderInBar(showIndicator: boolean) {
      return (
        <div data-sidebar-status-bar="">
          <button data-status-readout="" data-testid="readout">
            1 project active
          </button>
          <div>{showIndicator && <KeepAwakeIndicator />}</div>
          <button data-testid="elsewhere">elsewhere</button>
        </div>
      );
    }

    it("hands focus to the readout instead of dropping it to the body", () => {
      const { getByTestId, rerender } = render(renderInBar(true));
      getByTestId("keep-awake-indicator").focus();

      rerender(renderInBar(false));

      expect(document.activeElement).toBe(getByTestId("readout"));
    });

    it("leaves focus alone once it has moved on", () => {
      const { getByTestId, rerender } = render(renderInBar(true));
      getByTestId("elsewhere").focus();

      rerender(renderInBar(false));

      expect(document.activeElement).toBe(getByTestId("elsewhere"));
    });
  });
});
