// @vitest-environment jsdom
import { render, act, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaletteDialog } from "../AppPaletteDialog";
import { usePaletteStore } from "@/store/paletteStore";
import { _resetForTests } from "@/lib/escapeStack";
import { _resetForTests as _resetBackstopForTests } from "@/lib/dialogEscapeBackstop";
import { TABBABLE_SELECTOR } from "@/lib/accessibility";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { handleDockEscapeKeyDown } from "@/components/Layout/dockPopoverGuard";

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

const animatedPresenceState = vi.hoisted(() => ({ shouldRender: true }));

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
    return { isVisible: isOpen, shouldRender: isOpen && animatedPresenceState.shouldRender };
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

describe("AppPaletteDialog ARIA placement", () => {
  it("places role='dialog' and aria-modal on the inner panel, not the scrim", () => {
    const { container } = renderPalette({ isOpen: true });
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The inner panel is scoped to the palette body — it should NOT be the
    // fixed-inset scrim that also matches `.bg-scrim-medium`.
    expect(dialog.classList.contains("bg-scrim-medium")).toBe(false);
    // Confirm the scrim no longer carries a dialog role.
    const scrims = container.querySelectorAll('[class*="bg-scrim-medium"]');
    for (const el of scrims) {
      expect(el.getAttribute("role")).not.toBe("dialog");
    }
  });
});

