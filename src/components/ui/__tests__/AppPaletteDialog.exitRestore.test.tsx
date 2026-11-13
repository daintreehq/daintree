// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPaletteDialog } from "../AppPaletteDialog";
import {
  consumeDeferredPaletteFocusRestore,
  consumePaletteFocusRestoreSuppression,
  deferPaletteFocusRestore,
  suppressPaletteFocusRestore,
} from "../paletteFocusRestore";
import { usePaletteStore } from "@/store/paletteStore";
import { UI_PALETTE_EXIT_DURATION } from "@/lib/animationUtils";

// The real exit animation, unlike AppPaletteDialog.test.tsx: the restore runs
// from the exit timer, after whatever the pick did with the keyboard (#16923).

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function Palettes({ first, second = false }: { first: boolean; second?: boolean }) {
  return (
    <>
      <AppPaletteDialog isOpen={first} onClose={() => {}} ariaLabel="Actions" tier="command">
        <input type="text" placeholder="Actions input" />
      </AppPaletteDialog>
      <AppPaletteDialog isOpen={second} onClose={() => {}} ariaLabel="Panels" tier="command">
        <input type="text" placeholder="Panels input" />
      </AppPaletteDialog>
    </>
  );
}

/** Lets the autofocus frame run without reaching the exit timer. */
const settleOpen = () => act(() => vi.advanceTimersByTimeAsync(20));
const finishExits = () => act(() => vi.advanceTimersByTimeAsync(UI_PALETTE_EXIT_DURATION * 3));

describe("AppPaletteDialog restore at the end of the exit animation", () => {
  let trigger: HTMLButtonElement;
  let target: HTMLInputElement;
  let fallback: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    usePaletteStore.setState({ activePaletteId: null });
    const root = document.createElement("div");
    root.id = "root";
    fallback = document.createElement("button");
    root.appendChild(fallback);
    trigger = document.createElement("button");
    target = document.createElement("input");
    document.body.append(root, trigger, target);
    trigger.focus();
  });

  afterEach(() => {
    document.getElementById("root")?.remove();
    trigger.remove();
    target.remove();
    usePaletteStore.setState({ activePaletteId: null });
    consumeDeferredPaletteFocusRestore();
    consumePaletteFocusRestoreSuppression();
    vi.useRealTimers();
  });

  it("returns a dismissal to the opener once the exit finishes", async () => {
    const { rerender } = render(<Palettes first />);
    await settleOpen();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Actions input"));

    rerender(<Palettes first={false} />);
    await finishExits();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves the keyboard where a handed-off pick put it during the exit", async () => {
    const { rerender } = render(<Palettes first />);
    await settleOpen();

    deferPaletteFocusRestore((restore) => restore());
    rerender(<Palettes first={false} />);
    // The picked panel mounts and takes focus while the palette fades out.
    target.focus();
    await finishExits();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it("still returns a handed-off pick that moved nothing to the opener", async () => {
    const { rerender } = render(<Palettes first />);
    await settleOpen();

    deferPaletteFocusRestore((restore) => restore());
    rerender(<Palettes first={false} />);
    await finishExits();

    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a pick made in the next palette while the first is still leaving", async () => {
    const { rerender } = render(<Palettes first />);
    await settleOpen();

    // `#` in the Action palette routes to the Panel palette in one commit.
    usePaletteStore.setState({ activePaletteId: "panel" });
    rerender(<Palettes first={false} second />);
    await settleOpen();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Panels input"));

    // A panel picked before the Action palette's exit has finished.
    deferPaletteFocusRestore((restore) => restore());
    usePaletteStore.setState({ activePaletteId: null });
    rerender(<Palettes first={false} second={false} />);
    target.focus();
    await finishExits();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it("takes back a keyboard an incoming palette returned to it as that one unmounted", async () => {
    function Handoff({ first, second }: { first: boolean; second: boolean | "gone" }) {
      return (
        <>
          <AppPaletteDialog isOpen={first} onClose={() => {}} ariaLabel="Actions" tier="command">
            <input type="text" placeholder="Actions input" />
          </AppPaletteDialog>
          {second !== "gone" && (
            <AppPaletteDialog isOpen={second} onClose={() => {}} ariaLabel="Agents" tier="command">
              <input type="text" placeholder="Agents input" />
            </AppPaletteDialog>
          )}
        </>
      );
    }
    const { rerender } = render(<Handoff first second={false} />);
    await settleOpen();

    // An Action palette command opens a palette whose host unmounts it on close.
    rerender(<Handoff first={false} second />);
    await settleOpen();
    // Escape there before the Action palette has finished leaving: it hands
    // the keyboard back to the field it was opened from, which is going too.
    rerender(<Handoff first={false} second="gone" />);
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Actions input"));
    await finishExits();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not carry a suppression into a palette that opened over the close", async () => {
    const { rerender } = render(<Palettes first />);
    await settleOpen();

    suppressPaletteFocusRestore();
    usePaletteStore.setState({ activePaletteId: "panel" });
    rerender(<Palettes first={false} second />);
    await settleOpen();
    usePaletteStore.setState({ activePaletteId: null });
    // Escape in the incoming palette: it restores rather than skipping on the
    // suppression meant for the palette it replaced. Its opener was that
    // palette's field, gone once that exit has rendered, so the app shell
    // takes the keyboard.
    rerender(<Palettes first={false} second={false} />);
    await act(() => vi.advanceTimersByTimeAsync(UI_PALETTE_EXIT_DURATION - 10));
    await finishExits();

    expect(consumePaletteFocusRestoreSuppression()).toBe(false);
    expect(document.activeElement).toBe(fallback);
  });
});
