// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { TypingLocator, getTypingLocatorDwellMs } from "../TypingLocator";
import { useTypingLocatorStore, type TypingLocatorMessage } from "@/store/typingLocatorStore";
import { LOCATE_EPISODE_MS } from "@/hooks/useTypeAnywhere";

const typing: TypingLocatorMessage = { kind: "typing", lead: "Typing into", target: "Claude" };
const added: TypingLocatorMessage = {
  kind: "file-added",
  lead: "File reference added to",
  target: "Claude",
};
const refused: TypingLocatorMessage = { kind: "file-refused", lead: "File reference not added" };

function show(message: TypingLocatorMessage) {
  act(() => {
    useTypingLocatorStore.getState().showLocator(message);
  });
}

function pill(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-typing-locator]");
}

describe("TypingLocator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTypingLocatorStore.setState({ message: null, revision: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays on screen for exactly one locate episode", () => {
    // useTypeAnywhere suppresses re-locating while the pill still names the
    // pane, so the two lifetimes must be the same span.
    const { container } = render(<TypingLocator />);
    show(typing);

    act(() => {
      vi.advanceTimersByTime(LOCATE_EPISODE_MS - 1);
    });
    expect(pill(container)).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pill(container)).toBeNull();
    expect(useTypingLocatorStore.getState().message).toBeNull();
  });

  it("never lets a file-reference receipt vanish faster than a locate", () => {
    expect(getTypingLocatorDwellMs("file-added")).toBeGreaterThanOrEqual(
      getTypingLocatorDwellMs("typing")
    );
    expect(getTypingLocatorDwellMs("file-refused")).toBeGreaterThanOrEqual(
      getTypingLocatorDwellMs("typing")
    );
  });

  it("marks a refusal with a glyph that no confirmation carries", () => {
    const { container } = render(<TypingLocator />);
    const glyphs = (message: TypingLocatorMessage) => {
      show(message);
      return pill(container)!.querySelectorAll("svg").length;
    };

    expect(glyphs(refused)).toBeGreaterThan(0);
    expect(glyphs(added)).toBe(0);
    expect(glyphs(typing)).toBe(0);
  });

  it("keeps the destination in its own element, apart from the fixed phrase", () => {
    // Only the destination may truncate — the phrase naming the action must
    // survive any title length.
    const { container } = render(<TypingLocator />);
    show({ ...typing, target: "Claude: a very long task title that will not fit" });
    const spans = pill(container)!.querySelectorAll("span");
    expect(spans).toHaveLength(2);
    expect(spans[0]!.textContent).toBe("Typing into");
    expect(spans[1]!.textContent).toBe("Claude: a very long task title that will not fit");
  });

  it("takes a fading pill straight back when the pane is located again", () => {
    const { container } = render(<TypingLocator />);
    show(typing);
    const dwell = getTypingLocatorDwellMs("typing");

    // Into the exit fade, then located again before the unmount lands.
    act(() => {
      vi.advanceTimersByTime(dwell);
    });
    show(typing);
    act(() => {
      vi.advanceTimersByTime(LOCATE_EPISODE_MS - dwell);
    });

    expect(pill(container)).not.toBeNull();
    expect(pill(container)!.className).toContain("opacity-100");
  });
});
