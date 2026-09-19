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
    expect(button.hasAttribute("data-toolbar-item")).toBe(true);
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
    expect(button.className).toContain("text-text-secondary");
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
});
