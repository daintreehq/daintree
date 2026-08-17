// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
  useEscapeStack: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/components/ui/Kbd", () => ({
  KbdChord: ({
    shortcut,
    "aria-label": ariaLabel,
  }: {
    shortcut: string;
    "aria-label"?: string;
  }) => (
    <span data-testid="kbd-chord" data-shortcut={shortcut} aria-label={ariaLabel}>
      {shortcut}
    </span>
  ),
}));

import { AppPaletteDialog } from "../AppPaletteDialog";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_STALE_DELAY,
  UI_PALETTE_EXIT_DURATION,
} from "@/lib/animationUtils";

function getLoadingBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".palette-loading-bar");
}

describe("AppPaletteDialog.Header trailing metadata", () => {
  it("shows the metadata alongside the label, the shortcut and the input", () => {
    render(
      <AppPaletteDialog.Header
        label="Switch project"
        shortcut="Cmd+P"
        trailing={<span>3 running</span>}
      >
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );

    expect(screen.getByText("Switch project")).toBeTruthy();
    expect(screen.getByText("3 running")).toBeTruthy();
    expect(screen.getByTestId("kbd-chord")).toBeTruthy();
    expect(screen.getByLabelText("Search")).toBeTruthy();
  });

  it("leaves a header without metadata exactly as it was", () => {
    // The label row spaces its children apart, so grouping the chord into a
    // wrapper unconditionally would shift it on every palette that never asked
    // for a trailing slot. Without metadata the chord stays the label's own
    // sibling.
    const { container } = render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="Cmd+K">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const chord = container.querySelector("[data-testid='kbd-chord']");

    expect(chord?.previousElementSibling?.textContent).toBe("Quick switch");
  });

  it("groups the chord with the metadata when there is metadata to group", () => {
    const { container } = render(
      <AppPaletteDialog.Header
        label="Switch project"
        shortcut="Cmd+P"
        trailing={<span>3 running</span>}
      >
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const chord = container.querySelector("[data-testid='kbd-chord']");

    // Now they travel together at the row's far end, so the metadata does not
    // land marooned in the middle of a spaced-apart row.
    expect(chord?.previousElementSibling?.textContent).toBe("3 running");
  });
});

describe("AppPaletteDialog.Header loading bar", () => {
  it("renders the loading bar element so it can fade in/out", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const bar = getLoadingBar();
    expect(bar).not.toBeNull();
    // aria-hidden so screen readers ignore the decorative bar
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    // Inner sweep element is present for the indeterminate animation
    expect(bar?.querySelector(".palette-loading-bar__sweep")).not.toBeNull();
  });

  it("keeps the bar invisible when isLoading is omitted", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const bar = getLoadingBar();
    expect(bar?.style.opacity).toBe("0");
    expect(bar?.style.transitionDelay).toBe("0ms");
    expect(bar?.style.transitionDuration).toBe(`${UI_PALETTE_EXIT_DURATION}ms`);
    expect(bar?.dataset.loading).toBe("false");
  });

  it("reveals the bar with the palette stale-delay gate when isLoading is true", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" isLoading>
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const bar = getLoadingBar();
    expect(bar?.style.opacity).toBe("1");
    // Palette typed-input gate (200ms) — shorter than Doherty's 400ms because
    // keystrokes arrive every ~200ms at normal typing speed; a 400ms gate
    // would almost never fire before the next keystroke reset it.
    expect(bar?.style.transitionDelay).toBe(`${UI_PALETTE_STALE_DELAY}ms`);
    expect(bar?.style.transitionDuration).toBe(`${UI_PALETTE_ENTER_DURATION}ms`);
    expect(bar?.dataset.loading).toBe("true");
  });

  it("still renders header label and child input", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="Cmd+P" isLoading>
        <input aria-label="Search terminals" />
      </AppPaletteDialog.Header>
    );
    expect(screen.getByText("Quick switch")).toBeTruthy();
    expect(screen.getByTestId("kbd-chord")).toBeTruthy();
    expect(screen.getByLabelText("Search terminals")).toBeTruthy();
  });

  it("renders KbdChord when shortcut is provided", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="Cmd+P">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const chord = screen.getByTestId("kbd-chord");
    expect(chord).toBeTruthy();
    expect(chord.dataset.shortcut).toBe("Cmd+P");
  });

  it("renders nothing when shortcut is not provided", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.queryByTestId("kbd-chord")).toBeNull();
    // Only the label text should be present, no extra hint text
    expect(screen.getByText("Quick switch")).toBeTruthy();
  });

  it("renders nothing when shortcut is empty string", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.queryByTestId("kbd-chord")).toBeNull();
  });
});
