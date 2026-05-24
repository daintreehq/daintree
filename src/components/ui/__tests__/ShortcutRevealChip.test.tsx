// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const displayMock = vi.fn();

vi.mock("@/hooks", () => ({
  useKeybindingDisplay: (actionId: string) => displayMock(actionId),
}));

import { ShortcutRevealChip } from "../ShortcutRevealChip";

describe("ShortcutRevealChip", () => {
  it("renders nothing when display is empty", () => {
    displayMock.mockReturnValue("");
    const { container } = render(<ShortcutRevealChip actionId="x.y" />);
    expect(container.querySelector(".shortcut-reveal-chip")).toBeNull();
  });

  it("renders the display string when present", () => {
    displayMock.mockReturnValue("Cmd+B");
    const { container } = render(<ShortcutRevealChip actionId="nav.toggleSidebar" />);
    const chip = container.querySelector(".shortcut-reveal-chip");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toBe("Cmd+B");
  });

  it("is aria-hidden so screen readers do not announce the chip", () => {
    displayMock.mockReturnValue("Cmd+,");
    const { container } = render(<ShortcutRevealChip actionId="app.settings" />);
    const chip = container.querySelector(".shortcut-reveal-chip");
    expect(chip!.getAttribute("aria-hidden")).toBe("true");
  });

  it("passes the actionId through to useKeybindingDisplay", () => {
    displayMock.mockReturnValue("Cmd+P");
    render(<ShortcutRevealChip actionId="panel.palette" />);
    expect(displayMock).toHaveBeenCalledWith("panel.palette");
  });
});
