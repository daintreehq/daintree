// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { usePanelStore } from "@/store/panelStore";
import { primeRadix } from "@/components/ui/radix-loader";
import { isTooltipSuppressedForElement } from "@/lib/tooltipFocusSuppression";
import type { PtyPanelData } from "@shared/types/panel";

// Past the tick Radix hands focus back in after a close.
const AFTER_FOCUS_RESTORE_MS = 20;

const TARGET_PANEL: PtyPanelData = {
  id: "p-1",
  kind: "terminal",
  title: "Claude · notes",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  location: "grid",
  launchAgentId: "claude",
};

const service = vi.hoisted(() => ({
  focusActiveTarget: vi.fn(),
  goToActiveTarget: vi.fn(),
  togglePause: vi.fn(),
  stopActiveSession: vi.fn(),
  stopAndSend: vi.fn(),
  canSendActiveSession: vi.fn(),
  getSessionClock: vi.fn(),
}));

vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: service }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/hooks", () => ({
  useEffectiveCombo: (actionId: string) =>
    actionId === "voiceInput.togglePause"
      ? "Cmd+Shift+P"
      : actionId === "voiceInput.stopAndSend"
        ? "Cmd+Alt+D"
        : "Cmd+.",
  useShortcutHintHover: () => ({
    onPointerEnter: () => {},
    onPointerLeave: () => {},
    onPointerDown: () => {},
    onFocus: () => {},
    onBlur: () => {},
  }),
}));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: [], localSummary: null }),
}));
vi.mock("@/lib/appThemeViewTransition", () => ({ prefersReducedMotion: () => true }));
vi.mock("../ToolbarContextMenuItems", () => ({ ToolbarContextMenuItems: () => null }));
vi.mock("../RecentDictationMenuItems", () => ({ RecentDictationMenuItems: () => null }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  for (const fn of Object.values(service)) fn.mockReset();
  service.canSendActiveSession.mockReturnValue(true);
  service.getSessionClock.mockReturnValue({
    provider: "deepgram",
    elapsedMs: 65_000,
    pausedMs: 0,
    autoStop: { reason: "idle", remainingMs: 120_000 },
  });
  usePanelStore.setState({
    panelsById: {
      ...usePanelStore.getState().panelsById,
      "p-1": TARGET_PANEL,
    },
  });
});

afterEach(() => {
  cleanup();
  useVoiceRecordingStore.setState({
    status: "idle",
    activeTarget: null,
    pendingTarget: null,
    lockedTarget: null,
    panelBuffers: {},
  });
  vi.unstubAllGlobals();
});

function startSession(status: "recording" | "paused" | "finishing" = "recording") {
  useVoiceRecordingStore.setState({
    isConfigured: true,
    status,
    micSignal: "live",
    micDeviceLabel: "Studio Display Microphone",
    sessionElsewhere: null,
    activeTarget: {
      panelId: "p-1",
      panelTitle: "claude · notes",
      projectName: "Daintree",
      worktreeLabel: "main",
    },
    panelBuffers: {},
  });
}

function byTestId(id: string): HTMLButtonElement {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`No button ${id}`);
  return el;
}

function mic(): HTMLButtonElement {
  return byTestId("voice-session-button");
}

function panel(): HTMLElement | null {
  return document.querySelector('[data-testid="voice-session-panel"]');
}

function openPanel() {
  act(() => {
    mic().focus();
  });
  fireEvent.click(mic());
  expect(panel()).not.toBeNull();
}

