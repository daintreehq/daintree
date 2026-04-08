// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotesPaneSkeleton } from "../NotesPaneSkeleton";

describe("NotesPaneSkeleton", () => {
  it("renders with role=status and aria-busy", () => {
    render(<NotesPaneSkeleton />);
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading notes panel");
  });

  it("has sr-only loading text", () => {
    render(<NotesPaneSkeleton />);
    expect(screen.getByText("Loading notes panel")).toBeTruthy();
  });

  it("uses animate-pulse-delayed on placeholder shapes", () => {
    const { container } = render(<NotesPaneSkeleton />);
    const pulsing = container.querySelectorAll(".animate-pulse-delayed");
    // icon + title + menu button + close button = 4
    expect(pulsing.length).toBe(4);
  });

  it("does not animate the content area", () => {
    const { container } = render(<NotesPaneSkeleton />);
    const contentArea = container.querySelector(".bg-canopy-bg");
    expect(contentArea).toBeTruthy();
    expect(contentArea!.className).not.toContain("animate-pulse");
  });

  it("marks decorative header as aria-hidden", () => {
    const { container } = render(<NotesPaneSkeleton />);
    const header = container.querySelector(".border-divider");
    expect(header).toBeTruthy();
    expect(header!.getAttribute("aria-hidden")).toBe("true");
  });
});
