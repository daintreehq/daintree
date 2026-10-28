// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Profiler } from "react";
import fs from "fs/promises";
import path from "path";
import { render, fireEvent, act } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useScratchStore } from "@/store/scratchStore";
import type { Scratch, VoiceSessionSnapshot } from "@shared/types";
import { setElsewhereLevel } from "@/services/voiceElsewhereLevel";
import { readToolbarSource } from "./toolbarSource";

const BUTTON_PATH = path.resolve(__dirname, "../VoiceRecordingToolbarButton.tsx");

const focusActiveTarget = vi.fn();
const revealSessionElsewhere = vi.fn();
const dispatch = vi.fn();
let mockCombo: string | undefined;

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: {
    focusActiveTarget: () => focusActiveTarget(),
    revealSessionElsewhere: () => revealSessionElsewhere(),
  },
}));

// The hosts this machine has added, as the host list would report them.
const hostList = vi.hoisted(() => ({
  hosts: [] as Array<{ descriptor: { id: string; name: string } }>,
}));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({ hosts: hostList.hosts, localSummary: null }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "Meta+.",
  useEffectiveCombo: () => mockCombo,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/hooks/useDeferredLoading", () => ({
  useDohertyGate: (value: boolean) => value,
}));

const motion = vi.hoisted(() => ({ reduced: true }));
vi.mock("@/lib/appThemeViewTransition", () => ({
  prefersReducedMotion: () => motion.reduced,
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
}));

// The session panel's own behaviour is covered with the real primitives in
// VoiceRecordingToolbarButton.panel.test.tsx.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: (label: React.ReactNode, shortcut?: string) => (
    <span data-testid="tooltip-shortcut-row" data-shortcut={shortcut ?? ""}>
      {label}
    </span>
  ),
}));

describe("VoiceRecordingToolbarButton — a short tooltip over the session panel (#14920)", () => {
  beforeEach(() => {
    focusActiveTarget.mockClear();
    mockCombo = undefined;
    useVoiceRecordingStore.setState({ pendingTarget: null });
  });

  afterEach(() => {
    useVoiceRecordingStore.setState({ pendingTarget: null });
  });

  function renderWith(status: "recording" | "paused") {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status,
      micSignal: "live",
      elapsedSeconds: 42,
      activeTarget: {
        panelId: "p-1",
        panelTitle: "claude · notes",
        projectName: "Daintree",
        worktreeLabel: "main",
      },
    });
    return render(<VoiceRecordingToolbarButton />);
  }

  it.each([
    { status: "recording" as const, combo: undefined },
    { status: "recording" as const, combo: "Cmd+." },
    { status: "paused" as const, combo: undefined },
    { status: "paused" as const, combo: "Ctrl+Shift+Space" },
  ])("opens the panel rather than jumping ($status, combo $combo)", ({ status, combo }) => {
    mockCombo = combo;
    const { getByTestId, container } = renderWith(status);

    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(focusActiveTarget).not.toHaveBeenCalled();
    // Clicking opens the panel; the dictation shortcuts stop or resume
    // recording instead, so neither may be advertised as this button's own.
    expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);

    // One line of state and the shortcut: the target, its place and the
    // clock live in the panel.
    const tooltip = getByTestId("tooltip-content").textContent ?? "";
    expect(tooltip).not.toMatch(/click to jump/i);
    expect(tooltip).not.toContain("claude · notes");
    expect(tooltip).not.toContain("Daintree");
    expect(tooltip).not.toContain("0:42");
    const shortcutRow = container.querySelector('[data-testid="tooltip-shortcut-row"]');
    if (combo) {
      expect(shortcutRow?.getAttribute("data-shortcut")).toBe(combo);
      expect(shortcutRow?.textContent).not.toMatch(/click/i);
    } else {
      expect(shortcutRow).toBeNull();
    }
  });

  it.each([
    { status: "connecting" as const, micSignal: "pending" as const, title: "Starting microphone…" },
    { status: "recording" as const, micSignal: "pending" as const, title: "Starting microphone…" },
    {
      status: "recording" as const,
      micSignal: "silent" as const,
      title: "No audio from microphone",
    },
    {
      status: "recording" as const,
      micSignal: "silent" as const,
      micDeviceLabel: "AirPods Pro",
      title: "No audio from AirPods Pro",
    },
    {
      status: "connecting" as const,
      micSignal: "live" as const,
      title: "Recording · Connecting…",
    },
    {
      status: "finishing" as const,
      micSignal: "pending" as const,
      title: "Finishing transcription…",
    },
  ])(
    "separates mic state from backend state ($status, mic $micSignal) — #13105",
    ({ status, micSignal, micDeviceLabel = null, title }) => {
      useVoiceRecordingStore.setState({
        isConfigured: true,
        status,
        micSignal,
        micDeviceLabel,
        activeTarget: {
          panelId: "p-1",
          panelTitle: "claude · notes",
          projectName: "Daintree",
          worktreeLabel: "main",
        },
      });
      const { container } = render(<VoiceRecordingToolbarButton />);
      expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(title);
    }
  );

  // #14604: a start waiting on a finishing session gets the arming cue here,
  // the only place a single or maximized pane shows it.
  it.each([
    {
      status: "finishing" as const,
      activeTarget: { panelId: "p-1", panelTitle: "claude · notes" },
    },
    { status: "idle" as const, activeTarget: null },
  ])("arms for a queued start instead of the level ($status)", ({ status, activeTarget }) => {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status,
      micSignal: "live",
      activeTarget,
      pendingTarget: { panelId: "p-2", panelTitle: "codex · api" },
    });
    const { container } = render(<VoiceRecordingToolbarButton />);

    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Arming dictation: codex · api"
    );
    expect(container.querySelector("[data-voice-wave]")?.getAttribute("data-voice-wave")).toBe(
      "waiting"
    );
  });
});

