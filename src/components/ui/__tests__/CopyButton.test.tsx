// @vitest-environment jsdom
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CopyButton } from "../CopyButton";
import { TooltipProvider } from "../tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { UI_ACTION_SUCCESS_DWELL_MS } from "@/lib/animationUtils";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

/** The lucide glyph name rendered inside the button (`lucide-copy`, `lucide-check`). */
function glyph(button: HTMLElement): string {
  const svg = button.querySelector("svg");
  return Array.from(svg?.classList ?? []).find((c) => /^lucide-(?!icon$)/.test(c)) ?? "";
}

async function press(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
}

describe("CopyButton", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms with a glyph swap and an announcement while its name stays put", async () => {
    render(<CopyButton text="npm i" aria-label="Copy command" />);
    const button = screen.getByRole("button", { name: "Copy command" });
    const restingGlyph = glyph(button);

    await press(button);

    expect(writeText).toHaveBeenCalledWith("npm i");
    expect(glyph(button)).not.toBe(restingGlyph);
    expect(button.getAttribute("aria-label")).toBe("Copy command");
    expect(useAnnouncerStore.getState().polite?.msg).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(UI_ACTION_SUCCESS_DWELL_MS);
    });
    expect(glyph(button)).toBe(restingGlyph);
  });

  it("never paints the confirmation with a status colour", async () => {
    render(<CopyButton text="x" aria-label="Copy" />);
    const button = screen.getByRole("button", { name: "Copy" });
    await press(button);

    const painted = [button, ...Array.from(button.querySelectorAll("*"))].flatMap((el) =>
      Array.from(el.classList)
    );
    expect(painted.filter((c) => c.includes("status-"))).toEqual([]);
  });

  it("drops the confirmation when the value it copied is replaced", async () => {
    const { rerender } = render(<CopyButton text="/repo/a" aria-label="Copy path" />);
    const button = screen.getByRole("button", { name: "Copy path" });
    const restingGlyph = glyph(button);
    await press(button);
    expect(button.hasAttribute("data-copied")).toBe(true);

    rerender(<CopyButton text="/repo/b" aria-label="Copy path" />);

    expect(button.hasAttribute("data-copied")).toBe(false);
    expect(glyph(button)).toBe(restingGlyph);
  });

  it("reads a function payload at click time", async () => {
    const build = vi.fn(() => "built");
    render(<CopyButton text={build} aria-label="Copy entry" />);
    expect(build).not.toHaveBeenCalled();

    await press(screen.getByRole("button", { name: "Copy entry" }));

    expect(writeText).toHaveBeenCalledWith("built");
  });

  it("lets the caller's click handler cancel the copy", async () => {
    render(<CopyButton text="x" aria-label="Copy" onClick={(e) => e.preventDefault()} />);
    await press(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).not.toHaveBeenCalled();
  });
});
