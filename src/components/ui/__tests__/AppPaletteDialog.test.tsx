// @vitest-environment jsdom
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaletteDialog } from "../AppPaletteDialog";
import { usePaletteStore } from "@/store/paletteStore";
import { _resetForTests } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({
    isOpen,
    onAnimateOut,
  }: {
    isOpen: boolean;
    onAnimateOut?: () => void;
  }) => {
    // Mirror real timing closely enough for focus assertions: the exit
    // path runs onAnimateOut synchronously when isOpen flips to false.
    if (!isOpen && onAnimateOut) onAnimateOut();
    return { isVisible: isOpen, shouldRender: isOpen };
  },
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function Dispatcher() {
  useGlobalEscapeDispatcher();
  return null;
}

function renderPalette(props: { isOpen: boolean }) {
  return render(
    <>
      <Dispatcher />
      <AppPaletteDialog isOpen={props.isOpen} onClose={() => {}} ariaLabel="Test palette">
        <input type="text" placeholder="Palette input" />
      </AppPaletteDialog>
    </>
  );
}

describe("AppPaletteDialog focus restore", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    _resetForTests();
    usePaletteStore.setState({ activePaletteId: null });
    vi.useRealTimers();
  });

  it("falls back to first tabbable in #root when trigger was unmounted", async () => {
    const root = document.createElement("div");
    root.id = "root";
    const fallbackButton = document.createElement("button");
    fallbackButton.textContent = "Fallback";
    root.appendChild(fallbackButton);
    document.body.appendChild(root);

    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderPalette({ isOpen: true });
    await act(() => vi.runAllTimersAsync());

    document.body.removeChild(trigger);

    rerender(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen={false} onClose={() => {}} ariaLabel="Test palette">
          <input type="text" placeholder="Palette input" />
        </AppPaletteDialog>
      </>
    );

    expect(document.activeElement).toBe(fallbackButton);
    expect(document.activeElement).not.toBe(document.body);
    document.body.removeChild(root);
  });

  it("skips focus restore when activePaletteId is set (palette handoff)", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderPalette({ isOpen: true });
    await act(() => vi.runAllTimersAsync());

    // The next palette has taken over — we should NOT focus back into the trigger.
    usePaletteStore.setState({ activePaletteId: "action" });

    // Move focus elsewhere so we can prove restore did NOT happen.
    const sentinel = document.createElement("input");
    document.body.appendChild(sentinel);
    sentinel.focus();
    expect(document.activeElement).toBe(sentinel);

    rerender(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen={false} onClose={() => {}} ariaLabel="Test palette">
          <input type="text" placeholder="Palette input" />
        </AppPaletteDialog>
      </>
    );

    // Focus stayed on the sentinel — no restore back to the original trigger.
    expect(document.activeElement).toBe(sentinel);
    expect(document.activeElement).not.toBe(trigger);

    document.body.removeChild(sentinel);
    document.body.removeChild(trigger);
  });

  it("restores to the original trigger when it is still mounted", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderPalette({ isOpen: true });
    await act(() => vi.runAllTimersAsync());

    rerender(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen={false} onClose={() => {}} ariaLabel="Test palette">
          <input type="text" placeholder="Palette input" />
        </AppPaletteDialog>
      </>
    );

    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
