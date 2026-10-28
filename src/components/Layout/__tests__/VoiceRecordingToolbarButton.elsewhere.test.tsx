// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { primeRadix } from "@/components/ui/radix-loader";
import { elsewherePanelDetails } from "../ElsewhereVoiceSessionPanel";
import type { VoiceSessionElsewhere, VoiceSessionSnapshot } from "@shared/types";

const service = vi.hoisted(() => ({
  focusActiveTarget: vi.fn(),
  goToActiveTarget: vi.fn(),
  togglePause: vi.fn(),
  stopActiveSession: vi.fn(),
  getSessionClock: vi.fn(),
  revealSessionElsewhere: vi.fn(),
  setSessionElsewherePaused: vi.fn(),
  stopSessionElsewhereById: vi.fn(),
}));

vi.mock("@/services/VoiceRecordingService", () => ({ voiceRecordingService: service }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/hooks", () => ({
  useEffectiveCombo: (actionId: string) =>
    actionId === "voiceInput.togglePause" ? "Cmd+Shift+P" : "Cmd+.",
  useShortcutHintHover: () => ({ onFocus: () => {}, onBlur: () => {} }),
}));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({
    hosts: [
      { descriptor: { id: "studio-01", name: "Studio" } },
      { descriptor: { id: "studio-02", name: "Annex" } },
    ],
    localSummary: null,
  }),
}));
vi.mock("@/lib/appThemeViewTransition", () => ({ prefersReducedMotion: () => true }));
vi.mock("../ToolbarContextMenuItems", () => ({ ToolbarContextMenuItems: () => null }));
vi.mock("../RecentDictationMenuItems", () => ({ RecentDictationMenuItems: () => null }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const NOW = 1_000_000;
const originalPlatform = navigator.platform;

function snapshot(overrides: Partial<VoiceSessionSnapshot> = {}): VoiceSessionSnapshot {
  return {
    phase: "recording",
    kind: "dictation",
    targetTitle: "Claude · notes",
    targetChrome: {
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      processId: null,
      runtimeKind: "agent",
      hasExited: false,
    },
    targetHostId: null,
    projectName: "Alpha",
    worktreeLabel: "feature/voice",
    micLabel: "Studio Display Microphone",
    micSignal: "live",
    micNotice: null,
    stopWarning: false,
    correctionEnabled: true,
    locked: false,
    wordCount: 4,
    transcript: "fix the flaky test",
    provider: "deepgram",
    clock: { at: NOW, elapsedMs: 65_000, pausedMs: 0, paused: false, autoStop: null },
    ...overrides,
  };
}

// Each pairing the issue names: where the session runs, and the host of the
// view looking at it (null for this Mac).
const pairings = [
  {
    name: "on this Mac, seen from a host's view",
    hostId: "local",
    viewHost: "studio-01",
    hostName: "This Mac",
  },
  {
    name: "on a host, seen from this Mac",
    hostId: "studio-01",
    viewHost: null,
    hostName: "Studio",
  },
  {
    name: "on one host, seen from another",
    hostId: "studio-01",
    viewHost: "studio-02",
    hostName: "Studio",
  },
  {
    name: "in another project on the same host",
    hostId: "studio-01",
    viewHost: "studio-01",
    hostName: "Studio",
  },
];

function showElsewhere(
  pairing: (typeof pairings)[number],
  details: VoiceSessionSnapshot | null = snapshot({ targetHostId: pairing.hostId }),
  sessionId = "s1"
) {
  if (pairing.viewHost) Reflect.set(window, "__DAINTREE_HOST_ID__", { id: pairing.viewHost });
  const session: VoiceSessionElsewhere = {
    sessionId,
    hostId: pairing.hostId,
    projectId: "p-a",
    projectName: "Alpha",
    details,
  };
  act(() => {
    useVoiceRecordingStore.setState({ sessionElsewhere: session });
  });
}

function mic(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="voice-elsewhere-button"]'
  );
  if (!button) throw new Error("no elsewhere mic");
  return button;
}
const panel = () => document.querySelector<HTMLElement>('[data-testid="voice-session-panel"]');
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function openPanel() {
  act(() => {
    mic().focus();
  });
  fireEvent.click(mic());
  expect(panel()).not.toBeNull();
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  for (const fn of Object.values(service)) fn.mockReset();
  useVoiceRecordingStore.setState({
    isConfigured: true,
    status: "idle",
    activeTarget: null,
    pendingTarget: null,
    lockedTarget: null,
    sessionElsewhere: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
  useVoiceRecordingStore.setState({ sessionElsewhere: null });
});

describe("VoiceRecordingToolbarButton — the session panel in a view that doesn't own it (#14921)", () => {
  describe.each(pairings)("a session $name", (pairing) => {
    it("opens the owner's panel on click, with the host, project, pane, mic, clock and state", () => {
      showElsewhere(pairing);
      render(<VoiceRecordingToolbarButton />);

      openPanel();

      expect(service.revealSessionElsewhere).not.toHaveBeenCalled();
      expect(mic().getAttribute("aria-expanded")).toBe("true");
      const text = panel()!.textContent ?? "";
      expect(text).toContain(pairing.hostName);
      expect(text).toContain("Alpha");
      expect(text).toContain("feature/voice");
      expect(byTestId("voice-session-target")!.textContent).toContain("Claude · notes");
      expect(text).toContain("Studio Display Microphone");
      expect(text).toContain("Deepgram");
      expect(byTestId("voice-session-elapsed")!.textContent).toContain("1:05");
      expect(panel()!.getAttribute("data-phase")).toBe("recording");
    });

    it("pauses, resumes and stops the owner's session by its id", () => {
      showElsewhere(pairing);
      render(<VoiceRecordingToolbarButton />);
      openPanel();

      fireEvent.click(byTestId("voice-session-pause")!);
      expect(service.setSessionElsewherePaused).toHaveBeenCalledWith("s1", true);
      expect(service.togglePause).not.toHaveBeenCalled();

      // The owner's report of the pause comes back through main.
      showElsewhere(pairing, snapshot({ targetHostId: pairing.hostId, phase: "paused" }));
      expect(panel()?.getAttribute("data-phase")).toBe("paused");
      fireEvent.click(byTestId("voice-session-pause")!);
      expect(service.setSessionElsewherePaused).toHaveBeenLastCalledWith("s1", false);

      // It stops the session where it runs, and takes the person nowhere.
      expect(byTestId("voice-session-stop")!.textContent).toContain("Stop");
      expect(byTestId("voice-session-stop")!.textContent).not.toContain("return");
      fireEvent.click(byTestId("voice-session-stop")!);
      expect(service.stopSessionElsewhereById).toHaveBeenCalledWith("s1");
      expect(service.stopActiveSession).not.toHaveBeenCalled();
      expect(panel()).toBeNull();
    });

    it("goes to the session's host, project and pane from the top row", () => {
      showElsewhere(pairing);
      render(<VoiceRecordingToolbarButton />);
      openPanel();

      fireEvent.click(byTestId("voice-session-target")!);

      expect(service.revealSessionElsewhere).toHaveBeenCalledWith("s1");
      expect(service.goToActiveTarget).not.toHaveBeenCalled();
      expect(panel()).toBeNull();
    });
  });

  it("runs the owner's clock on between reports", () => {
    showElsewhere(pairings[0]!);
    render(<VoiceRecordingToolbarButton />);
    openPanel();
    expect(byTestId("voice-session-elapsed")!.textContent).toContain("1:05");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(byTestId("voice-session-elapsed")!.textContent).toContain("1:15");
    expect(byTestId("voice-session-elapsed")!.textContent).not.toContain("paused");
  });

  it("holds paused time while recording, and grows it while paused", () => {
    const paused = (isPaused: boolean) =>
      snapshot({
        phase: isPaused ? "paused" : "recording",
        clock: { at: NOW, elapsedMs: 30_000, pausedMs: 5_000, paused: isPaused, autoStop: null },
      });
    showElsewhere(pairings[1]!, paused(false));
    const view = render(<VoiceRecordingToolbarButton />);
    openPanel();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(byTestId("voice-session-elapsed")!.textContent).toBe("0:40");
    expect(byTestId("voice-session-detail")?.textContent ?? "").not.toContain("Paused");

    showElsewhere(pairings[1]!, paused(true));
    view.rerender(<VoiceRecordingToolbarButton />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // Ten seconds on from the reading, since it was made at NOW.
    expect(byTestId("voice-session-elapsed")!.textContent).toBe("0:50");
    expect(byTestId("voice-session-detail")!.textContent).toContain("Paused 0:25");
  });

  it("holds paused time still while the owner records", () => {
    const session: VoiceSessionElsewhere = {
      sessionId: "s1",
      hostId: "studio-01",
      projectId: "p-a",
      projectName: "Alpha",
      details: null,
    };
    const at = (isPaused: boolean) =>
      elsewherePanelDetails(
        session,
        snapshot({
          phase: isPaused ? "paused" : "recording",
          clock: { at: NOW, elapsedMs: 30_000, pausedMs: 5_000, paused: isPaused, autoStop: null },
        }),
        [],
        NOW + 10_000
      );

    expect(at(false)).toMatchObject({ elapsedMs: 40_000, pausedMs: 5_000 });
    expect(at(true)).toMatchObject({ elapsedMs: 40_000, pausedMs: 15_000 });
  });

  it("names the host a reply's words go to, and no project where the owner shows none", () => {
    showElsewhere(
      pairings[1]!,
      snapshot({ kind: "canopy-reply", targetHostId: "studio-02", projectName: null })
    );
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    // The owning workspace is Alpha, but the owner's panel names no project for a reply.
    expect(byTestId("voice-session-place")!.textContent).toBe("Annex · feature/voice");
  });

  it("names no provider once the owner's panel names none", () => {
    showElsewhere(pairings[1]!, snapshot({ phase: "finishing", clock: null, provider: null }));
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    expect(panel()!.textContent).not.toContain("Deepgram");
  });

  it("counts an auto-stop down from the owner's reading", () => {
    showElsewhere(
      pairings[1]!,
      snapshot({
        phase: "paused",
        clock: {
          at: NOW,
          elapsedMs: 30_000,
          pausedMs: 5_000,
          paused: true,
          autoStop: { reason: "pause", remainingMs: 50_000 },
        },
      })
    );
    render(<VoiceRecordingToolbarButton />);
    openPanel();
    expect(byTestId("voice-session-detail")!.textContent).toContain("Stops in 0:50 unless resumed");

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(byTestId("voice-session-detail")!.textContent).toContain("Stops in 0:30 unless resumed");

    // A countdown that has run out reads zero, never below it.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(byTestId("voice-session-detail")!.textContent).toContain("Stops in 0:00 unless resumed");
  });

  it("offers no pause while the owner's session is finishing", () => {
    showElsewhere(pairings[1]!, snapshot({ phase: "finishing", clock: null }));
    render(<VoiceRecordingToolbarButton />);
    openPanel();

    const pause = document.querySelector<HTMLButtonElement>('[data-testid="voice-session-pause"]');
    expect(pause).not.toBeNull();
    expect(pause!.disabled).toBe(true);
    fireEvent.click(pause!);
    expect(service.setSessionElsewherePaused).not.toHaveBeenCalled();
  });

  it("starts closed for the next session after one ends with it open", () => {
    showElsewhere(pairings[1]!);
    const view = render(<VoiceRecordingToolbarButton />);
    openPanel();

    showElsewhere(pairings[1]!, snapshot(), "s2");
    view.rerender(<VoiceRecordingToolbarButton />);

    expect(panel()).toBeNull();
    expect(mic()).not.toBeNull();
  });

  it("keeps the click going there until the owner's first report lands", () => {
    showElsewhere(pairings[1]!, null);
    render(<VoiceRecordingToolbarButton />);

    fireEvent.click(mic());

    expect(panel()).toBeNull();
    expect(service.revealSessionElsewhere).toHaveBeenCalledWith("s1");
  });

  it("keeps the right-click menu before the owner's first report lands", () => {
    showElsewhere(pairings[1]!, null);
    render(<VoiceRecordingToolbarButton />);

    fireEvent.contextMenu(mic());

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});
