// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buttonVariants } from "../button";
import { ROW_CONTROL_CLASS, RowControlTooltip } from "../RowControl";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean);

describe("ROW_CONTROL_CLASS", () => {
  const classes = tokens(ROW_CONTROL_CLASS);

  // WCAG 2.5.8: a target under 24px fails unless spaced. These sit packed in a
  // row, so the control itself carries the size.
  it("is a 24px target", () => {
    const square =
      classes.includes("size-6") || (classes.includes("h-6") && classes.includes("w-6"));
    expect(square).toBe(true);
  });

  it("hovers with the Ghost button's fill, so the validator's floor covers it", () => {
    const hover = (list: string[]) => list.filter((t) => t.startsWith("hover:bg-"));
    expect(hover(classes)).toEqual(hover(tokens(buttonVariants({ variant: "ghost" }))));
  });

  // `transition-opacity` alone left the fill to snap while the reveal faded.
  it("transitions the fill it paints", () => {
    const transition = classes.find((t) => t.startsWith("transition"));
    expect(transition).toBeDefined();
    expect(transition === "transition-colors" || transition!.includes("background-color")).toBe(
      true
    );
  });
});

describe("RowControlTooltip", () => {
  it("explains the control through the shared tooltip without adding a tab stop", () => {
    const { getByTestId } = render(
      <RowControlTooltip label="Pin to toolbar" shortcut="Alt+P">
        <span data-testid="control" aria-hidden="true" className={ROW_CONTROL_CLASS} />
      </RowControlTooltip>
    );
    const control = getByTestId("control");
    expect(control.hasAttribute("title")).toBe(false);
    expect(control.hasAttribute("tabindex")).toBe(false);
    const tip = getByTestId("tooltip-content");
    expect(tip.textContent).toContain("Pin to toolbar");
    expect(tip.querySelector("kbd")).not.toBeNull();
  });
});
