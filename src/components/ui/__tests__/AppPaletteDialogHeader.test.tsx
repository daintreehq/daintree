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
  UI_DOHERTY_THRESHOLD,
  UI_PALETTE_EXIT_DURATION,
} from "@/lib/animationUtils";

function getLoadingBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".palette-loading-bar");
}

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

  it("reveals the bar with a Doherty-threshold delay when isLoading is true", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" isLoading>
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    const bar = getLoadingBar();
    expect(bar?.style.opacity).toBe("1");
    // 400ms Doherty threshold so fast loads never flash a sweep
    expect(bar?.style.transitionDelay).toBe(`${UI_DOHERTY_THRESHOLD}ms`);
    expect(bar?.style.transitionDuration).toBe(`${UI_PALETTE_ENTER_DURATION}ms`);
    expect(bar?.dataset.loading).toBe("true");
  });

  it("places the bar inside a positioned container that clips overflow", () => {
    const { container } = render(
      <AppPaletteDialog.Header label="Quick switch" isLoading>
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    // The outer header div must be `relative overflow-hidden` so the
    // absolute-positioned bar clips at the header boundary, not the
    // surrounding modal card.
    const header = container.firstElementChild as HTMLElement;
    expect(header.className).toContain("relative");
    expect(header.className).toContain("overflow-hidden");
  });

  it("still renders header label and child input", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" keyHint="⌘P" isLoading>
        <input aria-label="Search terminals" />
      </AppPaletteDialog.Header>
    );
    expect(screen.getByText("Quick switch")).toBeTruthy();
    expect(screen.getByText("⌘P")).toBeTruthy();
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

  it("prefers shortcut over keyHint when both are provided", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="Cmd+P" keyHint="⌘P">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.getByTestId("kbd-chord")).toBeTruthy();
    expect(screen.queryByText("⌘P")).toBeNull();
  });

  it("falls back to keyHint when shortcut is undefined", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" keyHint="⇧⇧">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.getByText("⇧⇧")).toBeTruthy();
    expect(screen.queryByTestId("kbd-chord")).toBeNull();
  });

  it("renders nothing when neither shortcut nor keyHint is provided", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.queryByTestId("kbd-chord")).toBeNull();
    // Only the label text should be present, no extra hint text
    expect(screen.getByText("Quick switch")).toBeTruthy();
  });

  it("falls back to keyHint when shortcut is empty string", () => {
    render(
      <AppPaletteDialog.Header label="Quick switch" shortcut="" keyHint="⌘P">
        <input aria-label="Search" />
      </AppPaletteDialog.Header>
    );
    expect(screen.getByText("⌘P")).toBeTruthy();
    expect(screen.queryByTestId("kbd-chord")).toBeNull();
  });
});
