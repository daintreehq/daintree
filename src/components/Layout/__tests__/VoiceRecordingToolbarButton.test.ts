import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const BUTTON_PATH = path.resolve(__dirname, "../VoiceRecordingToolbarButton.tsx");
const TOOLBAR_PATH = path.resolve(__dirname, "../Toolbar.tsx");

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

  describe("Doherty anti-flicker gate", () => {
    it("imports useDohertyGate from the deferred-loading hook module", () => {
      expect(source).toContain("useDohertyGate");
      expect(source).toContain('from "@/hooks/useDeferredLoading"');
    });

    it("gates the connecting-state orbit reveal behind the 400ms Doherty threshold", () => {
      // Sub-400ms connections must never paint the orbit ring — the
      // placeholder stays visible throughout.
      expect(source).toMatch(/useDohertyGate\(isConnecting\)/);
    });
  });

  describe("RAF-driven orbit ring (off-React animation)", () => {
    it("reads the audio level imperatively in the tick so per-frame updates do not trigger React work", () => {
      // No React subscription to audioLevel — the store field updates ~60Hz
      // during recording, and a subscription re-renders the button per frame.
      expect(source).not.toMatch(/useVoiceRecordingStore\(\s*\(state\)\s*=>\s*state\.audioLevel/);
      expect(source).toMatch(/useVoiceRecordingStore\.getState\(\)\.audioLevel/);
    });

    it("drives the ring with requestAnimationFrame and cleans up via cancelAnimationFrame", () => {
      expect(source).toContain("requestAnimationFrame");
      expect(source).toContain("cancelAnimationFrame(rafRef.current)");
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
        /const\s+showOrbit\s*=\s*[\s\S]*isActive\s*&&\s*\(isRecording\s*\|\|\s*isReconnecting\s*\|\|\s*isFinishing\s*\|\|\s*isPaused\s*\|\|\s*showConnecting\)/
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

    it("renders a single Mic icon across all states (no per-state icon swap)", () => {
      // Mic must appear exactly once — the orbit overlays it consistently.
      const micMatches = source.match(/<Mic\b/g) ?? [];
      expect(micMatches.length).toBe(1);
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

    it("shows the arming cue without the Doherty gate — immediate hotkey feedback", () => {
      // Arming IS the visual confirmation the user expects in <50ms; gating
      // it behind the 400ms threshold would defeat the feature.
      expect(source).toMatch(/showArming\s*=\s*isActive\s*&&\s*\(isArming/);
    });

    it("the tooltip names the target panel during arming so the user can verify before audio opens", () => {
      expect(source).toMatch(/Arming dictation/);
    });

    it("the toolbar overflow pin includes arming so the button pops out before audio init", () => {
      // Arming must survive the overflow filter — otherwise the cue is
      // invisible whenever the user hides the button.
      expect(toolbar).toMatch(/state\.status\s*===\s*"arming"/);
    });
  });
});
