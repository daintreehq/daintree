// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StrictMode } from "react";
import { AccessibilityAnnouncer } from "../AccessibilityAnnouncer";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

interface DocumentWithAriaNotify extends Document {
  ariaNotify?: (message: string, options?: { priority?: "normal" | "important" }) => void;
}

describe("AccessibilityAnnouncer", () => {
  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
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
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    expect(politeRegion?.textContent).toBe("Panel focused");
  });

  it("displays assertive announcement text", () => {
    useAnnouncerStore.setState({ assertive: { msg: "Error occurred", id: 1 } });
    const { container } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(assertiveRegion?.textContent).toBe("Error occurred");
  });

  it("renders empty when no announcements", () => {
    const { container } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');
    expect(politeRegion?.textContent).toBe("");
    expect(assertiveRegion?.textContent).toBe("");
  });

  it("preserves DOM node identity across announcements", () => {
    useAnnouncerStore.setState({ polite: { msg: "First", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: { msg: "Second", id: 2 } });
    rerender(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegionAfter = container.querySelector('[aria-live="polite"]');

    expect(politeRegion).toBe(politeRegionAfter);
  });

  it("delivers duplicate messages via clear-then-set cycle", () => {
    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    expect(politeRegion?.textContent).toBe("Panel focused");

    useAnnouncerStore.setState({ polite: { msg: "Panel focused", id: 2 } });
    rerender(<AccessibilityAnnouncer />);
    // Text should be cleared synchronously so AT registers the empty state
    expect(politeRegion?.textContent).toBe("");
    vi.advanceTimersByTime(100);
    expect(politeRegion?.textContent).toBe("Panel focused");
  });

  it("rapid announcements end with only newest text present", () => {
    useAnnouncerStore.setState({ polite: { msg: "First", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: { msg: "Second", id: 2 } });
    rerender(<AccessibilityAnnouncer />);

    useAnnouncerStore.setState({ polite: { msg: "Third", id: 3 } });
    rerender(<AccessibilityAnnouncer />);
    vi.runAllTimers();

    expect(politeRegion?.textContent).toBe("Third");
  });

  it("empty message clears the region", () => {
    useAnnouncerStore.setState({ polite: { msg: "Message", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    useAnnouncerStore.setState({ polite: null });
    rerender(<AccessibilityAnnouncer />);

    expect(politeRegion?.textContent).toBe("");
  });

  it("handles both polite and assertive independently", () => {
    useAnnouncerStore.setState({
      polite: { msg: "Polite message", id: 1 },
      assertive: { msg: "Assertive message", id: 1 },
    });
    const { container } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');

    expect(politeRegion?.textContent).toBe("Polite message");
    expect(assertiveRegion?.textContent).toBe("Assertive message");
  });

  it("delivers both polite and assertive text when set simultaneously in same render", () => {
    useAnnouncerStore.setState({
      polite: { msg: "Info", id: 1 },
      assertive: { msg: "Alert", id: 2 },
    });
    const { container } = render(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);
    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');

    expect(politeRegion?.textContent).toBe("Info");
    expect(assertiveRegion?.textContent).toBe("Alert");
  });

  it("leaves zero pending timers after unmount", () => {
    useAnnouncerStore.setState({ polite: { msg: "Message", id: 1 } });
    const { unmount } = render(<AccessibilityAnnouncer />);
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses stale callback when newer announcement supersedes pending timer", () => {
    useAnnouncerStore.setState({ polite: { msg: "First", id: 1 } });
    const { container, rerender } = render(<AccessibilityAnnouncer />);
    const politeRegion = container.querySelector('[aria-live="polite"]');

    vi.advanceTimersByTime(50);

    useAnnouncerStore.setState({ polite: { msg: "Second", id: 2 } });
    rerender(<AccessibilityAnnouncer />);
    vi.advanceTimersByTime(100);

    expect(politeRegion?.textContent).toBe("Second");
  });

  it("clears per-channel timers independently — polite update does not cancel assertive timer", () => {
    useAnnouncerStore.setState({
      polite: { msg: "Polite", id: 1 },
      assertive: { msg: "Assertive", id: 2 },
    });
    const { container, rerender } = render(<AccessibilityAnnouncer />);

    vi.advanceTimersByTime(50);

    // Update only polite — should cancel its timer but leave assertive's intact
    useAnnouncerStore.setState({ polite: { msg: "Polite updated", id: 3 } });
    rerender(<AccessibilityAnnouncer />);

    const politeRegion = container.querySelector('[aria-live="polite"]');
    const assertiveRegion = container.querySelector('[aria-live="assertive"]');

    // Assertive fires at its original 100ms deadline
    vi.advanceTimersByTime(50);
    expect(assertiveRegion?.textContent).toBe("Assertive");
    // Polite was reset at 50ms and won't fire until 150ms
    expect(politeRegion?.textContent).toBe("");

    vi.advanceTimersByTime(50);
    expect(politeRegion?.textContent).toBe("Polite updated");
    expect(assertiveRegion?.textContent).toBe("Assertive");
  });

  it("does not leak timers under StrictMode double-mount", () => {
    useAnnouncerStore.setState({ polite: { msg: "Hello", id: 1 } });
    render(
      <StrictMode>
        <AccessibilityAnnouncer />
      </StrictMode>
    );
    vi.advanceTimersByTime(100);

    const state = useAnnouncerStore.getState();
    expect(state.polite?.msg).toBe("Hello");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Workaround for Chromium 354736464: VoiceOver ignores `aria-live` updates
// outside the focused `aria-modal` subtree. When the platform exposes
// `document.ariaNotify`, the store calls it instead of mutating live-region
// DOM, so announcements bypass the subtree filter entirely.
describe("accessibilityAnnouncerStore — ariaNotify path", () => {
  let ariaNotifyMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    ariaNotifyMock = vi.fn();
    (document as DocumentWithAriaNotify).ariaNotify = ariaNotifyMock;
  });

  afterEach(() => {
    delete (document as DocumentWithAriaNotify).ariaNotify;
  });

  it("calls document.ariaNotify with priority 'normal' for polite", () => {
    useAnnouncerStore.getState().announce("Saved", "polite");
    expect(ariaNotifyMock).toHaveBeenCalledTimes(1);
    expect(ariaNotifyMock).toHaveBeenCalledWith("Saved", { priority: "normal" });
  });

  it("calls document.ariaNotify with priority 'important' for assertive", () => {
    useAnnouncerStore.getState().announce("Failure", "assertive");
    expect(ariaNotifyMock).toHaveBeenCalledTimes(1);
    expect(ariaNotifyMock).toHaveBeenCalledWith("Failure", { priority: "important" });
  });

  it("defaults to 'normal' priority when no priority is specified", () => {
    useAnnouncerStore.getState().announce("Saved");
    expect(ariaNotifyMock).toHaveBeenCalledWith("Saved", { priority: "normal" });
  });

  it("does NOT mutate the store when ariaNotify is available", () => {
    useAnnouncerStore.getState().announce("Saved", "polite");
    useAnnouncerStore.getState().announce("Failed", "assertive");
    const state = useAnnouncerStore.getState();
    expect(state.polite).toBeNull();
    expect(state.assertive).toBeNull();
    expect(state.nextId).toBe(1);
  });

  it("falls back to DOM mutation when ariaNotify throws", () => {
    ariaNotifyMock.mockImplementation(() => {
      throw new Error("AT unavailable");
    });
    useAnnouncerStore.getState().announce("Saved", "polite");
    expect(ariaNotifyMock).toHaveBeenCalledTimes(1);
    const state = useAnnouncerStore.getState();
    expect(state.polite?.msg).toBe("Saved");
  });
});

describe("accessibilityAnnouncerStore — DOM-mutation fallback", () => {
  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null, nextId: 1 });
    delete (document as DocumentWithAriaNotify).ariaNotify;
  });

  it("mutates the store when ariaNotify is unavailable", () => {
    useAnnouncerStore.getState().announce("Saved", "polite");
    const state = useAnnouncerStore.getState();
    expect(state.polite?.msg).toBe("Saved");
    expect(state.polite?.id).toBe(1);
  });

  it("routes assertive announcements to the assertive entry", () => {
    useAnnouncerStore.getState().announce("Failure", "assertive");
    const state = useAnnouncerStore.getState();
    expect(state.assertive?.msg).toBe("Failure");
    expect(state.polite).toBeNull();
  });
});