describe("AppPaletteDialog focus trap", () => {
  function renderTrapPalette() {
    render(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen onClose={() => {}} ariaLabel="Trap palette">
          <input type="text" placeholder="Palette input" />
          <button type="button">Middle action</button>
          <button type="button">Last action</button>
        </AppPaletteDialog>
      </>
    );
    const dialog = screen.getByRole("dialog", { name: "Trap palette" });
    const focusable = dialog.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
    expect(focusable.length).toBeGreaterThanOrEqual(2);
    return focusable;
  }

  it("wraps focus from the last tabbable to the first on Tab", () => {
    const focusable = renderTrapPalette();
    const lastEl = focusable[focusable.length - 1]!;
    lastEl.focus();
    expect(document.activeElement).toBe(lastEl);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("wraps focus from the first tabbable to the last on Shift+Tab", () => {
    const focusable = renderTrapPalette();
    const firstEl = focusable[0]!;
    firstEl.focus();
    expect(document.activeElement).toBe(firstEl);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });
});

describe("AppPaletteDialog Escape yielded by the layer underneath", () => {
  let dockGuard: ((event: KeyboardEvent) => void) | null = null;

  beforeEach(() => {
    _resetForTests();
    _resetBackstopForTests();
  });

  afterEach(() => {
    if (dockGuard) {
      document.removeEventListener("keydown", dockGuard, true);
      dockGuard = null;
    }
    document.querySelectorAll("[data-open-radix-layer]").forEach((element) => element.remove());
    _resetForTests();
    _resetBackstopForTests();
  });

  it("closes when a dock popover underneath yields Escape", () => {
    const onClose = vi.fn();
    render(
      <AppPaletteDialog isOpen onClose={onClose} ariaLabel="Yield palette">
        <input aria-label="Palette input" />
      </AppPaletteDialog>
    );

    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("data-state", "open");
    layer.setAttribute("data-open-radix-layer", "");
    document.body.appendChild(layer);

    screen.getByRole("textbox", { name: "Palette input" }).focus();
    dockGuard = (event) => handleDockEscapeKeyDown(event, document.createElement("div"));
    document.addEventListener("keydown", dockGuard, true);

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

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
    animatedPresenceState.shouldRender = true;
    vi.useRealTimers();
  });

  it("takes provisional focus when animated presence mounts so Escape reaches the backstop", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    trigger.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = vi.fn();
    animatedPresenceState.shouldRender = false;
    const { rerender } = render(
      <AppPaletteDialog isOpen onClose={onClose} ariaLabel="Test palette">
        <input type="text" placeholder="Palette input" />
      </AppPaletteDialog>
    );
    expect(document.activeElement).toBe(trigger);

    animatedPresenceState.shouldRender = true;
    rerender(
      <AppPaletteDialog isOpen onClose={onClose} ariaLabel="Test palette">
        <input type="text" placeholder="Palette input" />
      </AppPaletteDialog>
    );

    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(document.activeElement).toBe(dialog);

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });

    expect(onClose).toHaveBeenCalledOnce();
    document.body.removeChild(trigger);
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

  it("restores focus when the palette host unmounts mid-flight", async () => {
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

    const { unmount } = renderPalette({ isOpen: true });
    await act(() => vi.runAllTimersAsync());

    document.body.removeChild(trigger);
    unmount();

    expect(document.activeElement).toBe(fallbackButton);
    expect(document.activeElement).not.toBe(document.body);
    document.body.removeChild(root);
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

  it("cancels delayed autofocus when the palette closes before its animation frame", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = renderPalette({ isOpen: true });
    rerender(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen={false} onClose={() => {}} ariaLabel="Test palette">
          <input type="text" placeholder="Palette input" />
        </AppPaletteDialog>
      </>
    );

    expect(document.activeElement).toBe(trigger);
    await act(() => vi.runAllTimersAsync());
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});

// VoiceOver suppresses `aria-live` updates outside the focused `aria-modal`
// subtree (Chromium 354736464). Daintree co-locates a live-region inside
// AppPaletteDialog so the DOM-mutation fallback path survives that bug.
describe("AppPaletteDialog co-located live region", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    _resetForTests();
  });

  it("renders an aria-live region inside the aria-modal subtree", () => {
    renderPalette({ isOpen: true });
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const liveRegions = dialog.querySelectorAll("[aria-live]");
    expect(liveRegions.length).toBeGreaterThan(0);
  });
});

// WCAG 2.3.3: the scrim only interpolates opacity, which is not vestibular, so
// reduced motion must leave its fade intact — only the panel's zoom is spatial.
// Mirrors the policy asserted in AppDialog.test.tsx; both overlay families dim
// identically.
describe("AppPaletteDialog reduced-motion policy", () => {
  beforeEach(() => {
    _resetForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    usePaletteStore.setState({ activePaletteId: null });
  });

  afterEach(() => {
    _resetForTests();
  });

  // The scrim is the panel's parent: unlike AppDialog, the palette puts
  // `role="dialog"` on the inner panel rather than the backdrop.
  function getScrim(): HTMLElement {
    const scrim = screen.getByRole("dialog", { name: "Test palette" }).parentElement;
    if (!scrim) throw new Error("AppPaletteDialog rendered no scrim around the panel");
    return scrim;
  }

  it("keeps the scrim fading under reduced motion", () => {
    renderPalette({ isOpen: true });
    const scrim = getScrim();

    expect(scrim.className).toContain("bg-scrim-medium");
    expect(scrim.className).toContain("transition-opacity");
    expect(scrim.className).not.toContain("motion-reduce:transition-none");
  });

  it("gives the scrim an explicit easing rather than the Tailwind default", () => {
    renderPalette({ isOpen: true });

    expect(getScrim().style.transitionTimingFunction).not.toBe("");
  });
});

describe("AppPaletteDialog.Body results region (#11431)", () => {
  function renderBody(onNavigationKeyDown: (e: React.KeyboardEvent) => void) {
    render(
      <>
        <Dispatcher />
        <AppPaletteDialog isOpen onClose={() => {}} ariaLabel="Body palette">
          <AppPaletteDialog.Body
            ariaLabel="Results"
            activeDescendant="option-b"
            onNavigationKeyDown={onNavigationKeyDown}
          >
            <div role="listbox" aria-label="Results list">
              <div id="option-a" role="option" aria-selected={false}>
                A
              </div>
              <div id="option-b" role="option" aria-selected>
                B
              </div>
            </div>
            <button type="button">Nested control</button>
          </AppPaletteDialog.Body>
        </AppPaletteDialog>
      </>
    );
    return screen.getByRole("group", { name: "Results" });
  }

  it("stays a tab stop so the scrollable region keeps keyboard access", () => {
    // Load-bearing for axe's scrollable-region-focusable (WCAG 2.1.1).
    expect(renderBody(vi.fn()).getAttribute("tabindex")).toBe("0");
  });

  it("mirrors the active descendant and resolves it to a real option", () => {
    const region = renderBody(vi.fn());
    const activeDescendant = region.getAttribute("aria-activedescendant");

    expect(activeDescendant).toBe("option-b");
    expect(document.getElementById(activeDescendant!)).not.toBeNull();
  });

  it.each(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"])(
    "forwards %s to the palette's navigation handler",
    (key) => {
      const onNavigationKeyDown = vi.fn();
      fireEvent.keyDown(renderBody(onNavigationKeyDown), { key });

      expect(onNavigationKeyDown).toHaveBeenCalledTimes(1);
      expect(onNavigationKeyDown.mock.calls[0]![0].key).toBe(key);
    }
  );

  it.each([
    ["Tab", false],
    ["Tab", true],
    ["PageDown", false],
    ["PageUp", false],
    [" ", false],
    ["Escape", false],
  ])("leaves %s (shift: %s) to its native behaviour", (key, shiftKey) => {
    const onNavigationKeyDown = vi.fn();
    const notCancelled = fireEvent.keyDown(renderBody(onNavigationKeyDown), { key, shiftKey });

    expect(onNavigationKeyDown).not.toHaveBeenCalled();
    // Not merely unhandled — uncancelled, so Tab still traverses and
    // Page/Space still scroll the region.
    expect(notCancelled).toBe(true);
  });

  it("forwards modified Backspace so row shortcuts survive the focus move", () => {
    const onNavigationKeyDown = vi.fn();
    fireEvent.keyDown(renderBody(onNavigationKeyDown), { key: "Backspace", metaKey: true });

    expect(onNavigationKeyDown).toHaveBeenCalledTimes(1);
  });

  it("ignores navigation keys raised by controls nested inside the region", () => {
    // Enter on the scratch-section style buttons must activate the button, not
    // confirm the palette's active result.
    const onNavigationKeyDown = vi.fn();
    renderBody(onNavigationKeyDown);
    fireEvent.keyDown(screen.getByRole("button", { name: "Nested control" }), { key: "Enter" });

    expect(onNavigationKeyDown).not.toHaveBeenCalled();
  });
});
