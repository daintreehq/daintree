// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileBrowserHiddenStrip } from "../FileBrowserHiddenStrip";

afterEach(cleanup);

describe("FileBrowserHiddenStrip", () => {
  it("renders nothing at rest, so the tree pays no height for it", () => {
    // The rule that separates this from the pane-level status bar that every
    // major editor declines to ship: it exists only while it has something to
    // say.
    const { container } = render(
      <FileBrowserHiddenStrip counts={{ dotfiles: 0, alwaysHidden: 0 }} onShowDotfiles={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("stays absent when the only hidden rows are ones it cannot reveal", () => {
    // `.git` and friends are hidden permanently and by design. Counting them
    // would leave this strip on screen in every git repo forever — the exact
    // permanent status bar the conditional design exists to avoid — and would
    // offer "Show" as a recovery for rows that gesture cannot bring back.
    const { container } = render(
      <FileBrowserHiddenStrip counts={{ dotfiles: 0, alwaysHidden: 12 }} onShowDotfiles={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("appears with its recovery once the toggle is actually removing rows", () => {
    const onShowDotfiles = vi.fn();
    render(
      <FileBrowserHiddenStrip
        counts={{ dotfiles: 7, alwaysHidden: 3 }}
        onShowDotfiles={onShowDotfiles}
      />
    );
    const strip = screen.getByTestId("file-browser-hidden-strip");
    expect(strip.textContent).toContain("7");
    // By its accessible name, not its visible word: "Show" alone is ambiguous
    // out of context, so the full verb-noun is what assistive tech gets.
    fireEvent.click(screen.getByRole("button", { name: "Show dotfiles" }));
    expect(onShowDotfiles).toHaveBeenCalledTimes(1);
  });

  it("counts only what the recovery can reveal, never the unrevealable rows", () => {
    // The number and the button have to agree: offering "Show" beside a total
    // that includes junk-list rows would promise more than the click delivers.
    render(
      <FileBrowserHiddenStrip counts={{ dotfiles: 2, alwaysHidden: 40 }} onShowDotfiles={vi.fn()} />
    );
    const text = screen.getByTestId("file-browser-hidden-strip").textContent ?? "";
    expect(text).toContain("2");
    expect(text).not.toContain("42");
    expect(text).not.toContain("40");
  });

  it("agrees with itself on singular and plural", () => {
    render(
      <FileBrowserHiddenStrip counts={{ dotfiles: 1, alwaysHidden: 0 }} onShowDotfiles={vi.fn()} />
    );
    const text = screen.getByTestId("file-browser-hidden-strip").textContent ?? "";
    expect(text).toContain("dotfile hidden");
    expect(text).not.toContain("dotfiles hidden");
  });

  it("announces itself as live status rather than a page footer", () => {
    // `contentinfo` is reserved for a page-level footer; this reports what the
    // view is doing right now and changes under the user.
    render(
      <FileBrowserHiddenStrip counts={{ dotfiles: 3, alwaysHidden: 0 }} onShowDotfiles={vi.fn()} />
    );
    expect(screen.getByTestId("file-browser-hidden-strip").getAttribute("role")).toBe("status");
  });
});
