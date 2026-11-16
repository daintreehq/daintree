// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const tooltipRoot = vi.fn();

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => {
    tooltipRoot();
    return <div data-testid="tooltip-root">{children}</div>;
  },
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { TruncatedTooltip } from "../TruncatedTooltip";

describe("TruncatedTooltip", () => {
  it("renders the bare child, with no tooltip tree, while the text is not truncated", () => {
    const { getByText, queryByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated={false}>
        <span>Label</span>
      </TruncatedTooltip>
    );
    expect(getByText("Label")).toBeTruthy();
    expect(queryByTestId("tooltip-root")).toBeNull();
    expect(tooltipRoot).not.toHaveBeenCalled();
  });

  it("renders no tooltip tree when disabled, even if truncated", () => {
    const { queryByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated disabled>
        <span>Label</span>
      </TruncatedTooltip>
    );
    expect(queryByTestId("tooltip-root")).toBeNull();
  });

  it("mounts the tooltip tree once the text is truncated", () => {
    const { getByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated>
        <span>Label</span>
      </TruncatedTooltip>
    );
    expect(getByTestId("tooltip-root")).toBeTruthy();
    expect(getByTestId("tooltip-content").textContent).toBe("Full label");
  });
});