describe("VoiceRecordingToolbarButton — dictation in another view (#14601)", () => {
  beforeEach(() => {
    revealSessionElsewhere.mockClear();
    focusActiveTarget.mockClear();
    mockCombo = "Cmd+.";
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "idle",
      activeTarget: null,
      lockedTarget: null,
    });
  });

  it("says where dictation runs, and a click goes there", () => {
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: "p-a",
        projectName: "Alpha",
        provider: null,
        details: null,
      },
    });
    const { getByTestId } = render(<VoiceRecordingToolbarButton />);

    const button = getByTestId("voice-elsewhere-button");
    expect(button.getAttribute("aria-label")).toBe("Dictating in Alpha. Click to go there.");
    expect(getByTestId("tooltip-content").textContent).toMatch(/click to go there/i);
    const shortcutRow = getByTestId("tooltip-shortcut-row");
    expect(shortcutRow.getAttribute("data-shortcut")).toBe("Cmd+.");
    expect(shortcutRow.textContent).toBe("Stop");

    fireEvent.click(button);
    expect(revealSessionElsewhere).toHaveBeenCalledTimes(1);
  });

  it("names a scratch by its own name, which main doesn't know", () => {
    const scratchId = "3f2b8a1c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const scratch: Scratch = {
      id: scratchId,
      path: "/scratches/spike",
      name: "Spike",
      createdAt: 1,
      lastOpened: 1,
    };
    useScratchStore.setState({
      scratches: [scratch],
    });
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: scratchId,
        projectName: null,
        provider: null,
        details: null,
      },
    });
    const { getByTestId } = render(<VoiceRecordingToolbarButton />);

    expect(getByTestId("voice-elsewhere-button").getAttribute("aria-label")).toBe(
      "Dictating in Spike. Click to go there."
    );
    useScratchStore.setState({ scratches: [] });
  });

  it("says only that it runs elsewhere when the workspace has no known name", () => {
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: null,
        projectName: null,
        provider: null,
        details: null,
      },
    });
    const { getByTestId } = render(<VoiceRecordingToolbarButton />);

    expect(getByTestId("voice-elsewhere-button").getAttribute("aria-label")).toBe(
      "Dictating elsewhere. Click to go there."
    );
  });

  it("shows this view's own session instead while one runs here", () => {
    useVoiceRecordingStore.setState({
      status: "recording",
      micSignal: "live",
      activeTarget: { panelId: "p-1", panelTitle: "claude · notes" },
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: "p-a",
        projectName: "Alpha",
        provider: null,
        details: null,
      },
    });
    const { queryByTestId, container } = render(<VoiceRecordingToolbarButton />);

    expect(queryByTestId("voice-elsewhere-button")).toBeNull();
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Recording dictation");
    fireEvent.click(button);
    expect(focusActiveTarget).not.toHaveBeenCalled();
    expect(revealSessionElsewhere).not.toHaveBeenCalled();
  });

  it("puts the session elsewhere ahead of this view's lock", () => {
    useVoiceRecordingStore.setState({
      lockedTarget: { panelId: "p-1", panelTitle: "claude · notes" },
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: "p-a",
        projectName: "Alpha",
        provider: null,
        details: null,
      },
    });
    const { getByTestId, queryByTestId } = render(<VoiceRecordingToolbarButton />);

    expect(getByTestId("voice-elsewhere-button")).toBeTruthy();
    expect(queryByTestId("voice-locked-button")).toBeNull();
  });

  it("stays an invisible placeholder when nothing runs anywhere", () => {
    useVoiceRecordingStore.setState({ sessionElsewhere: null });
    const { queryByTestId, container } = render(<VoiceRecordingToolbarButton />);

    expect(queryByTestId("voice-elsewhere-button")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[aria-hidden="true"].opacity-0')).not.toBeNull();
  });
});