describe("VoiceRecordingToolbarButton — the session panel (#14920)", () => {
  it("opens the panel on click instead of jumping to the terminal", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);

    openPanel();
    expect(service.focusActiveTarget).not.toHaveBeenCalled();
    expect(service.goToActiveTarget).not.toHaveBeenCalled();
    expect(mic().getAttribute("aria-expanded")).toBe("true");
    // The live panel's title and the session's own details.
    expect(panel()!.textContent).toContain("Claude · notes");
    expect(panel()!.textContent).toContain("Studio Display Microphone");
    expect(panel()!.textContent).toContain("Deepgram");
    expect(panel()!.textContent).toContain("1:05");
  });

  it("goes to the terminal from the top row and keeps the keyboard there", async () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    fireEvent.click(document.querySelector('[data-testid="voice-session-target"]')!);
    expect(service.goToActiveTarget).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
    // Past the tick Radix would hand focus back in: the close claimed it.
    await act(() => new Promise((resolve) => setTimeout(resolve, AFTER_FOCUS_RESTORE_MS)));
    expect(document.activeElement).not.toBe(mic());
  });

  it("pauses from the panel and stays open to show it", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    fireEvent.click(document.querySelector('[data-testid="voice-session-pause"]')!);
    expect(service.togglePause).toHaveBeenCalledTimes(1);
    act(() => {
      useVoiceRecordingStore.setState({ status: "paused" });
    });
    expect(panel()?.getAttribute("data-phase")).toBe("paused");
    expect(document.querySelector('[data-testid="voice-session-pause"]')!.textContent).toContain(
      "Resume"
    );
  });

  it("stops and returns from the panel, leaving the keyboard to the return", async () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    fireEvent.click(byTestId("voice-session-stop"));
    expect(service.stopActiveSession).toHaveBeenCalledTimes(1);
    expect(service.stopAndSend).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, AFTER_FOCUS_RESTORE_MS)));
    expect(document.activeElement).not.toBe(mic());
  });

  it("stops and sends from the panel without going to the terminal", async () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    const send = byTestId("voice-session-send");
    expect(send.textContent).toContain("Stop and send");
    fireEvent.click(send);
    expect(service.stopAndSend).toHaveBeenCalledTimes(1);
    expect(service.goToActiveTarget).not.toHaveBeenCalled();
    expect(service.stopActiveSession).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    // Nothing moved the keyboard elsewhere, so it comes back to the mic.
    await vi.waitFor(() => expect(document.activeElement).toBe(mic()));
  });

  it("says why it can't send when the composer isn't open, and makes stopping the primary", () => {
    service.canSendActiveSession.mockReturnValue(false);
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    const send = byTestId("voice-session-send");
    expect(send.disabled).toBe(true);
    const note = document.querySelector('[data-testid="voice-session-send-note"]');
    expect(note?.id).toBeTruthy();
    expect(send.getAttribute("aria-describedby")).toBe(note?.id);
    expect(byTestId("voice-session-stop").getAttribute("data-variant")).toBe("contrast");
  });

  it("opens with the keyboard on its top row, and Escape hands it back to the mic", async () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("voice-session-target");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(panel()).toBeNull();
    // Radix hands focus back once the content's focus scope has unmounted.
    await vi.waitFor(() => expect(document.activeElement).toBe(mic()));
    expect(service.stopActiveSession).not.toHaveBeenCalled();
  });

  it("re-reads the clock when the session changes state while open", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();
    const elapsed = () =>
      document.querySelector('[data-testid="voice-session-elapsed"]')?.textContent;
    expect(elapsed()).toBe("1:05");

    service.getSessionClock.mockReturnValue({
      provider: "deepgram",
      elapsedMs: 70_000,
      pausedMs: 0,
      autoStop: { reason: "pause", remainingMs: 60_000 },
    });
    act(() => {
      useVoiceRecordingStore.setState({ status: "paused" });
    });
    expect(elapsed()).toBe("1:10");
  });

  it("ticks the clock once a second while open, and stops reading once closed", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      startSession();
      render(<VoiceRecordingToolbarButton />);
      openPanel();
      service.getSessionClock.mockReturnValue({
        provider: "deepgram",
        elapsedMs: 66_000,
        pausedMs: 0,
        autoStop: null,
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(document.querySelector('[data-testid="voice-session-elapsed"]')?.textContent).toBe(
        "1:06"
      );

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      const reads = service.getSessionClock.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(service.getSessionClock.mock.calls.length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { modality: "pointer", ringed: false },
    { modality: "keyboard", ringed: true },
  ])(
    "hands the keyboard to the lock's button when the session ends under it ($modality)",
    async ({ ringed }) => {
      // What the browser's heuristic says of the focused row as the session
      // ends; jsdom has no heuristic of its own.
      const matches = Element.prototype.matches;
      vi.spyOn(Element.prototype, "matches").mockImplementation(function (
        this: Element,
        selector: string
      ) {
        return selector === ":focus-visible" ? ringed : matches.call(this, selector);
      });
      startSession();
      useVoiceRecordingStore.setState({
        lockedTarget: { panelId: "p-1", panelTitle: "claude · notes" },
      });
      render(
        <div role="toolbar">
          <VoiceRecordingToolbarButton />
        </div>
      );
      openPanel();
      expect(panel()!.contains(document.activeElement)).toBe(true);

      act(() => {
        useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
      });
      const locked = document.querySelector('[data-testid="voice-locked-button"]');
      if (!(locked instanceof HTMLButtonElement)) throw new Error("No lock button");
      const focus = vi.spyOn(locked, "focus");
      await vi.waitFor(() => expect(document.activeElement).toBe(locked));
      // A ring only for a keyboard that had one, and no tooltip a pointer didn't ask for.
      expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible: ringed });
      if (!ringed) expect(isTooltipSuppressedForElement(locked)).toBe(true);
    }
  );

  it("leaves the keyboard alone when the session ends somewhere it isn't", async () => {
    startSession();
    useVoiceRecordingStore.setState({
      lockedTarget: { panelId: "p-1", panelTitle: "claude · notes" },
    });
    const view = render(
      <div role="toolbar">
        <VoiceRecordingToolbarButton />
        <input data-testid="elsewhere" />
      </div>
    );
    const elsewhere = view.getByTestId("elsewhere");
    act(() => {
      elsewhere.focus();
    });

    act(() => {
      useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, AFTER_FOCUS_RESTORE_MS)));
    expect(document.activeElement).toBe(elsewhere);
  });

  it("keeps the panel open as the session finishes, with Stop gone quiet", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    act(() => {
      useVoiceRecordingStore.setState({ status: "finishing" });
    });
    expect(panel()?.getAttribute("data-phase")).toBe("finishing");
    expect(byTestId("voice-session-stop").disabled).toBe(true);
  });

  it("starts closed for the next session after one ends with it open", () => {
    startSession();
    const view = render(<VoiceRecordingToolbarButton />);
    openPanel();

    act(() => {
      useVoiceRecordingStore.setState({ status: "idle", activeTarget: null });
    });
    expect(panel()).toBeNull();
    act(() => {
      startSession();
    });
    view.rerender(<VoiceRecordingToolbarButton />);
    expect(panel()).toBeNull();
  });

  it("keeps arming's jump: a click there goes to the target, no panel", () => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "arming",
      micSignal: "pending",
      activeTarget: { panelId: "p-1", panelTitle: "claude · notes" },
    });
    const { container } = render(<VoiceRecordingToolbarButton />);

    fireEvent.click(container.querySelector("button")!);
    expect(service.focusActiveTarget).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });
});
