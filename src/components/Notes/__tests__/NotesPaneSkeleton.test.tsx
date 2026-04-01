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
    expect(pulsing.length).toBeGreaterThan(0);
  });

  it("does not animate the content area", () => {
    const { container } = render(<NotesPaneSkeleton />);
    const contentArea = container.querySelector(".bg-canopy-bg");
    expect(contentArea).toBeTruthy();
    expect(contentArea!.className).not.toContain("animate-pulse");
  });

  it("renders mode toggle placeholders", () => {
    const { container } = render(<NotesPaneSkeleton />);
    // 3 mode toggle buttons in the header actions area
    const toggleGroup = container.querySelector(".overflow-hidden");
    expect(toggleGroup).toBeTruthy();
    expect(toggleGroup!.children.length).toBe(3);
  });
});
