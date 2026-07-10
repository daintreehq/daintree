// @vitest-environment jsdom
// Both dialog primitives clear stranded overlays — registered Radix
// tooltips and the ShortcutHint teaching overlay — on every open and close
// transition, and arm the tooltip focus-open suppression window so the
// focus moves they perform can't re-open a tooltip (issue #11030).
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialog } from "../AppDialog";
import { AppPaletteDialog } from "../AppPaletteDialog";
import {
  _resetForTests as resetTooltipRegistry,
  isTooltipFocusOpenSuppressed,
  registerTooltipDismiss,
} from "@/lib/tooltipDismissRegistry";
import { shortcutHintStore } from "@/store/shortcutHintStore";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

// Capture onAnimateOut instead of invoking it, so the close-transition
// tests observe the transition effect in isolation and the restore-focus
// test drives the (real-world: exit-animation-deferred) path explicitly.
const captured = vi.hoisted(() => ({
  onAnimateOut: undefined as (() => void) | undefined,
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({
    isOpen,
    onAnimateOut,
  }: {
    isOpen: boolean;
    onAnimateOut?: () => void;
  }) => {
    captured.onAnimateOut = onAnimateOut;
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

function showHint() {
  shortcutHintStore.getState().show("test.action", "Cmd+K", { x: 10, y: 20 });
}

const harnesses = [
  {
    name: "AppDialog",
    node: (isOpen: boolean) => (
      <AppDialog isOpen={isOpen} onClose={() => {}}>
        <AppDialog.Body>
          <button type="button">inside</button>
        </AppDialog.Body>
      </AppDialog>
    ),
  },
  {
    name: "AppPaletteDialog",
    node: (isOpen: boolean) => (
      <AppPaletteDialog isOpen={isOpen} onClose={() => {}} ariaLabel="Test palette">
        <input type="text" placeholder="Palette input" />
      </AppPaletteDialog>
    ),
  },
];

describe.each(harnesses)("$name overlay clearing (issue #11030)", ({ node }) => {
  beforeEach(() => {
    resetTooltipRegistry();
    shortcutHintStore.getState().hide();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      })
    );
  });

  afterEach(() => {
    resetTooltipRegistry();
    shortcutHintStore.getState().hide();
  });

  it("does not clear overlays when mounted closed", () => {
    // Most dialogs stay mounted with isOpen=false — mounting one must not
    // dismiss unrelated tooltips or hints elsewhere in the app.
    const dismissSpy = vi.fn();
    registerTooltipDismiss(dismissSpy);
    showHint();

    render(node(false));

    expect(dismissSpy).not.toHaveBeenCalled();
    expect(shortcutHintStore.getState().activeHint).not.toBeNull();
  });

  it("clears tooltips and the shortcut hint on the open transition", () => {
    const dismissSpy = vi.fn();
    registerTooltipDismiss(dismissSpy);
    showHint();
    const { rerender } = render(node(false));
    expect(dismissSpy).not.toHaveBeenCalled();

    rerender(node(true));

    expect(dismissSpy).toHaveBeenCalled();
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("clears overlays when mounted already open", () => {
    const dismissSpy = vi.fn();
    registerTooltipDismiss(dismissSpy);
    showHint();

    render(node(true));

    expect(dismissSpy).toHaveBeenCalled();
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("clears overlays again on the close transition and arms focus-open suppression", () => {
    const { rerender } = render(node(true));
    // Drop the suppression the open transition armed so the assertion below
    // observes the close transition's own arming.
    resetTooltipRegistry();
    const dismissSpy = vi.fn();
    registerTooltipDismiss(dismissSpy);
    showHint();

    rerender(node(false));

    expect(dismissSpy).toHaveBeenCalled();
    expect(shortcutHintStore.getState().activeHint).toBeNull();
    // The suppression window must be armed so the focus restore that
    // follows can't re-open a tooltip through Radix's focus path.
    expect(isTooltipFocusOpenSuppressed()).toBe(true);
  });

  it("re-arms suppression from the restore-focus path after the exit animation", () => {
    const { rerender } = render(node(true));
    rerender(node(false));
    // Drop the state the transitions armed so the assertions isolate the
    // restore-focus clear, which runs a full exit animation later.
    resetTooltipRegistry();
    const dismissSpy = vi.fn();
    registerTooltipDismiss(dismissSpy);
    showHint();

    act(() => captured.onAnimateOut?.());

    expect(dismissSpy).toHaveBeenCalled();
    expect(shortcutHintStore.getState().activeHint).toBeNull();
    expect(isTooltipFocusOpenSuppressed()).toBe(true);
  });
});