describe("VoiceRecordingToolbarButton — dictation on another host (#14773)", () => {
  const scratchId = "3f2b8a1c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const originalPlatform = navigator.platform;

  beforeEach(() => {
    revealSessionElsewhere.mockClear();
    mockCombo = "Cmd+.";
    hostList.hosts = [{ descriptor: { id: "studio-01", name: "Studio" } }];
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "idle",
      activeTarget: null,
      lockedTarget: null,
    });
  });

  afterEach(() => {
    hostList.hosts = [];
    useVoiceRecordingStore.setState({ sessionElsewhere: null });
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
    Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
    useScratchStore.setState({ scratches: [] });
  });

  const label = () =>
    render(<VoiceRecordingToolbarButton />)
      .getByTestId("voice-elsewhere-button")
      .getAttribute("aria-label");

  it("names the host and its project for a session on another machine", () => {
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "studio-01",
        projectId: "proj-r",
        projectName: "Remote R",
        provider: null,
        details: null,
      },
    });

    expect(label()).toBe("Dictating in Remote R on Studio. Click to go there.");
  });

  it("names the host even from a view on that same host", () => {
    Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-01" });
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "studio-01",
        projectId: "proj-r",
        projectName: "Remote R",
        provider: null,
        details: null,
      },
    });

    expect(label()).toBe("Dictating in Remote R on Studio. Click to go there.");
  });

  it("names this Mac for a session here, seen from a host's view", () => {
    Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-01" });
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "local",
        projectId: "p-a",
        projectName: "Alpha",
        provider: null,
        details: null,
      },
    });

    expect(label()).toBe("Dictating in Alpha on This Mac. Click to go there.");
  });

  it("goes by the host's id when the host list doesn't name it", () => {
    hostList.hosts = [];
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "studio-09",
        projectId: null,
        projectName: null,
        provider: null,
        details: null,
      },
    });

    expect(label()).toBe("Dictating on studio-09. Click to go there.");
  });

  it("never names another host's scratch by this view's scratch of the same id", () => {
    useScratchStore.setState({
      scratches: [{ id: scratchId, path: "/s", name: "Local spike", createdAt: 1, lastOpened: 1 }],
    });
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: "studio-01",
        projectId: scratchId,
        projectName: null,
        provider: null,
        details: null,
      },
    });

    expect(label()).toBe("Dictating on Studio. Click to go there.");
  });
});

