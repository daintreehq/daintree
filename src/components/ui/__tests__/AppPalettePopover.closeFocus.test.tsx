// @vitest-environment jsdom
/**
 * The anchored palette's close-time focus through the real `PopoverContent`
 * and Radix (#17202). The sibling suite stubs the popover, which hides how the
 * shell's own policy composes with the shared one underneath: a modal palette
 * swallows the dismissing press, so nothing under it takes focus, and the shell
 * used to cancel every restoration it claimed with no fallback behind it.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPalettePopover } from "../AppPalettePopover";
import { PopoverAnchor } from "../popover";
import { primeRadix } from "../radix-loader";
import {
  _resetTooltipFocusSuppressionForTests,
  isTooltipSuppressedForElement,
} from "@/lib/tooltipFocusSuppression";

interface HarnessProps {
  modal?: boolean;
  /** Anchor-only, the way the context menu's move picker hangs off a point. */
  anchorOnly?: boolean;
  withReturnTarget?: boolean;
  /** The picked row takes the return target with it, as a moved panel does. */
  removeReturnTargetOnActivate?: boolean;
  restoreFocusOnPointerDismiss?: boolean;
  /** What the picked row's action does with focus once the palette closes. */
  onActivate?: () => void;
}

function Harness({
  modal = true,
  anchorOnly = false,
  withReturnTarget = false,
  removeReturnTargetOnActivate = false,
  restoreFocusOnPointerDismiss,
  onActivate,
}: HarnessProps) {
  const [open, setOpen] = useState(true);
  const [returnTargetMounted, setReturnTargetMounted] = useState(withReturnTarget);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const suppressRef = useRef(false);

  const consumeCloseAutoFocusSuppression = () => {
    const suppress = suppressRef.current;
    suppressRef.current = false;
    return suppress;
  };

  const activate = () => {
    suppressRef.current = true;
    setOpen(false);
    if (removeReturnTargetOnActivate) setReturnTargetMounted(false);
    onActivate?.();
  };

  return (
    <>
      {returnTargetMounted && (
        <button type="button" ref={returnFocusRef}>
          Return target
        </button>
      )}
      <AppPalettePopover isOpen={open} onOpenChange={setOpen} modal={modal}>
        {anchorOnly ? (
          <PopoverAnchor asChild>
            <span />
          </PopoverAnchor>
        ) : (
          <AppPalettePopover.Trigger>Open palette</AppPalettePopover.Trigger>
        )}
        <AppPalettePopover.Content
          ariaLabel="Test palette"
          tier="anchored"
          inputRef={inputRef}
          onClearQuery={() => {}}
          consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
          returnFocusRef={withReturnTarget ? returnFocusRef : undefined}
          restoreFocusOnPointerDismiss={restoreFocusOnPointerDismiss}
        >
          {/* Both activations stop propagation, as the real pickers' rows and
              search boxes do, so the content never sees them bubble. */}
          <input
            ref={inputRef}
            aria-label="Search"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.stopPropagation();
              activate();
            }}
          />
          <button type="button">Filter</button>
          <div
            role="option"
            aria-selected={false}
            onClick={(event) => {
              event.stopPropagation();
              activate();
            }}
          >
            Row
          </div>
        </AppPalettePopover.Content>
      </AppPalettePopover>
    </>
  );
}

