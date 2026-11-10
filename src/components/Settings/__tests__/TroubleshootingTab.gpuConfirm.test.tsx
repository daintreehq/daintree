// @vitest-environment jsdom

import { render, cleanup, act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks/useOverlayState", () => ({ useOverlayState: () => {} }));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/clients", () => ({
  appClient: { getState: vi.fn(() => Promise.resolve({})) },
  systemClient: { healthCheck: vi.fn(() => new Promise(() => {})) },
  logsClient: { getLevelOverrides: vi.fn(() => Promise.resolve({})) },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(() => Promise.resolve({ ok: true, result: { verbose: false } })),
  },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { _resetHostPlatformForTests } from "@/hooks/useHostPlatform";

const setHardwareAcceleration = vi.fn(() => Promise.resolve());

function installElectron(hardwareAccelerationDisabled: boolean) {
  setHardwareAcceleration.mockClear();
  Object.assign(window, {
    electron: {
      gpu: {
        getStatus: vi.fn(() =>
          Promise.resolve({ hardwareAccelerationDisabled, angleFallbackActive: false })
        ),
        setHardwareAcceleration,
      },
    },
  });
}

async function renderTab() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  const { TroubleshootingTab } = await import("../TroubleshootingTab");
  await act(async () => {
    render(<TroubleshootingTab />);
  });
}

function gpuRow(): HTMLElement {
  const row = document.getElementById("troubleshooting-gpu-acceleration");
  if (!row) throw new Error("GPU row not rendered");
  return row;
}

function gpuSwitch(): HTMLElement {
  return gpuRow().querySelector("[role='switch']") as HTMLElement;
}

beforeEach(() => {
  _resetHostPlatformForTests();
});

afterEach(() => {
  cleanup();
  _resetHostPlatformForTests();
  vi.unstubAllGlobals();
});

describe("Hardware acceleration toggle confirms before restarting", () => {
  describe.each([
    { name: "on", disabled: false, sends: false, titleWord: "off" },
    { name: "off", disabled: true, sends: true, titleWord: "on" },
  ])("with acceleration currently $name", ({ disabled, sends, titleWord }) => {
    beforeEach(() => installElectron(disabled));

    it("opens the confirm on a switch click and sends nothing", async () => {
      await renderTab();
      await act(async () => {
        fireEvent.click(gpuSwitch());
      });
      expect(
        screen.getByText(`Restart Daintree to turn hardware acceleration ${titleWord}?`)
      ).toBeTruthy();
      expect(screen.getByText(/Terminals close/)).toBeTruthy();
      expect(screen.getByText(/interrupted/)).toBeTruthy();
      expect(setHardwareAcceleration).not.toHaveBeenCalled();
    });

    it("opens the confirm on a row click and sends nothing", async () => {
      await renderTab();
      await act(async () => {
        fireEvent.click(screen.getByText("Hardware acceleration"));
      });
      expect(
        screen.getByText(`Restart Daintree to turn hardware acceleration ${titleWord}?`)
      ).toBeTruthy();
      expect(setHardwareAcceleration).not.toHaveBeenCalled();
    });

    it("leaves the setting alone when cancelled", async () => {
      await renderTab();
      await act(async () => {
        fireEvent.click(gpuSwitch());
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      });
      expect(screen.queryByText(/Restart Daintree to turn hardware acceleration/)).toBeNull();
      expect(setHardwareAcceleration).not.toHaveBeenCalled();
      expect(gpuSwitch().getAttribute("aria-checked")).toBe(String(!disabled));
    });

    it("sends the toggled value once when confirmed", async () => {
      await renderTab();
      await act(async () => {
        fireEvent.click(gpuSwitch());
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Restart Daintree" }));
      });
      expect(setHardwareAcceleration).toHaveBeenCalledTimes(1);
      expect(setHardwareAcceleration).toHaveBeenCalledWith(sends);
      expect(screen.queryByText(/Restart Daintree to turn hardware acceleration/)).toBeNull();
    });
  });
});