describe("VoiceRecordingToolbarButton — dictation another view owns looks like the owner's (#14921)", () => {
  const originalPlatform = navigator.platform;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  let now = 0;

  const details = (overrides: Partial<VoiceSessionSnapshot> = {}): VoiceSessionSnapshot => ({
    phase: "recording",
    kind: "dictation",
    targetTitle: "Claude",
    targetChrome: null,
    targetHostId: null,
    projectName: "Alpha",
    worktreeLabel: "main",
    micLabel: "MacBook Pro Microphone",
    micSignal: "live",
    micNotice: null,
    stopWarning: false,
    correctionEnabled: false,
    locked: false,
    wordCount: 3,
    transcript: "fix the build",
    clock: { at: 0, elapsedMs: 5_000, pausedMs: 0, paused: false, autoStop: null },
    ...overrides,
  });

  // The session's host, and the host of the view looking at it.
  const pairings = [
    {
      name: "on this Mac, seen from a host",
      hostId: "local",
      viewHost: "studio-01",
      place: "in Alpha on This Mac",
    },
    {
      name: "on a host, seen from this Mac",
      hostId: "studio-01",
      viewHost: null,
      place: "in Alpha on Studio",
    },
    {
      name: "on one host, seen from another",
      hostId: "studio-01",
      viewHost: "studio-02",
      place: "in Alpha on Studio",
    },
    {
      name: "in another project on the same host",
      hostId: "studio-01",
      viewHost: "studio-01",
      place: "in Alpha on Studio",
    },
  ];

  function show(pairing: (typeof pairings)[number], value: VoiceSessionSnapshot | null) {
    if (pairing.viewHost) Reflect.set(window, "__DAINTREE_HOST_ID__", { id: pairing.viewHost });
    useVoiceRecordingStore.setState({
      sessionElsewhere: {
        sessionId: "s1",
        hostId: pairing.hostId,
        projectId: "p-a",
        projectName: "Alpha",
        provider: "openai",
        details: value,
      },
    });
    return render(<VoiceRecordingToolbarButton />);
  }

  const waveOf = (container: HTMLElement) =>
    container.querySelector("[data-voice-wave]")?.getAttribute("data-voice-wave") ?? null;
  const barScales = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-voice-wave] > span")).map((bar) =>
      Number(bar.style.transform.match(/scaleY\(([\d.]+)\)/)?.[1])
    );
  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      act(() => {
        pending.forEach((cb) => cb(now));
      });
    }
  }

  beforeEach(() => {
    frames.clear();
    nextFrameId = 0;
    now = 0;
    motion.reduced = false;
    mockCombo = "Cmd+.";
    hostList.hosts = [{ descriptor: { id: "studio-01", name: "Studio" } }];
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++nextFrameId, cb);
      return nextFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "idle",
      activeTarget: null,
      pendingTarget: null,
      lockedTarget: null,
      audioLevel: 0,
    });
  });

  afterEach(() => {
    motion.reduced = true;
    vi.restoreAllMocks();
    setElsewhereLevel(null);
    hostList.hosts = [];
    useVoiceRecordingStore.setState({ sessionElsewhere: null });
    Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
    Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
  });

  describe.each(pairings)("a session $name", (pairing) => {
    // The owner's own tooltip line for each state, and its wave.
    it.each([
      {
        phase: "recording",
        micSignal: "live",
        warn: false,
        wave: "level",
        state: "Recording dictation",
      },
      {
        phase: "connecting",
        micSignal: "live",
        warn: false,
        wave: "level",
        state: "Recording · Connecting",
      },
      {
        phase: "connecting",
        micSignal: "pending",
        warn: false,
        wave: "waiting",
        state: "Starting microphone",
      },
      {
        phase: "recording",
        micSignal: "silent",
        warn: false,
        wave: "waiting",
        state: "No audio from MacBook Pro Microphone",
      },
      { phase: "paused", micSignal: "live", warn: false, wave: "held", state: "Dictation paused" },
      {
        phase: "paused",
        micSignal: "live",
        warn: true,
        wave: "held",
        state: "Paused · Stopping in 10s unless resumed",
      },
      {
        phase: "recording",
        micSignal: "live",
        warn: true,
        wave: "level",
        state: "Recording · Stopping in 10s unless you speak",
      },
      {
        phase: "reconnecting",
        micSignal: "live",
        warn: false,
        wave: "waiting",
        state: "Reconnecting",
      },
      {
        phase: "finishing",
        micSignal: "live",
        warn: false,
        wave: "waiting",
        state: "Finishing transcription",
      },
    ] as const)("shows $phase with the mic $micSignal (warning $warn) as the owner does", (c) => {
      const { getByTestId, container } = show(
        pairing,
        details({ phase: c.phase, micSignal: c.micSignal, stopWarning: c.warn })
      );

      expect(waveOf(container)).toBe(c.wave);
      expect(getByTestId("voice-elsewhere-button").getAttribute("aria-label")).toBe(
        `${c.state} ${pairing.place}`
      );
    });

    it("moves its bars with the level main relays, not this view's own", () => {
      const { container } = show(pairing, details());
      runFrames(20);
      expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.31);

      // This view's own meter reading says nothing about another view's mic.
      useVoiceRecordingStore.setState({ audioLevel: 0.9 });
      runFrames(20);
      expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.31);

      for (let i = 0; i < 5; i++) {
        setElsewhereLevel({ sessionId: "s1", level: 0.8 }, now);
        runFrames(6);
      }
      expect(Math.max(...barScales(container))).toBeGreaterThan(0.8);
    });
  });

  it("ignores a level reading for another session", () => {
    const { container } = show(pairings[0]!, details());
    for (let i = 0; i < 5; i++) {
      setElsewhereLevel({ sessionId: "old", level: 0.9 }, now);
      runFrames(6);
    }
    expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.31);
  });

  it("falls to rest once readings stop coming", () => {
    const { container } = show(pairings[0]!, details());
    setElsewhereLevel({ sessionId: "s1", level: 0.9 }, now);
    runFrames(10);
    expect(Math.max(...barScales(container))).toBeGreaterThan(0.6);

    runFrames(60);
    expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.31);
  });

  it("stays the bare mic until the owner's first report lands", () => {
    const { getByTestId, container } = show(pairings[1]!, null);

    expect(waveOf(container)).toBeNull();
    expect(getByTestId("voice-elsewhere-button").getAttribute("aria-label")).toBe(
      "Dictating in Alpha on Studio. Click to go there."
    );
    expect(frames.size).toBe(0);
  });
});

