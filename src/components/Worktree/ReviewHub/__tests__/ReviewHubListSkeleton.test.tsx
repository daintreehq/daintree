// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewHubListSkeleton } from "../ReviewHubListSkeleton";
import { REVIEW_HUB_SECTION_BAND } from "../reviewHubUtils";

describe("ReviewHubListSkeleton", () => {
  it("opens with the section band's inset, wash and divider so a resolving list does not jump", () => {
    render(<ReviewHubListSkeleton label="Loading" onRetry={vi.fn()} />);

    const band = screen.getByTestId("review-hub-list-skeleton-band");
    for (const token of REVIEW_HUB_SECTION_BAND.split(/\s+/)) {
      expect(band.classList.contains(token)).toBe(true);
    }
    expect(band.classList.contains("border-b")).toBe(true);
    expect(band.classList.contains("border-divider")).toBe(true);
    // The loaded label's line, not a free-floating 32px bone.
    expect(band.classList.contains("text-2xs")).toBe(true);
    // Without the row the two bones stack and double the band's height.
    expect(band.firstElementChild!.classList.contains("flex")).toBe(true);
    const bones = band.querySelectorAll(".h-\\[1lh\\]");
    expect(bones).toHaveLength(2);
  });
});
