// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  PORTAL_DEFAULT_WIDTH,
  PORTAL_MAX_WIDTH,
  PORTAL_MIN_EDITOR_WIDTH,
  PORTAL_MIN_WIDTH,
} from "@shared/types";

const dispatchMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

// Heavy children pull in their own toolbars, links, and IPC plumbing. Stubs
// keep this test focused on the separator behavior.
vi.mock("../PortalToolbar", () => ({
  PortalToolbar: () => null,
}));
vi.mock("../PortalLaunchpad", () => ({
  PortalLaunchpad: () => null,
}));
vi.mock("../PortalTabSkeleton", () => ({
  PortalTabSkeleton: () => null,
}));

import { PortalDock } from "../PortalDock";
import { usePortalStore } from "@/store";

function setViewportWidth(value: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value,
  });
}

function getSeparator(): HTMLElement {
  const el = document.querySelector('[role="separator"]');
  if (!el) throw new Error("Resize separator not found");
  return el as HTMLElement;
}

describe("PortalDock — resize separator", () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });

    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        portal: {
          onNavEvent: vi.fn(() => vi.fn()),
          onNewTabMenuAction: vi.fn(() => vi.fn()),
          onFocus: vi.fn(() => vi.fn()),
          onBlur: vi.fn(() => vi.fn()),
          resize: vi.fn(),
        },
      },
    });

    usePortalStore.getState().reset();
    setViewportWidth(2000);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("viewport-aware width restore", () => {
    it("clamps a persisted width that would crowd the editor below the safe threshold", () => {
      setViewportWidth(1366);
      act(() => {
        usePortalStore.setState({ width: 1100 });
      });

      render(<PortalDock />);

      // safeMax = min(1200, 1366-400) = 966; persisted 1100 > 966 → snap to
      // min(default, safeMax) = min(480, 966) = 480.
      expect(usePortalStore.getState().width).toBe(PORTAL_DEFAULT_WIDTH);
    });

    it("leaves an in-range persisted width untouched on mount", () => {
      setViewportWidth(1366);
      act(() => {
        usePortalStore.setState({ width: 900 });
      });

      render(<PortalDock />);

      // safeMax = 966; persisted 900 ≤ 966 → no write.
      expect(usePortalStore.getState().width).toBe(900);
    });

    it("does not write when window.innerWidth is 0 (Electron pre-show race)", () => {
      setViewportWidth(0);
      act(() => {
        usePortalStore.setState({ width: 1100 });
      });

      render(<PortalDock />);

      expect(usePortalStore.getState().width).toBe(1100);
    });

    it("falls back to safeMax when the viewport is too small to fit the default width", () => {
      setViewportWidth(700);
      act(() => {
        usePortalStore.setState({ width: 900 });
      });

      render(<PortalDock />);

      // safeMax = max(PORTAL_MIN_WIDTH, min(1200, 700-400)) = max(320, 300) =
      // 320; min(default, safeMax) = min(480, 320) = 320.
      expect(usePortalStore.getState().width).toBe(PORTAL_MIN_WIDTH);
    });
  });

  describe("double-click reset", () => {
    it("dispatches portal.resetWidth on double-click", () => {
      act(() => {
        usePortalStore.setState({ width: 800 });
      });

      render(<PortalDock />);
      fireEvent.doubleClick(getSeparator());

      expect(dispatchMock).toHaveBeenCalledWith("portal.resetWidth", undefined, {
        source: "user",
      });
    });

    it("does not start a drag for the second mousedown of a double-click", () => {
      act(() => {
        usePortalStore.setState({ width: 800 });
      });

      render(<PortalDock />);
      const separator = getSeparator();

      // Second mousedown of a dblclick carries detail=2. If the guard fires,
      // the document-level mousemove that follows must not move the width.
      fireEvent.mouseDown(separator, { clientX: 1000, detail: 2 });
      fireEvent.mouseMove(document, { clientX: 800 });

      expect(usePortalStore.getState().width).toBe(800);
    });

    it("still starts a drag for a normal single mousedown (detail=1)", () => {
      act(() => {
        usePortalStore.setState({ width: 800 });
      });

      render(<PortalDock />);
      const separator = getSeparator();

      fireEvent.mouseDown(separator, { clientX: 1000, detail: 1 });
      fireEvent.mouseMove(document, { clientX: 900 });
      fireEvent.mouseUp(document);

      // Dock is right-anchored: dragging left widens (delta = startX - clientX).
      expect(usePortalStore.getState().width).toBe(900);
    });
  });

  describe("keyboard handler", () => {
    beforeEach(() => {
      act(() => {
        usePortalStore.setState({ width: 800 });
      });
    });

    it("ArrowLeft widens by 10 (right-anchored dock)", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowLeft" });
      expect(usePortalStore.getState().width).toBe(810);
    });

    it("ArrowRight narrows by 10", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowRight" });
      expect(usePortalStore.getState().width).toBe(790);
    });

    it("Shift+ArrowLeft widens by the coarse step", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowLeft", shiftKey: true });
      expect(usePortalStore.getState().width).toBe(850);
    });

    it("Shift+ArrowRight narrows by the coarse step", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowRight", shiftKey: true });
      expect(usePortalStore.getState().width).toBe(750);
    });

    it("Home snaps to PORTAL_MIN_WIDTH", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "Home" });
      expect(usePortalStore.getState().width).toBe(PORTAL_MIN_WIDTH);
    });

    it("End snaps to PORTAL_MAX_WIDTH", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "End" });
      expect(usePortalStore.getState().width).toBe(PORTAL_MAX_WIDTH);
    });

    it("clamps a coarse-step widen to PORTAL_MAX_WIDTH", () => {
      act(() => {
        usePortalStore.setState({ width: PORTAL_MAX_WIDTH - 10 });
      });
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowLeft", shiftKey: true });
      expect(usePortalStore.getState().width).toBe(PORTAL_MAX_WIDTH);
    });

    it("clamps a coarse-step narrow to PORTAL_MIN_WIDTH", () => {
      act(() => {
        usePortalStore.setState({ width: PORTAL_MIN_WIDTH + 10 });
      });
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "ArrowRight", shiftKey: true });
      expect(usePortalStore.getState().width).toBe(PORTAL_MIN_WIDTH);
    });

    it("ignores unrelated keys (e.g. Enter)", () => {
      render(<PortalDock />);
      fireEvent.keyDown(getSeparator(), { key: "Enter" });
      expect(usePortalStore.getState().width).toBe(800);
    });
  });

  it("exports a sensible PORTAL_MIN_EDITOR_WIDTH constant", () => {
    // Sanity guard: the clamp math assumes a non-trivial editor reserve.
    expect(PORTAL_MIN_EDITOR_WIDTH).toBeGreaterThanOrEqual(320);
  });
});
