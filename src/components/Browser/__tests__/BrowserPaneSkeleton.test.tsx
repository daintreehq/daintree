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

  it("uses animate-pulse-delayed on placeholder shapes", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const pulsing = container.querySelectorAll(".animate-pulse-delayed");
    expect(pulsing.length).toBeGreaterThan(0);
  });

  it("does not animate the content area", () => {
    const { container } = render(<BrowserPaneSkeleton />);
    const contentArea = container.querySelector(".bg-canopy-bg");
    expect(contentArea).toBeTruthy();
    expect(contentArea!.className).not.toContain("animate-pulse");
  });
});
