// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "../AppDialog";
import { _resetForTests } from "@/lib/escapeStack";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// The real presence hook, in `syncEnter` mode: the surface and its children
// mount in the render that opens, so a child's autoFocus fires in that commit.
describe("AppDialog opener restore with the surface mounting in the opening render", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns focus to the opener, not to the field that autofocused on open", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();

    const dialog = (isOpen: boolean) => (
      <AppDialog isOpen={isOpen} onClose={() => {}}>
        <AppDialog.Body>
          <input aria-label="Name" autoFocus />
        </AppDialog.Body>
      </AppDialog>
    );
    const { rerender } = render(dialog(true));
    await act(() => vi.runAllTimersAsync());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Name");

    rerender(dialog(false));
    await act(() => vi.runAllTimersAsync());

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
