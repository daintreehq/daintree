// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { render, fireEvent } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

const BUTTON_PATH = path.resolve(__dirname, "../VoiceRecordingToolbarButton.tsx");
const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

const focusActiveTarget = vi.fn();
let mockCombo: string | undefined;

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { focusActiveTarget: () => focusActiveTarget() },
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "Meta+.",
  useEffectiveCombo: () => mockCombo,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/hooks/useDeferredLoading", () => ({
  useDohertyGate: (value: boolean) => value,
}));

vi.mock("@/lib/appThemeViewTransition", () => ({
  prefersReducedMotion: () => true,
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
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
      status: "connecting" as const,
      micSignal: "live" as const,
      title: "Recording: Daintree / main · Connecting…",
    },
    {
      status: "finishing" as const,
      micSignal: "pending" as const,
      title: "Finishing transcription…",
    },
  ])(
    "separates mic state from backend state ($status, mic $micSignal) — #13105",
    ({ status, micSignal, title }) => {
      useVoiceRecordingStore.setState({
        isConfigured: true,
        status,
        micSignal,
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
});

describe("VoiceRecordingToolbarButton polish — issue #8176", () => {
  let source: string;
  let toolbar: string;

  beforeEach(async () => {
    [source, toolbar] = await Promise.all([
      fs.readFile(BUTTON_PATH, "utf-8"),
      fs.readFile(TOOLBAR_PATH, "utf-8"),
    ]);
  });

  describe("footprint reservation prevents layout shift", () => {
    it("the voice-recording toolbar slot is always available so right-aligned items stay stable", () => {
      // Slot must mount unconditionally — `isAvailable: hasActiveVoiceRecording`
      // was the cause of the shift when a session started/ended.
      expect(toolbar).not.toContain("isAvailable: hasActiveVoiceRecording");
      expect(toolbar).toMatch(/"voice-recording":\s*{[\s\S]*?isAvailable:\s*true/);
    });

    it("renders an invisible placeholder with the same h-9 w-9 footprint as the active button", () => {
      expect(source).toContain("VoiceRecordingPlaceholder");
      expect(source).toMatch(/h-9\s+w-9\s+opacity-0\s+pointer-events-none/);
      expect(source).toContain('aria-hidden="true"');
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
      expect(source).toMatch(/if\s*\(!isActive\s*\|\|\s*\(!showOrbit\s*&&\s*!showArming\)\)\s*{/);
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

  describe("orbit waits for real mic audio — issue #13105", () => {
    it("spins the orbit only once the mic signal is live, not when the backend connects", () => {
      // A Bluetooth mic can hand over zeros long after the backend is ready;
      // the orbit claims "listening" so it keys off micSignal, not status.
      expect(source).toMatch(/const\s+isMicLive\s*=\s*micSignal\s*===\s*"live"/);
      expect(source).not.toContain("useDohertyGate");
    });

    it("holds the static arming ring from the hotkey press until the mic is live", () => {
      expect(source).toMatch(
        /const\s+showArming\s*=\s*isActive\s*&&\s*\(isArming\s*\|\|\s*isMicStarting\s*\|\|\s*\(isFinishing\s*&&\s*!isMicLive\)\)/
      );
    });
  });

  describe("RAF-driven orbit ring (off-React animation)", () => {
    it("reads the audio level imperatively in the tick so per-frame updates do not trigger React work", () => {
      // No React subscription to audioLevel — the store field updates ~60Hz
      // during recording, and a subscription re-renders the button per frame.
      expect(source).not.toMatch(/useVoiceRecordingStore\(\s*\(state\)\s*=>\s*state\.audioLevel/);
      expect(source).toMatch(/useVoiceRecordingStore\.getState\(\)\.audioLevel/);
    });

    it("RAF effect deps are primitive booleans only — adding object refs would restart on every render", () => {
      // All deps must derive from `status` (string from store) so the RAF
      // tear-down/restart only fires on real state transitions, not every
      // render. #9191 added isPaused to gate a frozen orbit branch.
      expect(source).toMatch(/},\s*\[showOrbit,\s*isFinishing,\s*isPaused\]\);/);
    });

    it("gates showOrbit on isActive so a status race with a cleared activeTarget cannot spin a ghost loop", () => {
      // Without this gate, a transient (status=recording, activeTarget=null)
      // state would let the RAF loop run while the placeholder is rendered,
      // leaving the tick to no-op against null refs every frame. #9191 added
      // isPaused as another isActive sub-state that should still render the
      // (frozen) orbit chrome.
      expect(source).toMatch(
        /const\s+showOrbit\s*=\s*isActive\s*&&\s*\(\(\(isSessionOpen\s*\|\|\s*isFinishing\)\s*&&\s*isMicLive\)\s*\|\|\s*isPaused\)/
      );
    });

    it("forces level=0 during finishing so the ring decelerates instead of snapping off", () => {
      expect(source).toMatch(
        /isFinishing\s*\?\s*0\s*:\s*useVoiceRecordingStore\.getState\(\)\.audioLevel/
      );
    });
  });

  describe("unified visual primitive across all active states", () => {
    it("no longer swaps in a Spinner for the finishing state", () => {
      // The Spinner-for-finishing path is the visual inconsistency this
      // polish removes — orbit ring stays visible through finishing.
      expect(source).not.toContain('from "@/components/ui/Spinner"');
      expect(source).not.toContain("<Spinner");
    });

    it("does NOT use contain:strict on the wrapper — clips orbit overflow at toolbar scale", () => {
      // VoiceInputButton uses contain:strict on a fixed 24×24 box with
      // inset-0 children. At the toolbar's 36×36 button-shell scale, the
      // ring uses inset-1 within a relative Button — adding contain:strict
      // would clip the ring edges.
      expect(source).not.toContain('contain: "strict"');
      expect(source).not.toMatch(/contain:\s*['"]strict['"]/);
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
