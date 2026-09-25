// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { scrollAndHighlightSettingsSection, useSettingsScrollToSection } from "../SettingsDialog";

/**
 * Tests for the deep-link scroll mechanism (#6878).
 *
 * The scroll/highlight is driven by `useSettingsScrollToSection`, a
 * `useLayoutEffect`-based hook hosted inside each settings tab's panel
 * subtree. It fires synchronously when the subtree commits, so the target
 * element is guaranteed to be in the DOM by the time we look for it —
 * replacing the rAF polling loop that raced Suspense reveals on slow
 * hardware.
 */

function setupSection(id: string, withInput = false): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  el.scrollIntoView = vi.fn();
  if (withInput) {
    const input = document.createElement("input");
    el.appendChild(input);
  }
  document.body.appendChild(el);
  return el;
}

describe("scrollAndHighlightSettingsSection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns false and is a no-op when the element is missing", () => {
    expect(scrollAndHighlightSettingsSection("missing")).toBe(false);
  });

  it("scrolls, focuses the first input, and adds the highlight class", () => {
    const el = setupSection("section-foo", true);
    const input = el.querySelector("input")!;
    const focusSpy = vi.spyOn(input, "focus");

    expect(scrollAndHighlightSettingsSection("section-foo")).toBe(true);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "start" });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(el.classList.contains("settings-highlight")).toBe(true);
  });

  it("does not throw when the section has no inner input", () => {
    const el = setupSection("section-bar", false);
    expect(() => scrollAndHighlightSettingsSection("section-bar")).not.toThrow();
    expect(el.classList.contains("settings-highlight")).toBe(true);
  });

  it("removes the highlight class after 1500ms", () => {
    vi.useFakeTimers();
    const el = setupSection("section-baz");
    scrollAndHighlightSettingsSection("section-baz");
    expect(el.classList.contains("settings-highlight")).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(el.classList.contains("settings-highlight")).toBe(false);
  });
});

describe("useSettingsScrollToSection", () => {
  function Probe({
    isActive,
    scrollToSectionId,
    onHandled,
  }: {
    isActive: boolean;
    scrollToSectionId: string | null;
    onHandled: (id: string) => void;
  }) {
    useSettingsScrollToSection(isActive, scrollToSectionId, onHandled);
    return null;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls and calls onHandled when active with a section id", () => {
    const el = setupSection("section-active");
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId="section-active" onHandled={onHandled} />);

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith("section-active", true);
  });

  it("does nothing when not active", () => {
    const el = setupSection("section-inactive");
    const onHandled = vi.fn();

    render(<Probe isActive={false} scrollToSectionId="section-inactive" onHandled={onHandled} />);

    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(onHandled).not.toHaveBeenCalled();
  });

  it("does nothing when scrollToSectionId is null", () => {
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId={null} onHandled={onHandled} />);

    expect(onHandled).not.toHaveBeenCalled();
  });

  it("calls onHandled even when the element is missing (lets parent clear stale state)", () => {
    const onHandled = vi.fn();

    render(<Probe isActive={true} scrollToSectionId="section-missing" onHandled={onHandled} />);

    expect(onHandled).toHaveBeenCalledWith("section-missing", false);
  });

  it("fires once per scrollToSectionId change", () => {
    setupSection("section-a");
    setupSection("section-b");
    const onHandled = vi.fn();

    const { rerender } = render(
      <Probe isActive={true} scrollToSectionId="section-a" onHandled={onHandled} />
    );
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenLastCalledWith("section-a", true);

    // Same id, same deps — no re-fire.
    rerender(<Probe isActive={true} scrollToSectionId="section-a" onHandled={onHandled} />);
    expect(onHandled).toHaveBeenCalledTimes(1);

    // New id — fires.
    rerender(<Probe isActive={true} scrollToSectionId="section-b" onHandled={onHandled} />);
    expect(onHandled).toHaveBeenCalledTimes(2);
    expect(onHandled).toHaveBeenLastCalledWith("section-b", true);
  });

  it("fires when isActive transitions from false to true with a pending id", () => {
    const el = setupSection("section-late");
    const onHandled = vi.fn();

    const { rerender } = render(
      <Probe isActive={false} scrollToSectionId="section-late" onHandled={onHandled} />
    );
    expect(el.scrollIntoView).not.toHaveBeenCalled();

    rerender(<Probe isActive={true} scrollToSectionId="section-late" onHandled={onHandled} />);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledWith("section-late", true);
  });
});
