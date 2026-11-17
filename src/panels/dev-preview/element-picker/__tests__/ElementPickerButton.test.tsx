// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { ElementPickerButton } from "../ElementPickerButton";

afterEach(cleanup);

function renderButton(active: boolean, onToggle = vi.fn()) {
  render(
    <TooltipProvider>
      <ElementPickerButton
        panelId="panel-1"
        projectId={null}
        worktreeId={null}
        worktreePath={null}
        url=""
        isWebviewReady={false}
        active={active}
        onToggle={onToggle}
      />
    </TooltipProvider>
  );
  return { button: screen.getByRole("button", { name: "Element Picker" }), onToggle };
}

describe("ElementPickerButton", () => {
  it("wears the toolbar's shared icon-button box and ink", () => {
    const { button } = renderButton(false);
    expect(button.className).toBe(PANE_TOOLBAR_ICON_BUTTON_CLASS);
    expect(button.querySelector("svg")?.getAttribute("class")).toContain(PANE_TOOLBAR_ICON_CLASS);
  });

  it("carries the armed state on aria-pressed and toggles on click", () => {
    const { button, onToggle } = renderButton(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
