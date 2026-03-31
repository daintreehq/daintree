/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProjectSwitchOverlay, CANCEL_BUTTON_DELAY_MS } from "../ProjectSwitchOverlay";

describe("ProjectSwitchOverlay", () => {
  it("exports the cancel button delay constant", () => {
    expect(CANCEL_BUTTON_DELAY_MS).toBe(5_000);
  });

  it("renders nothing (multi-view mode replaced renderer-side switching)", () => {
    const { container } = render(<ProjectSwitchOverlay isSwitching={true} projectName="Test" />);
    expect(container.innerHTML).toBe("");
  });
});
