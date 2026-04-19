// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AccessibilityAnnouncer } from "../AccessibilityAnnouncer";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

describe("AccessibilityAnnouncer", () => {
  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders two aria-live regions", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(politeRegion).toBeTruthy();
    expect(assertiveRegion).toBeTruthy();
  });

  it("both regions have aria-atomic=false", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    const regions = container.querySelectorAll("[aria-atomic]");
    expect(regions.length).toBe(2);
    for (const region of regions) {
      expect(region.getAttribute("aria-atomic")).toBe("false");
    }
  });

  it("displays polite announcement text", async () => {
    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 1 } });
    const { container } = render(<AccessibilityAnnouncer />);
    await Promise.resolve();
    const politeRegion = container.querySelector('[aria-live="polite"]');
    expect(politeRegion?.textContent).toBe("Panel focused");
  });

  it("displays assertive announcement text", async () => {
    useAnnouncerStore.setState({ assertive: { msg: "Error occurred", id: 1 } });
    const { container } = render(<AccessibilityAnnouncer />);
    await Promise.resolve();
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

  it("preserves DOM node identity across announcements", () => {
    useAnnouncerStore.setState({ polite: { msg: "First", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: { msg: "Second", id: 2 } });
    rerender(<AccessibilityAnnouncer />);
    const politeRegionAfter = container.querySelector('[aria-live="polite"]');

    expect(politeRegion).toBe(politeRegionAfter);
  });

  it("delivers duplicate messages via clear-then-set cycle", async () => {
    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 2 } });
    rerender(<AccessibilityAnnouncer />);
    await Promise.resolve();

    expect(politeRegion?.textContent).toBe("Panel focused");
  });

  it("rapid announcements end with only newest text present", async () => {
    useAnnouncerStore.setState({ polite: { msg: "First", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: { msg: "Second", id: 2 } });
    rerender(<AccessibilityAnnouncer />);

    useAnnouncerStore.setState({ polite: { msg: "Third", id: 3 } });
    rerender(<AccessibilityAnnouncer />);
    await Promise.resolve();

    expect(politeRegion?.textContent).toBe("Third");
  });

  it("empty message clears the region", () => {
    useAnnouncerStore.setState({ polite: { msg: "Message", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: null });
    rerender(<AccessibilityAnnouncer />);

    expect(politeRegion?.textContent).toBe("");
  });

  it("handles both polite and assertive independently", async () => {
    useAnnouncerStore.setState({
      polite: { msg: "Polite message", id: 1 },
      assertive: { msg: "Assertive message", id: 1 },
    });
    const { container } = render(<AccessibilityAnnouncer />);
    await Promise.resolve();
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');

    expect(politeRegion?.textContent).toBe("Polite message");
    expect(assertiveRegion?.textContent).toBe("Assertive message");
  });
});
