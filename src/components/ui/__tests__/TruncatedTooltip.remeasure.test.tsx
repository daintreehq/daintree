// @vitest-environment jsdom
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

const detection = vi.hoisted(() =>
  vi.fn((_text?: string | number) => ({ ref: () => {}, isTruncated: false }))
);
vi.mock("@/hooks/useTruncationDetection", () => ({ useTruncationDetection: detection }));

import { TruncatedTooltip } from "../TruncatedTooltip";

describe("TruncatedTooltip re-measuring", () => {
  // Under React Compiler the trigger's ref is memoized, so a text change at a
  // fixed width re-measures only through the text the detector is handed.
  it("forwards each primitive content to its detector, including 0, and nothing for rich content", () => {
    const { rerender } = render(
      <TruncatedTooltip content="Reading phones…">
        <span className="block truncate">Reading phones…</span>
      </TruncatedTooltip>
    );
    expect(detection).toHaveBeenLastCalledWith("Reading phones…");

    rerender(
      <TruncatedTooltip content="2 phones with notifications">
        <span className="block truncate">2 phones with notifications</span>
      </TruncatedTooltip>
    );
    expect(detection).toHaveBeenLastCalledWith("2 phones with notifications");

    rerender(
      <TruncatedTooltip content={0}>
        <span className="truncate">0</span>
      </TruncatedTooltip>
    );
    expect(detection).toHaveBeenLastCalledWith(0);

    // Rich content's identity changes every render, so it would re-measure on each.
    rerender(
      <TruncatedTooltip content={<strong>Full label</strong>}>
        <span className="truncate">Full label</span>
      </TruncatedTooltip>
    );
    expect(detection).toHaveBeenLastCalledWith(undefined);
  });
});
