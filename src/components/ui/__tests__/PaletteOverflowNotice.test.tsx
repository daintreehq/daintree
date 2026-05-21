// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaletteOverflowNotice } from "../PaletteOverflowNotice";

describe("PaletteOverflowNotice", () => {
  it("renders when total exceeds shown", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    expect(screen.getByText("+27 more")).toBeTruthy();
  });

  it("renders nothing when total equals shown", () => {
    const { container } = render(<PaletteOverflowNotice shown={10} total={10} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when total is less than shown", () => {
    const { container } = render(<PaletteOverflowNotice shown={20} total={5} />);
    expect(container.firstChild).toBeNull();
  });

  it("has role='status' so AT announces the count", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByRole("status");
    expect(notice).toBeTruthy();
    expect(notice.textContent).toBe("+27 more");
  });

  it("exposes a descriptive aria-label so screen readers get context", () => {
    // The visible text is terse for visual scanning, so AT users get a
    // fuller phrase via aria-label that mentions "results" and the recovery
    // ("refine your search").
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByRole("status");
    const label = notice.getAttribute("aria-label") ?? "";
    expect(label).toContain("27");
    expect(label.toLowerCase()).toContain("results");
    expect(label.toLowerCase()).toContain("refine");
  });
});