async function openPalette(props: HarnessProps = {}) {
  const utils = render(<Harness {...props} />);
  const dialog = await utils.findByRole("dialog", { name: "Test palette" });
  const input = utils.getByRole("textbox", { name: "Search" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  // Radix registers its outside-pointer listener a task after mounting.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  // A modal hides everything outside it from the accessibility tree.
  const trigger = utils.queryByRole("button", { name: "Open palette", hidden: true });
  const returnTarget = utils.queryByRole("button", { name: "Return target", hidden: true });
  return { ...utils, dialog, input, trigger, returnTarget };
}

/** The whole press: Radix holds a primary-button outside press until its click. */
function pressOutside(target: Element) {
  fireEvent.pointerDown(target, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(target, { button: 0 });
  fireEvent.click(target, { button: 0, detail: 1 });
}

/**
 * Drains Radix's close-autofocus, a task after the content unmounts, and the
 * fallback it queues a task behind that. Chained rather than one long wait:
 * each timer is queued only once the one before it fired, so a stalled event
 * loop cannot resolve it ahead of the work it waits for.
 */
const settle = () =>
  act(async () => {
    for (let task = 0; task < 3; task += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

const RINGLESS = { preventScroll: true, focusVisible: false };
const RINGED = { preventScroll: true };

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  _resetTooltipFocusSuppressionForTests();
});

afterEach(async () => {
  cleanup();
  await settle();
  vi.restoreAllMocks();
});

describe("modal palette dismissed by an outside press", () => {
  it("returns focus to the trigger ringless, with its tooltip held shut", async () => {
    const { dialog, trigger } = await openPalette();
    const focusTrigger = vi.spyOn(trigger!, "focus");

    pressOutside(document.body);
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    expect(focusTrigger).toHaveBeenCalledTimes(1);
    expect(focusTrigger).toHaveBeenCalledWith(RINGLESS);
    expect(isTooltipSuppressedForElement(trigger)).toBe(true);
  });

  it("returns focus to the return target of an anchor-only palette", async () => {
    const { dialog, returnTarget } = await openPalette({
      anchorOnly: true,
      withReturnTarget: true,
    });
    const focusTarget = vi.spyOn(returnTarget!, "focus");

    pressOutside(document.body);
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));

    expect(focusTarget).toHaveBeenCalledWith(RINGLESS);
    expect(isTooltipSuppressedForElement(returnTarget)).toBe(true);
  });

  it("prefers the return target over the trigger", async () => {
    const { dialog, trigger, returnTarget } = await openPalette({ withReturnTarget: true });
    const focusTrigger = vi.spyOn(trigger!, "focus");

    pressOutside(document.body);
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));

    expect(focusTrigger).not.toHaveBeenCalled();
  });

  it("leaves focus on whatever took it before the fallback", async () => {
    const { dialog, trigger } = await openPalette();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const focusTrigger = vi.spyOn(trigger!, "focus");

    pressOutside(outside);
    expect(dialog.isConnected).toBe(false);
    outside.focus();
    await settle();

    expect(focusTrigger).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("leaves a palette that keeps Radix's pointer restoration to Radix", async () => {
    const { dialog, trigger } = await openPalette({ restoreFocusOnPointerDismiss: true });
    const focusTrigger = vi.spyOn(trigger!, "focus");

    pressOutside(document.body);
    expect(dialog.isConnected).toBe(false);
    await settle();

    // Radix's own bare `.focus()` and nothing behind it.
    expect(focusTrigger.mock.calls).toEqual([[]]);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("palette close that hands focus to what it launched", () => {
  it("keeps focus on the surface the launch reached", async () => {
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    // After the close commit, so the modal trap is no longer there to refuse it.
    const { dialog, trigger, getByRole } = await openPalette({
      onActivate: () => queueMicrotask(() => elsewhere.focus()),
    });
    const focusTrigger = vi.spyOn(trigger!, "focus");

    fireEvent.click(getByRole("option", { name: "Row" }), { detail: 1 });
    expect(dialog.isConnected).toBe(false);
    await settle();

    expect(focusTrigger).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("returns focus ringless when a pointer-picked launch declined", async () => {
    const { dialog, trigger, getByRole } = await openPalette();
    const focusTrigger = vi.spyOn(trigger!, "focus");

    fireEvent.click(getByRole("option", { name: "Row" }), { detail: 1 });
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    expect(focusTrigger).toHaveBeenCalledTimes(1);
    expect(focusTrigger).toHaveBeenCalledWith(RINGLESS);
    expect(isTooltipSuppressedForElement(trigger)).toBe(true);
  });

  it("returns focus with its ring when a keyboard-picked launch declined", async () => {
    const { dialog, input, trigger, getByRole } = await openPalette();
    const focusTrigger = vi.spyOn(trigger!, "focus");

    // A click that closes nothing first, so the Enter has a pointer gesture to
    // supersede even though it never bubbles to the content.
    fireEvent.click(getByRole("button", { name: "Filter" }), { detail: 1 });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    expect(focusTrigger).toHaveBeenCalledTimes(1);
    expect(focusTrigger).toHaveBeenCalledWith(RINGED);
  });

  it("returns a declined launch to the return target of an anchor-only palette", async () => {
    const { dialog, returnTarget, getByRole } = await openPalette({
      anchorOnly: true,
      withReturnTarget: true,
    });

    fireEvent.click(getByRole("option", { name: "Row" }), { detail: 1 });
    expect(dialog.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));
  });

  it("restores nothing when the launch took the return target with it", async () => {
    const { dialog, returnTarget, getByRole } = await openPalette({
      anchorOnly: true,
      withReturnTarget: true,
      removeReturnTargetOnActivate: true,
    });
    const focusTarget = vi.spyOn(returnTarget!, "focus");

    fireEvent.click(getByRole("option", { name: "Row" }), { detail: 1 });
    expect(dialog.isConnected).toBe(false);
    await settle();

    expect(focusTarget).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("palette keyboard dismissal", () => {
  it("returns focus to the trigger on Escape, ring and all", async () => {
    const { dialog, input, trigger } = await openPalette();
    const focusTrigger = vi.spyOn(trigger!, "focus");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(dialog.isConnected).toBe(false);
    await settle();

    // Radix's bare `.focus()`, which Chromium rings, and no fallback behind it.
    expect(focusTrigger.mock.calls).toEqual([[]]);
    expect(document.activeElement).toBe(trigger);
  });
});
