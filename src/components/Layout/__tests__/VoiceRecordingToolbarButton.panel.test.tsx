// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { usePanelStore } from "@/store/panelStore";
import { primeRadix } from "@/components/ui/radix-loader";

const service = vi.hoisted(() => ({
  focusActiveTarget: vi.fn(),
  goToActiveTarget: vi.fn(),
  togglePause: vi.fn(),
  stopActiveSession: vi.fn(),
  getSessionClock: vi.fn(),
}));

vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: service }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/hooks", () => ({
  useEffectiveCombo: (actionId: string) =>
    actionId === "voiceInput.togglePause" ? "Cmd+Shift+P" : "Cmd+.",
  useShortcutHintHover: () => ({}),
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
  service.getSessionClock.mockReturnValue({
    provider: "deepgram",
    elapsedMs: 65_000,
    pausedMs: 0,
    autoStop: { reason: "idle", remainingMs: 120_000 },
  });
  usePanelStore.setState({
    panelsById: {
      ...usePanelStore.getState().panelsById,
      "p-1": {
        id: "p-1",
        kind: "terminal",
        title: "Claude · notes",
        location: "grid",
        launchAgentId: "claude",
      } as never,
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

function mic(): HTMLButtonElement {
  return document.querySelector('[data-testid="voice-session-button"]') as HTMLButtonElement;
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
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).not.toBe(mic());
  });

  it("pauses from the panel and stays open to show it", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    fireEvent.click(document.querySelector('[data-testid="voice-session-pause"]')!);
    expect(service.togglePause).toHaveBeenCalledTimes(1);
    act(() => useVoiceRecordingStore.setState({ status: "paused" }));
    expect(panel()?.getAttribute("data-phase")).toBe("paused");
    expect(document.querySelector('[data-testid="voice-session-pause"]')!.textContent).toContain(
      "Resume"
    );
  });

  it("stops from the panel and closes it", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    fireEvent.click(document.querySelector('[data-testid="voice-session-stop"]')!);
    expect(service.stopActiveSession).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
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
    const reads = service.getSessionClock.mock.calls.length;

    act(() => useVoiceRecordingStore.setState({ status: "paused" }));
    expect(service.getSessionClock.mock.calls.length).toBeGreaterThan(reads);
  });

  it("keeps the panel open as the session finishes, with Stop gone quiet", () => {
    startSession();
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    act(() => useVoiceRecordingStore.setState({ status: "finishing" }));
    expect(panel()?.getAttribute("data-phase")).toBe("finishing");
    expect(
      (document.querySelector('[data-testid="voice-session-stop"]') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("starts closed for the next session after one ends with it open", () => {
    startSession();
    const view = render(<VoiceRecordingToolbarButton />);
    openPanel();

    act(() => useVoiceRecordingStore.setState({ status: "idle", activeTarget: null }));
    expect(panel()).toBeNull();
    act(() => startSession());
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
