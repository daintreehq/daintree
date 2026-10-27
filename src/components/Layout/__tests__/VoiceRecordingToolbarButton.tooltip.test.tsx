// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { render, fireEvent, act } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useScratchStore } from "@/store/scratchStore";
import type { Scratch } from "@shared/types";
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

describe("VoiceRecordingToolbarButton — tooltip names what a click does", () => {
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
  ])("states the click action ($status, combo $combo)", ({ status, combo }) => {
    mockCombo = combo;
    const { getByTestId, container } = renderWith(status);

    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(focusActiveTarget).toHaveBeenCalledTimes(1);
    // Clicking jumps to the panel; the dictation shortcuts stop or resume
    // recording instead, so neither may be advertised as this button's own.
    expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);

    // Whatever else it says, the tooltip must describe the click the user is
    // about to make, and a bound shortcut stays a separate keyed row.
    expect(getByTestId("tooltip-content").textContent).toMatch(/click to jump to panel/i);
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
      title: "Recording: claude · notes · Connecting…",
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
      sessionElsewhere: { sessionId: "s1", hostId: "local", projectId: null, projectName: null },
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
      },
    });
    const { queryByTestId, container } = render(<VoiceRecordingToolbarButton />);

    expect(queryByTestId("voice-elsewhere-button")).toBeNull();
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Recording: claude · notes");
    fireEvent.click(button);
    expect(focusActiveTarget).toHaveBeenCalledTimes(1);
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
      },
    });

    expect(label()).toBe("Dictating on Studio. Click to go there.");
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
        const root = document.body.querySelector(
          "button, [aria-hidden='true'].toolbar-icon-button"
        ) as HTMLElement;
        return root.className
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
          sessionElsewhere: { sessionId: "s1", hostId: "local", projectId: "p", projectName: "A" },
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

    it("RAF effect deps are the wave's mode only — an object dep would restart the loop on every render", () => {
      expect(source).toMatch(/},\s*\[mode\]\);/);
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
  let frames: FrameRequestCallback[];
  let now: number;

  beforeEach(() => {
    frames = [];
    now = 0;
    motion.reduced = false;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
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

  function renderStatus(
    status: "arming" | "connecting" | "recording" | "reconnecting" | "finishing" | "paused",
    micSignal: "pending" | "live" | "silent" = "live"
  ) {
    useVoiceRecordingStore.setState({ status, micSignal, activeTarget: { panelId: "p-1" } });
    return render(<VoiceRecordingToolbarButton />);
  }

  function runFrames(count: number) {
    for (let i = 0; i < count; i++) {
      now += 16;
      const pending = frames;
      frames = [];
      pending.forEach((cb) => cb(now));
    }
  }

  function barScales(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>("[data-voice-wave] > span")).map(
      (bar) => Number(bar.style.transform.match(/scaleY\(([\d.]+)\)/)?.[1])
    );
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
    expect(container.querySelector("[data-voice-wave]")?.getAttribute("data-voice-wave")).toBe(
      c.mode
    );
    expect(container.querySelector("[data-voice-ring]")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("stays flat in silence and rises when the user speaks", () => {
    const { container } = renderStatus("recording");
    runFrames(30);
    const silent = barScales(container);
    expect(silent).toHaveLength(4);
    expect(Math.max(...silent)).toBeLessThanOrEqual(0.21);

    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(30);
    const speaking = barScales(container);
    expect(Math.max(...speaking)).toBeGreaterThan(0.6);
    // The bars move apart, not as one block.
    expect(new Set(speaking.map((v) => v.toFixed(2))).size).toBeGreaterThan(1);

    useVoiceRecordingStore.setState({ audioLevel: 0 });
    runFrames(120);
    expect(Math.max(...barScales(container))).toBeLessThanOrEqual(0.21);
  });

  it("holds its shape under reduced motion while brightness follows the voice", () => {
    motion.reduced = true;
    const { container } = renderStatus("recording");
    const bars = () => Array.from(container.querySelectorAll<HTMLElement>("[data-voice-wave] > span"));
    runFrames(20);
    const quietShape = barScales(container);
    const quietOpacity = Number(bars()[0]!.style.opacity);

    useVoiceRecordingStore.setState({ audioLevel: 0.8 });
    runFrames(20);
    expect(barScales(container)).toEqual(quietShape);
    expect(Number(bars()[0]!.style.opacity)).toBeGreaterThan(quietOpacity);
  });

  it("runs no level loop while waiting or paused", () => {
    renderStatus("paused");
    expect(frames).toHaveLength(0);
  });

  it("stops the level loop when listening ends", () => {
    const { rerender } = renderStatus("recording");
    expect(frames.length).toBeGreaterThan(0);
    act(() => {
      useVoiceRecordingStore.setState({ status: "finishing" });
    });
    rerender(<VoiceRecordingToolbarButton />);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });
});