describe("VoiceRecordingToolbarButton polish — issue #8176", () => {
  let source: string;
  let toolbar: string;

  beforeEach(async () => {
    [source, toolbar] = await Promise.all([fs.readFile(BUTTON_PATH, "utf-8"), readToolbarSource()]);
  });

  describe("footprint reservation prevents layout shift", () => {
    it("the voice-recording toolbar slot is always available so right-aligned items stay stable", () => {
      // Slot must mount unconditionally — `isAvailable: hasActiveVoiceRecording`
      // was the cause of the shift when a session started/ended.
      expect(toolbar).not.toContain("isAvailable: hasActiveVoiceRecording");
      expect(toolbar).toMatch(/"voice-recording":\s*{[\s\S]*?isAvailable:\s*true/);
    });

    it("every state the slot shows shares one footprint, the waveform's included (#14911)", () => {
      const widthOf = () => {
        const root = document.body.querySelector<HTMLElement>(
          "button, [aria-hidden='true'].toolbar-icon-button"
        );
        return (root?.className ?? "")
          .split(/\s+/)
          .filter((c) => /^[wh]-/.test(c))
          .sort()
          .join(" ");
      };
      const states: Array<Partial<ReturnType<typeof useVoiceRecordingStore.getState>>> = [
        { status: "idle", activeTarget: null, lockedTarget: null, sessionElsewhere: null },
        {
          status: "idle",
          activeTarget: null,
          lockedTarget: { panelId: "p-1", panelTitle: "notes" },
          sessionElsewhere: null,
        },
        {
          status: "idle",
          activeTarget: null,
          lockedTarget: null,
          sessionElsewhere: {
            sessionId: "s1",
            hostId: "local",
            projectId: "p",
            projectName: "A",
            provider: null,
            details: null,
          },
        },
        {
          status: "recording",
          micSignal: "live",
          activeTarget: { panelId: "p-1" },
          lockedTarget: null,
          sessionElsewhere: null,
        },
      ];
      const footprints = states.map((state) => {
        useVoiceRecordingStore.setState({ isConfigured: true, pendingTarget: null, ...state });
        const { unmount } = render(<VoiceRecordingToolbarButton />);
        const footprint = widthOf();
        unmount();
        return footprint;
      });
      expect(footprints[0]).toMatch(/w-/);
      expect(new Set(footprints).size).toBe(1);
    });

    it("placeholder is excluded from the roving tabindex — opacity-0 does NOT null offsetParent", () => {
      // Toolbar.getToolbarItems filters [data-toolbar-item] by offsetParent;
      // opacity-0 leaves offsetParent intact, so a placeholder carrying
      // data-toolbar-item would absorb arrow-key focus while being
      // aria-hidden + non-interactive. DevServerPlaceholder follows the
      // same rule — it has no data-toolbar-item either.
      const placeholderBlock = source.match(/function VoiceRecordingPlaceholder[\s\S]*?\n\}/)?.[0];
      expect(placeholderBlock).toBeDefined();
      // Look only at the rendered JSX, not the explanatory comments above it.
      const placeholderJsx = placeholderBlock!.match(/return\s*\(([\s\S]*?)\);/)?.[1];
      expect(placeholderJsx).toBeDefined();
      expect(placeholderJsx!).not.toContain("data-toolbar-item");
    });

    it("placeholder is returned via early-return so an inactive slot never paints orbit chrome", () => {
      // The early return must come AFTER hooks (RAF, refs) but BEFORE the
      // active button JSX, mirroring VoiceInputButton's gating. The guard
      // now also lets the arming state through so its static accent ring
      // can paint before audio init begins (#9178).
      expect(source).toMatch(/if\s*\(!isActive\s*\|\|\s*!waveMode\)\s*{/);
      expect(source).toMatch(/return\s+<VoiceRecordingPlaceholder/);
    });

    it("toolbar overflow ignores inactive voice-recording so the badge never warns on a placeholder", () => {
      // Reserving footprint must not pollute the overflow severity — the
      // dropdown badge would otherwise show warning for a hidden placeholder.
      expect(toolbar).toContain("visibleLeftOverflow");
      expect(toolbar).toContain("visibleRightOverflow");
      expect(toolbar).toMatch(/filter\(\(id\)\s*=>\s*id\s*!==\s*"voice-recording"\)/);
    });
  });

  describe("the level waits for real mic audio — issue #13105", () => {
    it("shows the level only once the mic signal is live, not when the backend connects", () => {
      // A Bluetooth mic can hand over zeros long after the backend is ready;
      // the level claims "listening" so it keys off micSignal, not status.
      expect(source).toMatch(/const\s+isMicLive\s*=\s*micSignal\s*===\s*"live"/);
      expect(source).not.toContain("useDohertyGate");
    });

    it("holds the waiting bars from the hotkey press until the mic is live", () => {
      expect(source).toMatch(
        /const\s+showWaiting\s*=\s*isQueued\s*\|\|\s*\(isActive\s*&&\s*\(isArming\s*\|\|\s*isMicStarting\s*\|\|\s*isReconnecting\s*\|\|\s*isFinishing\)\)/
      );
    });
  });

  describe("RAF-driven level waveform (off-React animation)", () => {
    it("reads the audio level imperatively in the tick so per-frame updates do not trigger React work", () => {
      // No React subscription to audioLevel — the store field updates ~60Hz
      // during recording, and a subscription re-renders the button per frame.
      expect(source).not.toMatch(/useVoiceRecordingStore\(\s*\(state\)\s*=>\s*state\.audioLevel/);
      expect(source).toMatch(/useVoiceRecordingStore\.getState\(\)\.audioLevel/);
    });

    it("RAF effect deps are the wave's mode and session id only — an object dep would restart the loop on every render", () => {
      expect(source).toMatch(/},\s*\[mode, elsewhereSessionId\]\);/);
    });

    it("gates showLevel on isActive so a status race with a cleared activeTarget cannot run a ghost loop", () => {
      // Without this gate, a transient (status=recording, activeTarget=null)
      // state would let the RAF loop run while the placeholder is rendered.
      expect(source).toMatch(
        /const\s+showLevel\s*=\s*!isQueued\s*&&\s*isActive\s*&&\s*isListening/
      );
    });
  });

  describe("unified visual primitive across all active states", () => {
    it("no longer swaps in a Spinner for the finishing state", () => {
      // The Spinner-for-finishing path is the visual inconsistency this
      // polish removes — the waveform stays visible through finishing.
      expect(source).not.toContain('from "@/components/ui/Spinner"');
      expect(source).not.toContain("<Spinner");
    });

    it("uses scoped transition durations — never the broad transition-all", () => {
      // Motion timing rule: never widen scoped transitions to transition-all.
      expect(source).not.toContain("transition-all");
    });
  });

  // Issue #9178 — pre-recording arming state.
  describe("pre-recording arming state (#9178)", () => {
    it("derives isArming and isActive includes it so the placeholder gives way", () => {
      expect(source).toMatch(/const\s+isArming\s*=\s*status\s*===\s*"arming"/);
      expect(source).toMatch(/isActive\s*=[\s\S]*?isArming/);
    });

    it("the toolbar overflow pin includes arming so the button pops out before audio init", () => {
      // Arming must survive the overflow filter — otherwise the cue is
      // invisible whenever the user hides the button.
      expect(toolbar).toMatch(/state\.status\s*===\s*"arming"/);
    });
  });
});

