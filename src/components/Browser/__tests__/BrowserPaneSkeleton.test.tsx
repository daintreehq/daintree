// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrowserPaneSkeleton } from "../BrowserPaneSkeleton";

describe("BrowserPaneSkeleton", () => {
  it("renders with role=status and aria-busy", () => {
    render(<BrowserPaneSkeleton />);
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading browser panel");
  });

  it("has sr-only loading text", () => {
    render(<BrowserPaneSkeleton />);
    expect(screen.getByText("Loading browser panel")).toBeTruthy();
  });

  it("accepts a custom label", () => {
    render(<BrowserPaneSkeleton label="Loading dev preview panel" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-label")).toBe("Loading dev preview panel");
    expect(screen.getByText("Loading dev preview panel")).toBeTruthy();
  });

  it("uses animate-pulse-delayed on all placeholder shapes", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const pulsing = container.querySelectorAll(".animate-pulse-delayed");
    // header: icon + title + menu + close = 4, toolbar: 3 nav + url bar + 2 action = 6, total = 10
    expect(pulsing.length).toBe(10);
  });

  it("does not animate the content area", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const contentArea = container.querySelector(".bg-canopy-bg");
    expect(contentArea).toBeTruthy();
    expect(contentArea!.className).not.toContain("animate-pulse");
  });

  it("marks decorative rows as aria-hidden", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const hiddenRows = container.querySelectorAll("[aria-hidden='true']");
    // header row + toolbar row = 2
    expect(hiddenRows.length).toBe(2);
  });
});
