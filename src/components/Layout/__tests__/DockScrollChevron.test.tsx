// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// A controllable stand-in: exposes the open flag the chevron hands its tooltip,
// and a handle to raise it the way a hover would.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="tooltip" data-open={String(open)}>
      <span data-testid="hover" onClick={() => onOpenChange(true)} />
      {children}
    </div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DockScrollChevron } from "../DockScrollChevron";

afterEach(cleanup);

function chevronButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("chevron button not rendered");
  return button;
}

describe("DockScrollChevron", () => {
  it("stays mounted at the boundary but can no longer be clicked", () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <DockScrollChevron side="right" visible onClick={onClick} />
    );
    const before = chevronButton(container);
    fireEvent.click(before);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<DockScrollChevron side="right" visible={false} onClick={onClick} />);
    const after = chevronButton(container);
    // The same node, so it fades rather than vanishing from under the cursor.
    expect(after).toBe(before);
    expect(after.disabled).toBe(true);
    fireEvent.click(after);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is pointer-only in both states — hidden from AT and out of the tab order", () => {
    for (const visible of [true, false]) {
      const { container, unmount } = render(
        <DockScrollChevron side="left" visible={visible} onClick={() => {}} />
      );
      const button = chevronButton(container);
      expect(button.getAttribute("aria-hidden")).toBe("true");
      expect(button.tabIndex).toBe(-1);
      unmount();
    }
  });

  it("closes its tooltip when it hides and does not reopen it when it returns", () => {
    const { rerender } = render(<DockScrollChevron side="right" visible onClick={() => {}} />);
    act(() => {
      fireEvent.click(screen.getByTestId("hover"));
    });
    expect(screen.getByTestId("tooltip").dataset.open).toBe("true");

    rerender(<DockScrollChevron side="right" visible={false} onClick={() => {}} />);
    expect(screen.getByTestId("tooltip").dataset.open).toBe("false");

    // The pointer never "left" a disabled button; coming back must not revive it.
    rerender(<DockScrollChevron side="right" visible onClick={() => {}} />);
    expect(screen.getByTestId("tooltip").dataset.open).toBe("false");
  });
});
