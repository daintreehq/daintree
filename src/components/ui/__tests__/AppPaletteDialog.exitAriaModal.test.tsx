// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppPaletteDialog } from "../AppPaletteDialog";

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

// Configurable presence mock: lets each test decouple `shouldRender` from
// `isOpen` so we can exercise the exit-animation window (isOpen=false while the
// dialog is still mounted) that the main test file intentionally collapses.
// Keyed off `isOpen` so a single test can mount two palettes with different
// lifecycle states (the real #8948 handoff scenario).
type Presence = { isVisible: boolean; shouldRender: boolean };
let presenceFor: (isOpen: boolean) => Presence = () => ({
  isVisible: false,
  shouldRender: false,
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => presenceFor(isOpen),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function renderPalette(isOpen: boolean, ariaLabel = "Test palette") {
  return render(
    <AppPaletteDialog isOpen={isOpen} onClose={() => {}} ariaLabel={ariaLabel} tier="command">
      <input type="text" placeholder="Palette input" />
    </AppPaletteDialog>
  );
}

describe("AppPaletteDialog aria-modal during exit window", () => {
  afterEach(() => {
    presenceFor = () => ({ isVisible: false, shouldRender: false });
  });

  it("declares aria-modal='true' while open", () => {
    presenceFor = () => ({ isVisible: true, shouldRender: true });
    renderPalette(true);
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("drops aria-modal to 'false' during the exit animation (isOpen=false, still mounted)", () => {
    // The exiting dialog is still rendered (shouldRender=true) but the user has
    // dismissed it (isOpen=false). It must not declare itself the active modal,
    // otherwise it overlaps an incoming palette's aria-modal and traps the AT
    // virtual cursor (issue #8948).
    presenceFor = () => ({ isVisible: false, shouldRender: true });
    renderPalette(false);
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
  });

  it("renders nothing once the exit animation completes", () => {
    presenceFor = () => ({ isVisible: false, shouldRender: false });
    renderPalette(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps exactly one active modal during a palette handoff (#8948)", () => {
    // Both palettes are mounted at once: the outgoing one is mid-exit
    // (isOpen=false, shouldRender=true) while the incoming one is open. Only the
    // incoming dialog may declare aria-modal="true".
    presenceFor = (isOpen) => ({ isVisible: isOpen, shouldRender: true });
    render(
      <>
        <AppPaletteDialog
          isOpen={false}
          onClose={() => {}}
          ariaLabel="Outgoing palette"
          tier="command"
        >
          <input type="text" placeholder="Outgoing input" />
        </AppPaletteDialog>
        <AppPaletteDialog
          isOpen={true}
          onClose={() => {}}
          ariaLabel="Incoming palette"
          tier="command"
        >
          <input type="text" placeholder="Incoming input" />
        </AppPaletteDialog>
      </>
    );

    // Both dialogs are in the DOM during the overlap window.
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    // But only one declares itself the active modal.
    const activeModals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    expect(activeModals).toHaveLength(1);
    expect(activeModals[0]?.getAttribute("aria-label")).toBe("Incoming palette");
  });
});
