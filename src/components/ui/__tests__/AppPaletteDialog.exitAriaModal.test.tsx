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
let presence = { isVisible: false, shouldRender: false };
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: () => presence,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function renderPalette(isOpen: boolean) {
  return render(
    <AppPaletteDialog isOpen={isOpen} onClose={() => {}} ariaLabel="Test palette">
      <input type="text" placeholder="Palette input" />
    </AppPaletteDialog>
  );
}

describe("AppPaletteDialog aria-modal during exit window", () => {
  afterEach(() => {
    presence = { isVisible: false, shouldRender: false };
  });

  it("declares aria-modal='true' while open", () => {
    presence = { isVisible: true, shouldRender: true };
    renderPalette(true);
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("drops aria-modal to 'false' during the exit animation (isOpen=false, still mounted)", () => {
    // The exiting dialog is still rendered (shouldRender=true) but the user has
    // dismissed it (isOpen=false). It must not declare itself the active modal,
    // otherwise it overlaps an incoming palette's aria-modal and traps the AT
    // virtual cursor (issue #8948).
    presence = { isVisible: false, shouldRender: true };
    renderPalette(false);
    const dialog = screen.getByRole("dialog", { name: "Test palette" });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
  });

  it("renders nothing once the exit animation completes", () => {
    presence = { isVisible: false, shouldRender: false };
    renderPalette(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
