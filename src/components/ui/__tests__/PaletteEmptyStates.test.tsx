// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { AppPaletteDialog } from "../AppPaletteDialog";

describe("AppPaletteDialog.Empty", () => {
  it("renders children when query is empty (no-data state)", () => {
    render(
      <AppPaletteDialog.Empty query="" emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByTestId("cta")).toBeTruthy();
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("renders children when query is whitespace only", () => {
    render(
      <AppPaletteDialog.Empty query="   " emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByTestId("cta")).toBeTruthy();
  });

  it("does NOT render children when query has text (no-match state)", () => {
    render(
      <AppPaletteDialog.Empty query="foo" emptyMessage="No items available">
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.queryByTestId("cta")).toBeNull();
    expect(screen.getByText('No matches for "foo"')).toBeTruthy();
  });

  describe("filterLabel", () => {
    it("names the filter when it is the only thing excluding rows", () => {
      // Without this the zero-data branch claims the surface is empty while a
      // filter the user set is what emptied it — the ghost-filter dead end.
      render(
        <AppPaletteDialog.Empty query="" emptyMessage="No items available" filterLabel="Needs you">
          <span data-testid="cta">Create a terminal</span>
        </AppPaletteDialog.Empty>
      );

      expect(screen.getByText("No matches with Needs you selected")).toBeTruthy();
      expect(screen.queryByText("No items available")).toBeNull();
      // A narrowed empty is not a zero-data empty, so the zero-data CTA has no
      // business being the action offered for it.
      expect(screen.queryByTestId("cta")).toBeNull();
    });

    it("names both constraints when a query and a filter are active together", () => {
      render(
        <AppPaletteDialog.Empty
          query="auth"
          emptyMessage="No items available"
          filterLabel="Working"
        />
      );

      expect(screen.getByText('No matches for "auth" with Working selected')).toBeTruthy();
    });

    it("offers the filtered action once a filter is active without a query", () => {
      render(
        <AppPaletteDialog.Empty
          query=""
          emptyMessage="No items available"
          filterLabel="Working"
          noMatchContent={<span data-testid="clear">Clear filter</span>}
        />
      );

      expect(screen.getByTestId("clear")).toBeTruthy();
    });
  });

  it("renders noMatchContent when query has text (no-match state)", () => {
    render(
      <AppPaletteDialog.Empty
        query="foo"
        emptyMessage="No items available"
        noMatchContent={<span data-testid="productive-row">Create action</span>}
      >
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByText('No matches for "foo"')).toBeTruthy();
    expect(screen.getByTestId("productive-row")).toBeTruthy();
    expect(screen.queryByTestId("cta")).toBeNull();
  });

  it("does NOT render noMatchContent when query is empty (zero-data state)", () => {
    render(
      <AppPaletteDialog.Empty
        query=""
        emptyMessage="No items available"
        noMatchContent={<span data-testid="productive-row">Create action</span>}
      >
        <span data-testid="cta">Create a terminal</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByText("No items available")).toBeTruthy();
    expect(screen.getByTestId("cta")).toBeTruthy();
    expect(screen.queryByTestId("productive-row")).toBeNull();
  });

  it("renders without children when none provided", () => {
    render(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
    expect(screen.getByText("No items available")).toBeTruthy();
  });

  it("shows noMatchMessage when query present and noMatchMessage provided", () => {
    render(
      <AppPaletteDialog.Empty
        query="xyz"
        emptyMessage="No items available"
        noMatchMessage="Nothing found"
      >
        <span data-testid="cta">hint</span>
      </AppPaletteDialog.Empty>
    );
    expect(screen.getByText("Nothing found")).toBeTruthy();
    expect(screen.queryByTestId("cta")).toBeNull();
  });

  it('exposes role="status" so screen readers announce the empty state', () => {
    render(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
    const status = screen.getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it('also exposes role="status" with aria-live polite in the no-match case', () => {
    render(
      <AppPaletteDialog.Empty
        query="zzz"
        emptyMessage="No items available"
        noMatchMessage="Nothing found"
      />
    );
    const status = screen.getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("trims whitespace from query when rendering the no-match state", () => {
    render(<AppPaletteDialog.Empty query="  foo  " emptyMessage="No items available" />);
    expect(screen.getByText('No matches for "foo"')).toBeTruthy();
  });

  it("truncates the quoted query at 40 characters in the default no-match title", () => {
    const long = "a".repeat(60);
    render(<AppPaletteDialog.Empty query={long} emptyMessage="No items available" />);
    const expected = `No matches for "${"a".repeat(40)}…"`;
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("does not truncate queries at exactly 40 characters", () => {
    const exact = "b".repeat(40);
    render(<AppPaletteDialog.Empty query={exact} emptyMessage="No items available" />);
    expect(screen.getByText(`No matches for "${exact}"`)).toBeTruthy();
  });

  it("truncates a 41-character query at position 40 with the ellipsis", () => {
    const overByOne = "c".repeat(41);
    render(<AppPaletteDialog.Empty query={overByOne} emptyMessage="No items available" />);
    expect(screen.getByText(`No matches for "${"c".repeat(40)}…"`)).toBeTruthy();
  });

  it("does not split surrogate pairs when truncating", () => {
    const query = "a".repeat(39) + "😀tail";
    render(<AppPaletteDialog.Empty query={query} emptyMessage="No items available" />);
    const expected = `No matches for "${"a".repeat(39)}😀…"`;
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("explicit noMatchMessage still overrides the dynamic default", () => {
    render(
      <AppPaletteDialog.Empty
        query="anything"
        emptyMessage="No items available"
        noMatchMessage="Custom not-found copy"
      />
    );
    expect(screen.getByText("Custom not-found copy")).toBeTruthy();
    expect(screen.queryByText(/No matches for/)).toBeNull();
  });

  describe("debounced sr-only live region", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not announce immediately — sr-only text is empty at time 0", () => {
      render(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("");
    });

    it("announces the title after the 600ms debounce", () => {
      render(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const status = screen.getByRole("status");
      expect(status.textContent).toBe('No matches for "foo"');
    });

    it("announces the zero-data title after 600ms", () => {
      render(<AppPaletteDialog.Empty query="" emptyMessage="Nothing here" />);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("Nothing here");
    });

    it("resets the timer on rapid prop changes, announcing only the final title", () => {
      const { rerender } = render(
        <AppPaletteDialog.Empty query="f" emptyMessage="No items available" />
      );
      act(() => {
        vi.advanceTimersByTime(200);
      });
      rerender(<AppPaletteDialog.Empty query="fo" emptyMessage="No items available" />);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      rerender(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const status = screen.getByRole("status");
      expect(status.textContent).toBe('No matches for "foo"');
    });

    it("clear-then-set allows repeated identical queries to re-announce", () => {
      const { rerender } = render(
        <AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole("status").textContent).toBe('No matches for "foo"');

      // Clear query then re-enter the same search
      rerender(<AppPaletteDialog.Empty query="" emptyMessage="No items available" />);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.getByRole("status").textContent).toBe("No items available");

      rerender(<AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      // Should announce the same message again — Chromium would suppress this
      // without the clear-then-set pattern.
      expect(screen.getByRole("status").textContent).toBe('No matches for "foo"');
    });

    it("announces custom noMatchMessage after debounce", () => {
      render(
        <AppPaletteDialog.Empty
          query="xyz"
          emptyMessage="No items available"
          noMatchMessage="Nothing found"
        />
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      const status = screen.getByRole("status");
      expect(status.textContent).toBe("Nothing found");
    });

    it("clears the timer on unmount", () => {
      const { unmount } = render(
        <AppPaletteDialog.Empty query="foo" emptyMessage="No items available" />
      );
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      // Advancing past the debounce after unmount should not throw (timer was cleared)
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
