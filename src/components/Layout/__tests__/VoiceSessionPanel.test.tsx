// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { VoiceSessionPanel, type VoiceSessionDetails } from "../VoiceSessionPanel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

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
  const button = (id: string) => {
    const el = view.getByTestId(id);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`No button ${id}`);
    return el;
  };
  return { ...view, handlers, text, button };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VoiceSessionPanel (#14920)", () => {
  it("leads with the target's icon and title, and goes there on click", () => {
    const chrome = deriveTerminalChrome({ kind: "terminal", launchAgentId: "claude" });
    const { getByTestId, handlers } = renderPanel({ targetChrome: chrome });
    const target = getByTestId("voice-session-target");
    expect(target.textContent).toContain("claude · notes");
    expect(target.getAttribute("aria-label")).toBe("Go to claude · notes");
    expect(getByTestId("target-icon").getAttribute("data-icon")).toBe(chrome.iconId);
    expect(chrome.iconId).not.toBe("terminal");

    fireEvent.click(target);
    expect(handlers.onGoToTarget).toHaveBeenCalledTimes(1);
  });

  it("shows everything known about the session", () => {
    const { container, text, getByTestId } = renderPanel();
    // Where the words go reads under the title, inside the row that goes there.
    const place = getByTestId("voice-session-place");
    expect(place.textContent).toBe("This Mac · Daintree · main");
    expect(getByTestId("voice-session-target").getAttribute("aria-describedby")).toBe(place.id);
    expect(text("voice-session-detail")).toBe("Stops in 2:50 without new words");
    const rows = Object.fromEntries(
      Array.from(container.querySelectorAll("dt")).map((dt) => [
        dt.textContent,
        dt.nextElementSibling?.textContent,
      ])
    );
    expect(rows).toEqual({
      Microphone: "MacBook Pro Microphone",
      Audio: "Delivering audio",
      Transcription: "OpenAI",
      Type: "Dictation",
      "AI correction": "On",
      "Target lock": "Off",
    });
  });

  it.each([
    { phase: "arming" as const, micSignal: "pending" as const, state: "Arming" },
    { phase: "connecting" as const, micSignal: "pending" as const, state: "Starting microphone" },
    { phase: "connecting" as const, micSignal: "live" as const, state: "Listening" },
    { phase: "recording" as const, micSignal: "live" as const, state: "Listening" },
    { phase: "recording" as const, micSignal: "silent" as const, state: "No audio" },
    { phase: "paused" as const, micSignal: "live" as const, state: "Paused" },
    { phase: "reconnecting" as const, micSignal: "live" as const, state: "Reconnecting to OpenAI" },
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

  it("puts each control's own shortcut beside it", () => {
    const { button } = renderPanel();
    const keys = (id: string) =>
      Array.from(button(id).querySelectorAll("kbd"))
        .map((kbd) => kbd.textContent)
        .join("");
    expect(keys("voice-session-pause")).toMatch(/P$/);
    expect(keys("voice-session-stop")).toMatch(/\.$/);
  });

  it("leaves a control's shortcut out when none is bound", () => {
    const view = render(
      <VoiceSessionPanel
        details={details()}
        readLevel={() => 0}
        onGoToTarget={() => {}}
        onTogglePause={() => {}}
        onStop={() => {}}
      />
    );
    expect(view.container.querySelector("kbd")).toBeNull();
  });

  it("counts wall time through a pause and says how long it was paused", () => {
    const { text } = renderPanel({
      phase: "paused",
      elapsedMs: 95_000,
      pausedMs: 12_000,
      autoStop: { reason: "pause", remainingMs: 48_000 },
    });
    expect(text("voice-session-elapsed")).toBe("1:35");
    expect(text("voice-session-detail")).toBe("Paused 0:12 · Stops in 0:48 unless resumed");
  });

  it("drops the clock and the auto-stop once the session is stopping", () => {
    const { text } = renderPanel({ phase: "finishing", elapsedMs: null, autoStop: null });
    expect(text("voice-session-elapsed")).toBeNull();
    expect(text("voice-session-detail")).toBeNull();
  });

  it("keeps the countdown beside a mic problem, and steps it up in its last seconds", () => {
    const { text, getByTestId } = renderPanel({
      micSignal: "silent",
      micLabel: "AirPods",
      micNotice: { kind: "silent", bluetooth: false },
      autoStop: { reason: "idle", remainingMs: 8_000 },
    });
    expect(text("voice-session-state")).toBe("No audio");
    expect(text("voice-session-problem")).toBe(
      "Nothing heard from AirPods. Check the selected microphone."
    );
    expect(text("voice-session-detail")).toBe("Stops in 0:08 without new words");
    expect(getByTestId("voice-session-detail").className).toContain("text-text-primary");
  });

  it("says the mic is paused or stopped rather than what it last delivered", () => {
    expect(renderPanel({ phase: "paused" }).text("voice-session-mic")).toBe("Paused");
    cleanup();
    expect(renderPanel({ phase: "finishing" }).text("voice-session-mic")).toBe("Stopped");
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
    const value = (label: string) =>
      Array.from(container.querySelectorAll("dt")).find((dt) => dt.textContent === label)
        ?.nextElementSibling?.textContent;
    expect(value("Target lock")).toBe("On");
    expect(value("AI correction")).toBe("Off");
  });

  describe("stop and send", () => {
    function renderWithSend(overrides: Partial<VoiceSessionDetails>, canSend: boolean) {
      const onSend = vi.fn();
      const view = render(
        <VoiceSessionPanel
          details={details(overrides)}
          readLevel={() => 0}
          onGoToTarget={() => {}}
          onTogglePause={() => {}}
          onStop={() => {}}
          onSend={onSend}
          canSend={canSend}
          sendShortcut="Cmd+Alt+D"
        />
      );
      const stop = view.getByTestId("voice-session-stop");
      return { ...view, onSend, send: view.queryByTestId("voice-session-send"), stop };
    }

    it("leads the actions as the primary, with its shortcut", () => {
      const { send, stop, onSend } = renderWithSend({}, true);
      if (!(send instanceof HTMLButtonElement)) throw new Error("No send button");
      expect(send.getAttribute("data-variant")).toBe("contrast");
      expect(stop.getAttribute("data-variant")).toBe("ghost");
      expect(send.querySelector("kbd")).not.toBeNull();
      fireEvent.click(send);
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    it("says why when it can't send, and hands the primary to stopping", () => {
      const { send, stop, getByTestId } = renderWithSend({}, false);
      if (!(send instanceof HTMLButtonElement)) throw new Error("No send button");
      expect(send.disabled).toBe(true);
      expect(send.getAttribute("aria-describedby")).toBe(getByTestId("voice-session-send-note").id);
      expect(stop.getAttribute("data-variant")).toBe("contrast");
    });

    it("is not offered for a rewrite instruction, which has nothing to send", () => {
      const { send, stop } = renderWithSend({ kind: "rewrite" }, true);
      expect(send).toBeNull();
      expect(stop.getAttribute("data-variant")).toBe("contrast");
    });

    it("is not offered by a view that can't send", () => {
      const { queryByTestId, getByTestId } = renderPanel();
      expect(queryByTestId("voice-session-send")).toBeNull();
      expect(getByTestId("voice-session-stop").getAttribute("data-variant")).toBe("contrast");
    });
  });

  it("hands the keyboard to the top row when its control is disabled under it", () => {
    const props = {
      readLevel: () => 0,
      onGoToTarget: () => {},
      onTogglePause: () => {},
      onStop: () => {},
    };
    const view = render(<VoiceSessionPanel details={details()} {...props} />);
    const pause = view.getByTestId("voice-session-pause");
    act(() => {
      pause.focus();
    });
    view.rerender(<VoiceSessionPanel details={details({ phase: "reconnecting" })} {...props} />);
    expect(document.activeElement).toBe(view.getByTestId("voice-session-target"));
  });

  it("shows the words so far, the newest end of a long transcript", () => {
    const long = `the oldest words ${"word ".repeat(60)}the newest words`;
    const { text } = renderPanel({ wordCount: 66, transcript: long });
    expect(text("voice-session-words")).toBe("66 words");
    const shown = text("voice-session-transcript") ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("the newest words")).toBe(true);
    expect(shown).not.toContain("oldest");
    expect(shown.length).toBeLessThan(long.length);
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
    const lit = () =>
      view.getByTestId("voice-session-level").querySelectorAll('[data-lit="true"]').length;
    const before = commits;
    const step = (t: number) => act(() => frames.shift()?.(t));

    step(performance.now() + 16);
    expect(lit()).toBe(0);
    level = 0.8;
    step(performance.now() + 32);
    expect(lit()).toBeGreaterThan(5);
    expect(commits).toBe(before);
  });

  it.each(["paused", "finishing"] as const)(
    "draws no meter while %s, rather than one reading zero",
    (phase) => {
      const raf = vi.spyOn(window, "requestAnimationFrame");
      const { queryByTestId } = renderPanel({ phase }, () => 0.9);
      expect(queryByTestId("voice-session-level")).toBeNull();
      expect(raf).not.toHaveBeenCalled();
    }
  );

  it("draws no meter for a mic that delivers nothing", () => {
    const { queryByTestId } = renderPanel({ micSignal: "silent" }, () => 0.9);
    expect(queryByTestId("voice-session-level")).toBeNull();
  });
});
