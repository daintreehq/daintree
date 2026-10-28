// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { VoiceSessionPanel, type VoiceSessionDetails } from "../VoiceSessionPanel";

vi.mock("@/lib/appThemeViewTransition", () => ({ prefersReducedMotion: () => true }));
vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: ({ chrome }: { chrome?: { iconId?: string } }) => (
    <span data-testid="target-icon" data-icon={chrome?.iconId ?? "terminal"} />
  ),
}));

function details(overrides: Partial<VoiceSessionDetails> = {}): VoiceSessionDetails {
  return {
    phase: "recording",
    kind: "dictation",
    targetTitle: "claude · notes",
    targetChrome: null,
    hostName: "This Mac",
    projectName: "Daintree",
    worktreeLabel: "main",
    micLabel: "MacBook Pro Microphone",
    micSignal: "live",
    micNotice: null,
    providerName: "OpenAI",
    elapsedMs: 83_000,
    pausedMs: 0,
    autoStop: { reason: "idle", remainingMs: 170_000 },
    correctionEnabled: true,
    locked: false,
    wordCount: 3,
    transcript: "add a test",
    ...overrides,
  };
}

function renderPanel(overrides: Partial<VoiceSessionDetails> = {}, readLevel = () => 0) {
  const handlers = { onGoToTarget: vi.fn(), onTogglePause: vi.fn(), onStop: vi.fn() };
  const view = render(
    <VoiceSessionPanel
      details={details(overrides)}
      readLevel={readLevel}
      pauseShortcut="Cmd+Shift+P"
      stopShortcut="Cmd+."
      {...handlers}
    />
  );
  const text = (id: string) => view.queryByTestId(id)?.textContent ?? null;
  const button = (id: string) => view.getByTestId(id) as HTMLButtonElement;
  return { ...view, handlers, text, button };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VoiceSessionPanel (#14920)", () => {
  it("leads with the target's icon and title, and goes there on click", () => {
    const { getByTestId, handlers } = renderPanel({
      targetChrome: { iconId: "claude" } as VoiceSessionDetails["targetChrome"],
    });
    const target = getByTestId("voice-session-target");
    expect(target.textContent).toContain("claude · notes");
    expect(target.getAttribute("aria-label")).toBe("Go to claude · notes");
    expect(getByTestId("target-icon").getAttribute("data-icon")).toBe("claude");

    fireEvent.click(target);
    expect(handlers.onGoToTarget).toHaveBeenCalledTimes(1);
  });

  it("shows everything known about the session", () => {
    const { container } = renderPanel();
    const rows = Object.fromEntries(
      Array.from(container.querySelectorAll("dt")).map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent,
      ])
    );
    expect(rows).toEqual({
      Host: "This Mac",
      Project: "Daintree",
      Worktree: "main",
      Microphone: "MacBook Pro Microphone",
      Audio: "Delivering audio",
      Transcription: "OpenAI",
      Type: "Dictation",
      "AI correction": "On",
      Target: "Not locked",
      "Auto-stop": "In 2:50 without new words",
    });
  });

  it.each([
    { phase: "arming" as const, micSignal: "pending" as const, state: "Arming" },
    { phase: "connecting" as const, micSignal: "pending" as const, state: "Starting microphone" },
    { phase: "connecting" as const, micSignal: "live" as const, state: "Listening · connecting" },
    { phase: "recording" as const, micSignal: "live" as const, state: "Listening" },
    { phase: "recording" as const, micSignal: "silent" as const, state: "No audio" },
    { phase: "paused" as const, micSignal: "live" as const, state: "Paused" },
    { phase: "reconnecting" as const, micSignal: "live" as const, state: "Reconnecting" },
    { phase: "finishing" as const, micSignal: "live" as const, state: "Finishing transcription" },
  ])("names the $phase state (mic $micSignal)", ({ phase, micSignal, state }) => {
    const { text } = renderPanel({ phase, micSignal });
    expect(text("voice-session-state")).toBe(state);
  });

  it.each([
    { phase: "recording" as const, pause: "Pause", canPause: true, canStop: true },
    { phase: "paused" as const, pause: "Resume", canPause: true, canStop: true },
    { phase: "connecting" as const, pause: "Pause", canPause: false, canStop: true },
    { phase: "reconnecting" as const, pause: "Pause", canPause: false, canStop: true },
    { phase: "finishing" as const, pause: "Pause", canPause: false, canStop: false },
  ])("offers pause and stop where they apply ($phase)", ({ phase, pause, canPause, canStop }) => {
    const { button, handlers } = renderPanel({ phase });
    const pauseButton = button("voice-session-pause");
    const stopButton = button("voice-session-stop");
    expect(pauseButton.textContent).toContain(pause);
    expect(pauseButton.disabled).toBe(!canPause);
    expect(stopButton.disabled).toBe(!canStop);

    fireEvent.click(pauseButton);
    fireEvent.click(stopButton);
    expect(handlers.onTogglePause).toHaveBeenCalledTimes(canPause ? 1 : 0);
    expect(handlers.onStop).toHaveBeenCalledTimes(canStop ? 1 : 0);
  });

  it("puts each control's shortcut beside it", () => {
    const { button } = renderPanel();
    expect(button("voice-session-pause").querySelector("kbd")).not.toBeNull();
    expect(button("voice-session-stop").querySelector("kbd")).not.toBeNull();
  });

  it("counts wall time through a pause and says how long it was paused", () => {
    const { text } = renderPanel({
      phase: "paused",
      elapsedMs: 95_000,
      pausedMs: 12_000,
      autoStop: { reason: "pause", remainingMs: 48_000 },
    });
    expect(text("voice-session-elapsed")).toBe("1:35 · 0:12 paused");
    expect(text("voice-session-auto-stop")).toBe("In 0:48 unless resumed");
  });

  it("drops the clock and the auto-stop once the session is stopping", () => {
    const { text } = renderPanel({ phase: "finishing", elapsedMs: null, autoStop: null });
    expect(text("voice-session-elapsed")).toBeNull();
    expect(text("voice-session-auto-stop")).toBeNull();
  });

  it.each([
    { micSignal: "pending" as const, micNotice: null, audio: "Waiting for audio" },
    {
      micSignal: "silent" as const,
      micNotice: { kind: "silent" as const, bluetooth: true },
      audio: "No audio · Bluetooth",
    },
    {
      micSignal: "live" as const,
      micNotice: { kind: "fallback" as const, bluetooth: false },
      audio: "Delivering audio · fallback",
    },
    {
      micSignal: "live" as const,
      micNotice: { kind: "lost" as const, bluetooth: false },
      audio: "Disconnected",
    },
  ])("says whether the mic delivers audio ($audio)", ({ micSignal, micNotice, audio }) => {
    const { text } = renderPanel({ micSignal, micNotice });
    expect(text("voice-session-mic")).toBe(audio);
  });

  it.each([
    { kind: "rewrite" as const, label: "Rewrite instruction" },
    { kind: "canopy-reply" as const, label: "Canopy reply" },
  ])("names a $kind session", ({ kind, label }) => {
    const { container } = renderPanel({ kind });
    expect(container.textContent).toContain(label);
  });

  it("names a locked target and correction that is off", () => {
    const { container } = renderPanel({ locked: true, correctionEnabled: false });
    expect(container.textContent).toContain("Locked");
    expect(container.textContent).toContain("Off");
  });

  it("shows the words so far, the newest end of a long transcript", () => {
    const long = `${"word ".repeat(60)}the newest words`;
    const { text } = renderPanel({ wordCount: 63, transcript: long });
    expect(text("voice-session-words")).toBe("63 words");
    const shown = text("voice-session-transcript")!;
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("the newest words")).toBe(true);
  });

  it("says when nothing has been heard yet", () => {
    const { text } = renderPanel({ wordCount: 0, transcript: "" });
    expect(text("voice-session-words")).toBe("0 words");
    expect(text("voice-session-transcript")).toBeNull();
  });

  it("moves the level meter from frames, without a React commit per frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    let level = 0;
    let commits = 0;
    const view = render(
      <Profiler id="panel" onRender={() => commits++}>
        <VoiceSessionPanel
          details={details()}
          readLevel={() => level}
          onGoToTarget={() => {}}
          onTogglePause={() => {}}
          onStop={() => {}}
        />
      </Profiler>
    );
    const fill = view.getByTestId("voice-session-level").firstElementChild as HTMLElement;
    const before = commits;
    const step = (t: number) => act(() => frames.shift()?.(t));

    step(performance.now() + 16);
    expect(fill.style.transform).toBe("scaleX(0.000)");
    level = 0.8;
    step(performance.now() + 32);
    expect(parseFloat(fill.style.transform.slice(7))).toBeGreaterThan(0.5);
    expect(commits).toBe(before);
  });

  it("holds the meter empty while nothing is listening", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { getByTestId } = renderPanel({ phase: "paused" }, () => 0.9);
    const fill = getByTestId("voice-session-level").firstElementChild as HTMLElement;
    expect(fill.style.transform).toBe("scaleX(0)");
    expect(raf).not.toHaveBeenCalled();
  });
});
