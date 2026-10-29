// @vitest-environment jsdom
import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import { useVoiceRecordingStore, type VoiceMicNotice } from "@/store/voiceRecordingStore";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  switchToMicFromNotice: vi.fn<(notice: unknown) => Promise<void>>(),
  restartReplacedApp: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: mocks.dispatch } }));

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { switchToMicFromNotice: mocks.switchToMicFromNotice },
}));

const { VoiceMicNoticeBanner } = await import("../VoiceMicNoticeBanner");

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const TARGET = { panelId: "panel-1", panelTitle: "Claude" };
const BUILT_IN = { deviceId: "builtin", label: "MacBook Pro Microphone" };

function renderNotice(notice: VoiceMicNotice) {
  useVoiceRecordingStore.setState({ micNotice: notice });
  return render(
    <WindowControlsInsetProvider>
      <VoiceMicNoticeBanner notice={notice} />
    </WindowControlsInsetProvider>
  );
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("VoiceMicNoticeBanner", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
    mocks.switchToMicFromNotice.mockReset().mockResolvedValue(undefined);
    mocks.restartReplacedApp.mockReset().mockResolvedValue(true);
    Object.defineProperty(window, "electron", {
      value: { voiceInput: { restartReplacedApp: mocks.restartReplacedApp } },
      writable: true,
      configurable: true,
    });
    useVoiceRecordingStore.setState({ micNotice: null });
  });

  it("names the mic that was lost", () => {
    renderNotice({ kind: "lost", target: TARGET, deviceLabel: "Greg's AirPods Pro" });

    expect(text()).toContain("Microphone lost");
    expect(text()).toContain("Greg's AirPods Pro disconnected, so dictation stopped");
    expect(screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Dismiss microphone notice",
    ]);
  });

  it("falls back to generic wording without a device name", () => {
    renderNotice({ kind: "lost", target: TARGET, deviceLabel: null });

    expect(text()).toContain("The microphone disconnected, so dictation stopped");
  });

  it("offers the built-in mic for a silent Bluetooth one", async () => {
    const notice: VoiceMicNotice = {
      kind: "silent",
      target: TARGET,
      deviceLabel: "Greg's AirPods Pro",
      bluetooth: true,
      builtIn: BUILT_IN,
    };
    renderNotice(notice);

    expect(text()).toContain("No audio from Greg's AirPods Pro");
    expect(text()).toContain("Bluetooth mics can go quiet while they switch to call mode");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use MacBook Pro Microphone" }));
    });

    expect(mocks.switchToMicFromNotice).toHaveBeenCalledWith(notice);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["a Bluetooth mic with no built-in one found", true],
    ["a wired mic", false],
  ])("sends %s to Voice settings", (_case, bluetooth) => {
    renderNotice({
      kind: "silent",
      target: TARGET,
      deviceLabel: "Blue Yeti",
      bluetooth,
      builtIn: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Voice settings" }));

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "voice" },
      { source: "user" }
    );
    expect(mocks.switchToMicFromNotice).not.toHaveBeenCalled();
  });

  describe("after Daintree was updated under it (#14937)", () => {
    const REPLACED: VoiceMicNotice = {
      kind: "silent",
      target: TARGET,
      deviceLabel: "RØDE NT-USB Mini",
      bluetooth: false,
      builtIn: null,
      appReplaced: true,
    };

    // The dialog portals out of the render container; the banner's button stays in it.
    function bannerRestart(container: HTMLElement): HTMLButtonElement {
      return within(container).getByRole("button", { name: "Restart Daintree" });
    }

    async function confirmRestart(container: HTMLElement) {
      fireEvent.click(bannerRestart(container));
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.textContent).toContain("Restart Daintree now?");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Restart Daintree" }));
      });
    }

    it("says a restart is needed rather than blaming the mic", () => {
      renderNotice(REPLACED);

      expect(text()).toContain("No audio from RØDE NT-USB Mini");
      expect(text()).toContain("Daintree was updated while running and needs a restart");
      expect(text()).not.toContain("Check that it's connected");
      expect(screen.queryByRole("button", { name: "Open Voice settings" })).toBeNull();
    });

    it("restarts only once the restart is confirmed", async () => {
      const { container } = renderNotice(REPLACED);
      fireEvent.click(bannerRestart(container));
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(mocks.restartReplacedApp).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

      await confirmRestart(container);

      expect(mocks.restartReplacedApp).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch).not.toHaveBeenCalled();
    });

    it.each([
      ["refuses it", () => mocks.restartReplacedApp.mockResolvedValue(false)],
      ["fails", () => mocks.restartReplacedApp.mockRejectedValue(new Error("ipc down"))],
    ])("says how to restart by hand when main %s", async (_case, arrange) => {
      arrange();
      const { container } = renderNotice(REPLACED);

      await confirmRestart(container);

      expect(text()).toContain("Couldn't restart from here. Quit and reopen Daintree");
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(bannerRestart(container).disabled).toBe(false);
    });
  });

  it.each<VoiceMicNotice>([
    { kind: "lost", target: TARGET, deviceLabel: null },
    { kind: "silent", target: TARGET, deviceLabel: null, bluetooth: false, builtIn: null },
  ])("leaves the $kind announcement to the service's live region", (notice) => {
    const { container } = renderNotice(notice);
    const root = container.querySelector('[role="status"]');

    expect(root).not.toBeNull();
    expect(root?.getAttribute("aria-live")).toBe("off");
  });

  it("dismisses its own notice and leaves a newer one alone", () => {
    const stale: VoiceMicNotice = { kind: "lost", target: TARGET, deviceLabel: null };
    renderNotice(stale);
    const newer: VoiceMicNotice = { kind: "lost", target: TARGET, deviceLabel: "USB Mic" };
    useVoiceRecordingStore.setState({ micNotice: newer });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss microphone notice" }));
    expect(useVoiceRecordingStore.getState().micNotice).toBe(newer);

    useVoiceRecordingStore.setState({ micNotice: stale });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss microphone notice" }));
    expect(useVoiceRecordingStore.getState().micNotice).toBeNull();
  });
});
