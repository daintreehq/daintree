// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaletteOverflowNotice } from "../PaletteOverflowNotice";

describe("PaletteOverflowNotice", () => {
  it("renders when total exceeds shown", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    expect(screen.getByText(/Showing 20 of 47/)).toBeTruthy();
  });

  it("renders nothing when total equals shown", () => {
    const { container } = render(<PaletteOverflowNotice shown={10} total={10} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when total is less than shown", () => {
    const { container } = render(<PaletteOverflowNotice shown={20} total={5} />);
    expect(container.firstChild).toBeNull();
  });

  it("has aria-hidden attribute", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByText(/Showing 20 of 47/);
    expect(notice.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not have role=option", () => {
    render(<PaletteOverflowNotice shown={20} total={47} />);
    const notice = screen.getByText(/Showing 20 of 47/);
    expect(notice.getAttribute("role")).toBeNull();
  });
});
