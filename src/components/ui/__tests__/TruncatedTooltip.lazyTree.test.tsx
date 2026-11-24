// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => {
    return <div data-testid="tooltip-root">{children}</div>;
  },
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { TruncatedTooltip } from "../TruncatedTooltip";

describe("TruncatedTooltip", () => {
  it("mounts no tooltip content while the text is not truncated", () => {
    const { getByText, queryByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated={false}>
        <span>Label</span>
      </TruncatedTooltip>
    );
    expect(getByText("Label")).toBeTruthy();
    expect(queryByTestId("tooltip-content")).toBeNull();
  });

  it("mounts no tooltip content when disabled, even if truncated", () => {
    const { queryByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated disabled>
        <span>Label</span>
      </TruncatedTooltip>
    );
    expect(queryByTestId("tooltip-content")).toBeNull();
  });

  it("keeps the same DOM node when truncation flips, so focus and measurements survive", () => {
    const { getByText, rerender, queryByTestId } = render(
      <TruncatedTooltip content="Full label" isTruncated={false} focusable={false}>
        <button type="button">Label</button>
      </TruncatedTooltip>
    );
    const before = getByText("Label");
    before.focus();

    rerender(
      <TruncatedTooltip content="Full label" isTruncated focusable={false}>
        <button type="button">Label</button>
      </TruncatedTooltip>
    );
    expect(queryByTestId("tooltip-content")).not.toBeNull();
    expect(getByText("Label")).toBe(before);
    expect(document.activeElement).toBe(before);

    rerender(
      <TruncatedTooltip content="Full label" isTruncated={false} focusable={false}>
        <button type="button">Label</button>
      </TruncatedTooltip>
    );
    expect(getByText("Label")).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(queryByTestId("tooltip-content")).toBeNull();
  });

  describe("measuring its own child", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    let reads = 0;

    function countReads() {
      reads = 0;
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
        configurable: true,
        get(this: HTMLElement) {
          if (this.dataset.label !== undefined) reads += 1;
          return 0;
        },
      });
    }

    afterEach(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
    });

    it("measures the child when the caller leaves truncation to it", () => {
      countReads();
      render(
        <TruncatedTooltip content="Full label">
          <span data-label="">Label</span>
        </TruncatedTooltip>
      );
      expect(reads).toBeGreaterThan(0);
    });

    it.each([false, true])("leaves the child unmeasured when the caller says %s", (isTruncated) => {
      countReads();
      render(
        <TruncatedTooltip content="Full label" isTruncated={isTruncated}>
          <span data-label="">Label</span>
        </TruncatedTooltip>
      );
      expect(reads).toBe(0);
    });
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
