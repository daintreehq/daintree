// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SafeModeBanner } from "../SafeModeBanner";

describe("SafeModeBanner", () => {
  it("exposes a polite live region for screen readers", () => {
    render(<SafeModeBanner />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("renders the safe-mode message", () => {
    render(<SafeModeBanner />);
    expect(screen.getByText(/Safe mode/i)).toBeTruthy();
  });

  it("hides the decorative icon from assistive tech", () => {
    const { container } = render(<SafeModeBanner />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
