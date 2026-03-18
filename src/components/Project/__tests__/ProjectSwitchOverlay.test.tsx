/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const finishProjectSwitchMock = vi.fn();

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      finishProjectSwitch: finishProjectSwitchMock,
    }),
  },
  SWITCH_SAFETY_TIMEOUT_MS: 30_000,
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: () => ({
    isVisible: true,
    shouldRender: true,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const { ProjectSwitchOverlay, CANCEL_BUTTON_DELAY_MS } = await import("../ProjectSwitchOverlay");

describe("ProjectSwitchOverlay cancel button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show the cancel button before the delay", () => {
    render(<ProjectSwitchOverlay isSwitching={true} projectName="Test" />);

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.parentElement?.className).toContain("pointer-events-none");
  });

  it("shows the cancel button after the delay", () => {
    render(<ProjectSwitchOverlay isSwitching={true} projectName="Test" />);

    act(() => {
      vi.advanceTimersByTime(CANCEL_BUTTON_DELAY_MS);
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.parentElement?.className).not.toContain("pointer-events-none");
  });

  it("calls finishProjectSwitch when cancel is clicked", () => {
    render(<ProjectSwitchOverlay isSwitching={true} projectName="Test" />);

    act(() => {
      vi.advanceTimersByTime(CANCEL_BUTTON_DELAY_MS);
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(finishProjectSwitchMock).toHaveBeenCalledTimes(1);
  });

  it("resets cancel button visibility when isSwitching becomes false", () => {
    const { rerender } = render(<ProjectSwitchOverlay isSwitching={true} projectName="Test" />);

    act(() => {
      vi.advanceTimersByTime(CANCEL_BUTTON_DELAY_MS);
    });

    let cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.parentElement?.className).not.toContain("pointer-events-none");

    rerender(<ProjectSwitchOverlay isSwitching={false} projectName="Test" />);

    cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton.parentElement?.className).toContain("pointer-events-none");
  });
});