describe("VoiceRecordingToolbarButton — locked target (#14629)", () => {
  beforeEach(() => {
    dispatch.mockClear();
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status: "idle",
      activeTarget: null,
      lockedTarget: null,
    });
  });

  it("names the locked panel by its own title and unlocks on click", () => {
    useVoiceRecordingStore.setState({
      lockedTarget: { panelId: "p-1", panelTitle: "notes", projectName: "Daintree" },
    });
    const { getByTestId } = render(<VoiceRecordingToolbarButton />);
    const button = getByTestId("voice-locked-button");
    expect(button.getAttribute("aria-label")).toBe("Dictation locked to notes. Click to unlock.");
    fireEvent.click(button);
    expect(dispatch).toHaveBeenCalledWith("voiceInput.unlockTarget", undefined, {
      source: "user",
    });
  });

  it("renders no locked button when nothing is locked", () => {
    const { queryByTestId } = render(<VoiceRecordingToolbarButton />);
    expect(queryByTestId("voice-locked-button")).toBeNull();
  });
});

// #14911: the toolbar shows the mic and a small waveform; the orbit is the
// composer's signal, and nothing in the toolbar spins.
describe("VoiceRecordingToolbarButton — waveform (#14911)", () => {
  // Pending frames by id; ids only ever grow, so a cancel of a stale id
  // leaves the live frame pending and the loop running.
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let now: number;

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    now = 0;
    motion.reduced = false;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++nextFrameId, cb);
      return nextFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    useVoiceRecordingStore.setState({
      isConfigured: true,
      pendingTarget: null,
      lockedTarget: null,
      sessionElsewhere: null,
      audioLevel: 0,
    });
  });

  afterEach(() => {
    motion.reduced = true;
    vi.restoreAllMocks();
    useVoiceRecordingStore.setState({ audioLevel: 0 });
  });

  type Status = "arming" | "connecting" | "recording" | "reconnecting" | "finishing" | "paused";
  type MicSignal = "pending" | "live" | "silent";

  function renderStatus(status: Status, micSignal: MicSignal = "live") {
    useVoiceRecordingStore.setState({ status, micSignal, activeTarget: { panelId: "p-1" } });
    return render(<VoiceRecordingToolbarButton />);
  }

  // Each frame runs inside act, so any React work a frame queued has
  // committed before the next assertion.
  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      now += 16;
      const pending = [...frames.values()];
      frames.clear();
      act(() => {
        pending.forEach((cb) => cb(now));
      });
    }
  }

  function bars(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-voice-wave] > span"));
  }

  function barScales(container: HTMLElement) {
    return bars(container).map((bar) =>
      Number(bar.style.transform.match(/scaleY\(([\d.]+)\)/)?.[1])
    );
  }

  function waveMode(container: HTMLElement) {
    return container.querySelector("[data-voice-wave]")?.getAttribute("data-voice-wave");
  }

  it.each([
    { status: "recording" as const, micSignal: "live" as const, mode: "level" },
    { status: "connecting" as const, micSignal: "live" as const, mode: "level" },
    { status: "arming" as const, micSignal: "pending" as const, mode: "waiting" },
    { status: "recording" as const, micSignal: "pending" as const, mode: "waiting" },
    { status: "recording" as const, micSignal: "silent" as const, mode: "waiting" },
    { status: "reconnecting" as const, micSignal: "live" as const, mode: "waiting" },
    { status: "finishing" as const, micSignal: "live" as const, mode: "waiting" },
    { status: "paused" as const, micSignal: "live" as const, mode: "held" },
  ])("$status with the mic $micSignal shows the $mode wave and no ring", (c) => {
    const { container } = renderStatus(c.status, c.micSignal);
    expect(waveMode(container)).toBe(c.mode);
    expect(container.querySelector("[data-voice-ring]")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // Bars only while listening; the waits and the pause draw a glyph instead
    // and cost no frames.
    expect(bars(container)).toHaveLength(c.mode === "level" ? 4 : 0);
    expect(frames.size).toBe(c.mode === "level" ? 1 : 0);
  });

  it("tells waiting, paused and listening apart by shape, not colour", () => {
    const markOf = (status: Status, micSignal?: MicSignal) => {
      const { container, unmount } = renderStatus(status, micSignal);
      const wave = container.querySelector("[data-voice-wave]")!;
      const mark = {
        bars: bars(container).length,
        glyph: wave.querySelector("svg")?.getAttribute("class") ?? null,
      };
      unmount();
      return mark;
    };
    const waiting = markOf("arming", "pending");
    const held = markOf("paused");
    const listening = markOf("recording");

    expect(listening).toEqual({ bars: 4, glyph: null });
    expect(waiting.bars).toBe(0);
    expect(held.bars).toBe(0);
    // Two different glyphs, neither of them a spinner.
    expect(waiting.glyph).not.toBeNull();
    expect(held.glyph).not.toBeNull();
    expect(waiting.glyph).not.toBe(held.glyph);
    expect(`${waiting.glyph} ${held.glyph}`).not.toMatch(/spin|loader/);
  });

  it("stays at rest in silence, rises when the user speaks, and settles once they stop", () => {
    const { container } = renderStatus("recording");
    runFrames(30);
    const silent = barScales(container);
    expect(silent).toHaveLength(4);
    expect(Math.max(...silent)).toBeLessThanOrEqual(0.31);

    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(30);
    const speaking = barScales(container);
    expect(Math.max(...speaking)).toBeGreaterThan(0.8);
    // The bars keep a shape, not one block.
    expect(new Set(speaking.map((v) => v.toFixed(2))).size).toBeGreaterThan(1);

    // Back at rest within 0.6s of the voice stopping: the release, plus the
    // oldest bar's trail through the history.
    useVoiceRecordingStore.setState({ audioLevel: 0 });
    runFrames(36);
    expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.31);
  });

  it("travels: a burst reaches the newest bar first and the oldest last", () => {
    const { container } = renderStatus("recording");
    runFrames(10);
    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    // Each bar rises once the burst is as old as its lag (70ms apart).
    const risenAt = [-1, -1, -1, -1];
    for (let frame = 1; frame <= 20; frame++) {
      runFrames(1);
      barScales(container).forEach((scale, i) => {
        if (risenAt[i] === -1 && scale > 0.4) risenAt[i] = frame;
      });
    }
    expect(risenAt.every((frame) => frame > 0)).toBe(true);
    const [oldest = -1, second = -1, third = -1, newest = -1] = risenAt;
    expect(newest).toBeLessThan(third);
    expect(third).toBeLessThan(second);
    expect(second).toBeLessThan(oldest);
  });

  it("drops what it heard before the frames stopped", () => {
    const { container } = renderStatus("recording");
    useVoiceRecordingStore.setState({ audioLevel: 0.9 });
    runFrames(30);
    expect(Math.max(...barScales(container))).toBeGreaterThan(0.8);
    // The window is hidden for five seconds and the room goes quiet.
    now += 5000;
    useVoiceRecordingStore.setState({ audioLevel: 0 });
    runFrames(1);
    const after = barScales(container);
    expect(after).toHaveLength(4);
    expect(Math.max(...after)).toBeLessThanOrEqual(0.31);
  });

  it("never drops below rest when the first frame predates the loop's start", () => {
    now = 1000;
    const { container } = renderStatus("recording");
    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    const pending = [...frames.values()];
    frames.clear();
    act(() => {
      pending.forEach((cb) => cb(990));
    });
    runFrames(5);
    const scales = barScales(container);
    expect(scales).toHaveLength(4);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.3);
  });

  it("holds one still shape under reduced motion, whatever the level", () => {
    const { container } = renderStatus("recording");
    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(20);
    const moving = barScales(container);

    // Turned on mid-dictation: the bars stop in the still shape.
    motion.reduced = true;
    runFrames(5);
    const still = barScales(container);
    expect(still).not.toEqual(moving);
    useVoiceRecordingStore.setState({ audioLevel: 0 });
    runFrames(30);
    expect(barScales(container)).toEqual(still);

    // And off again: the bars follow the level once more.
    motion.reduced = false;
    runFrames(30);
    expect(barScales(container)).not.toEqual(still);
  });

  it("moves the bars without a React commit per level update", () => {
    let commits = 0;
    useVoiceRecordingStore.setState({
      status: "recording",
      micSignal: "live",
      activeTarget: { panelId: "p-1" },
    });
    const { container } = render(
      <Profiler id="voice" onRender={() => commits++}>
        <VoiceRecordingToolbarButton />
      </Profiler>
    );
    runFrames(2);
    const before = commits;
    act(() => {
      useVoiceRecordingStore.setState({ audioLevel: 0.9 });
    });
    runFrames(30);
    expect(commits).toBe(before);
    expect(Math.max(...barScales(container))).toBeGreaterThan(0.5);
  });

  it("cancels the level loop's live frame on unmount", () => {
    const { unmount } = renderStatus("recording");
    runFrames(5);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it.each([
    { status: "finishing" as const, mode: "waiting" },
    { status: "reconnecting" as const, mode: "waiting" },
    { status: "paused" as const, mode: "held" },
  ])("stops the level loop when listening gives way to $status", ({ status, mode }) => {
    const { container } = renderStatus("recording");
    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(5);
    act(() => {
      useVoiceRecordingStore.setState({ status });
    });
    expect(frames.size).toBe(0);
    expect(waveMode(container)).toBe(mode);
    // The loop's bars go with it.
    expect(bars(container)).toHaveLength(0);

    // And come back with one live loop when listening resumes.
    act(() => {
      useVoiceRecordingStore.setState({ status: "recording" });
    });
    expect(frames.size).toBe(1);
    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(30);
    expect(frames.size).toBe(1);
    expect(Math.max(...barScales(container))).toBeGreaterThan(0.8);
  });
});
