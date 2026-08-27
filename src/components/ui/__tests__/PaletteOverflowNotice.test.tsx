// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaletteOverflowNotice } from "../PaletteOverflowNotice";

describe("PaletteOverflowNotice", () => {
  it("reports the remainder, not the total", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("27");
    expect(notice.textContent).not.toContain("47");
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
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("names the recovery in the visible copy, not only the aria-label", () => {
    // The hidden rows are the matches that ranked below the cut, so there is no
    // list to open — the route is the search field. A sighted user has to be
    // able to read that route off the notice itself (#12001).
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent?.toLowerCase()).toContain("narrow");
  });

  it("exposes a descriptive aria-label so screen readers get context", () => {
    // The visible text is terse for visual scanning, so AT users get a fuller
    // phrase via aria-label that mentions "results" and the recovery.
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const label = screen.getByRole("status").getAttribute("aria-label") ?? "";
    expect(label).toContain("27");
    expect(label.toLowerCase()).toContain("results");
    expect(label.toLowerCase()).toContain("narrow");
  });
});
