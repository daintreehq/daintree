// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { AccessibilityAnnouncer } from "../AccessibilityAnnouncer";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

describe("AccessibilityAnnouncer", () => {
  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  it("renders two aria-live regions", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(politeRegion).toBeTruthy();
    expect(assertiveRegion).toBeTruthy();
  });

  it("both regions have aria-atomic=true", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    const regions = container.querySelectorAll("[aria-atomic]");
    expect(regions.length).toBe(2);
    for (const region of regions) {
      expect(region.getAttribute("aria-atomic")).toBe("true");
    }
  });

  it("displays polite announcement text", () => {
    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 1 } });
    const { container } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    expect(politeRegion?.textContent).toBe("Panel focused");
  });

  it("displays assertive announcement text", () => {
    useAnnouncerStore.setState({ assertive: { msg: "Error occurred", id: 1 } });
    const { container } = render(<AccessibilityAnnouncer />);
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(assertiveRegion?.textContent).toBe("Error occurred");
  });

  it("renders empty when no announcements", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(politeRegion?.textContent).toBe("");
    expect(assertiveRegion?.textContent).toBe("");
  });
});
