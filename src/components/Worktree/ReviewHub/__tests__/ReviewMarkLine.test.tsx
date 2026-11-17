/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewMarkLine } from "../ReviewMarkLine";

afterEach(cleanup);

function renderLine(isClearing: boolean, onClear = vi.fn()) {
  render(
    <TooltipProvider>
      <ReviewMarkLine
        reviewMark={{
          applicability: "applicable",
          mark: {
            markedAt: 1,
            capturedAt: 1,
            head: { kind: "unborn", branch: "main" },
            base: { ref: null, tip: null },
            complete: true,
            pathCount: 0,
            revision: 1,
          },
        }}
        comparison={null}
        notice={null}
        isRecording={false}
        isClearing={isClearing}
        inSinceReview={false}
        onClear={onClear}
        onRetry={vi.fn()}
        onOpenSinceReview={vi.fn()}
        onOpenFile={vi.fn()}
        onDismissNotice={vi.fn()}
      />
    </TooltipProvider>
  );
  return screen.getByTestId("review-hub-review-mark-clear");
}

describe("ReviewMarkLine clear control", () => {
  it("clears on click", () => {
    const onClear = vi.fn();
    fireEvent.click(renderLine(false, onClear));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("keeps its label while clearing and ignores clicks", () => {
    const onClear = vi.fn();
    const button = renderLine(true, onClear);
    expect(button.textContent).toBe("Clear review mark");
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onClear).not.toHaveBeenCalled();
  });
});
