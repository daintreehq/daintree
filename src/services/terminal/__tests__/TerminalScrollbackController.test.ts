import { describe, it, expect, vi, beforeEach } from "vitest";
import { reduceScrollback, restoreScrollback } from "../TerminalScrollbackController";
import { type ManagedTerminal, SCROLLBACK_REDUCE_COOLDOWN_MS } from "../types";
import { getScrollbackForType } from "@/utils/scrollbackConfig";
import { logInfo } from "@/utils/logger";

const mockScrollbackStore = { scrollbackLines: 5000 };
vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => mockScrollbackStore },
}));

const mockPerformanceModeStore = { performanceMode: false };
vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => mockPerformanceModeStore },
}));

const mockProjectSettingsStore: { settings: Record<string, unknown> | null } = { settings: null };
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: { getState: () => mockProjectSettingsStore },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function getWrittenData(managed: ManagedTerminal): string[] {
  return (managed as unknown as { writtenData: string[] }).writtenData;
}

function makeMockManaged(overrides: Record<string, unknown> = {}): ManagedTerminal {
  const writtenData: string[] = [];
  // On the normal screen xterm reports the same buffer through both handles.
  // Shared here so setBufferLength keeps active and normal in agreement; the
  // alt-buffer cases below deliberately split them.
  const buffer = { length: 3000 };
  return {
    terminal: {
      options: { scrollback: 5000 },
      rows: 24,
      buffer: { active: buffer, normal: buffer },
      write: (data: string) => writtenData.push(data),
      hasSelection: vi.fn(() => false),
    },
    type: "terminal",
    kind: "terminal",
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    writtenData,
    ...overrides,
  } as unknown as ManagedTerminal;
}

// Shared by the #11673 blocks. Derived, not copied: the plain-terminal target
// is whatever the policy computes for the mocked global setting, and a "large
// current" above it stands in for a pre-downshift agent ceiling.
const plainTarget = getScrollbackForType(false, 5000);
const largeCurrent = plainTarget * 3;

function setBufferLength(managed: ManagedTerminal, length: number): void {
  Object.defineProperty(managed.terminal.buffer.active, "length", {
    value: length,
    writable: true,
  });
}

function retained(managed: ManagedTerminal): number {
  return managed.terminal.buffer.normal.length - managed.terminal.rows;
}

// Break the shared normal-screen buffer apart so the two handles can report
// different lengths, as they do while the alternate screen is up.
function splitBuffers(managed: ManagedTerminal, activeLength: number, normalLength: number): void {
  (managed.terminal as unknown as { buffer: unknown }).buffer = {
    active: { length: activeLength },
    normal: { length: normalLength },
  };
}

describe("TerminalScrollbackController", () => {
  beforeEach(() => {
    mockScrollbackStore.scrollbackLines = 5000;
    mockPerformanceModeStore.performanceMode = false;
    mockProjectSettingsStore.settings = null;
    vi.mocked(logInfo).mockClear();
  });

  describe("reduceScrollback", () => {
    it("skips focused terminals", () => {
      const managed = makeMockManaged({ isFocused: true });
      reduceScrollback(managed, 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips user-scrolled-back terminals", () => {
      const managed = makeMockManaged({ isUserScrolledBack: true });
      reduceScrollback(managed, 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips terminals in alt buffer mode", () => {
      const managed = makeMockManaged({ isAltBuffer: true });
      reduceScrollback(managed, 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips terminals with active text selection", () => {
      const managed = makeMockManaged();
      managed.terminal.hasSelection = vi.fn(() => true);
      reduceScrollback(managed, 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips when current scrollback already at or below target", () => {
      const managed = makeMockManaged();
      managed.terminal.options.scrollback = 300;
      reduceScrollback(managed, 500);
      expect(managed.terminal.options.scrollback).toBe(300);
    });

    it("reduces scrollback and logs info without polluting the terminal when content exceeds target", () => {
      const managed = makeMockManaged();
      Object.defineProperty(managed.terminal.buffer.active, "length", {
        value: 3000,
        writable: true,
      });
      reduceScrollback(managed, 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(getWrittenData(managed)).toHaveLength(0);
      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logInfo).toHaveBeenCalledWith(
        "Terminal scrollback reduced under memory pressure",
        expect.objectContaining({
          targetLines: 500,
          scrollbackUsed: 2976,
          previousScrollback: 5000,
          rows: 24,
        })
      );
    });

    it("reduces scrollback without logging when scrollback content is within target", () => {
      const managed = makeMockManaged();
      Object.defineProperty(managed.terminal.buffer.active, "length", {
        value: 100,
        writable: true,
      });
      reduceScrollback(managed, 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(getWrittenData(managed)).toHaveLength(0);
      expect(logInfo).not.toHaveBeenCalled();
    });

    describe("cooldown gate", () => {
      it("stamps lastScrollbackReduceAt on successful reduce", () => {
        const managed = makeMockManaged();
        const before = Date.now();
        reduceScrollback(managed, 500);
        const after = Date.now();

        expect(managed.terminal.options.scrollback).toBe(500);
        expect(managed.lastScrollbackReduceAt).toBeGreaterThanOrEqual(before);
        expect(managed.lastScrollbackReduceAt).toBeLessThanOrEqual(after);
      });

      it("skips a second reduce within the 2000ms cooldown window", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          nowSpy.mockReturnValue(10_000);
          const managed = makeMockManaged();
          reduceScrollback(managed, 500);
          expect(managed.terminal.options.scrollback).toBe(500);

          // Restore to 5000 to simulate a tier upgrade clearing the buffer
          // size, then re-trigger reduce inside cooldown — should be skipped.
          managed.terminal.options.scrollback = 5000;
          nowSpy.mockReturnValue(11_000); // 1000ms later, still inside 2000ms cooldown
          reduceScrollback(managed, 500);

          expect(managed.terminal.options.scrollback).toBe(5000);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("allows a second reduce after the 2000ms cooldown elapses", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          nowSpy.mockReturnValue(10_000);
          const managed = makeMockManaged();
          reduceScrollback(managed, 500);
          expect(managed.terminal.options.scrollback).toBe(500);

          managed.terminal.options.scrollback = 5000;
          nowSpy.mockReturnValue(12_001); // 2001ms later
          reduceScrollback(managed, 500);

          expect(managed.terminal.options.scrollback).toBe(500);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("force option bypasses the cooldown", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          nowSpy.mockReturnValue(10_000);
          const managed = makeMockManaged();
          reduceScrollback(managed, 500);

          managed.terminal.options.scrollback = 5000;
          nowSpy.mockReturnValue(10_500); // 500ms later, deep inside cooldown
          reduceScrollback(managed, 500, { force: true });

          expect(managed.terminal.options.scrollback).toBe(500);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("does not stamp the timestamp when an earlier guard short-circuits", () => {
        const managed = makeMockManaged({ isFocused: true });
        reduceScrollback(managed, 500);
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("does not stamp the timestamp when scrollback is already at or below target", () => {
        const managed = makeMockManaged();
        managed.terminal.options.scrollback = 300;
        reduceScrollback(managed, 500);
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("cooldown fencepost: blocks at 1999ms, allows at 2000ms", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          nowSpy.mockReturnValue(0);
          const managed = makeMockManaged();
          reduceScrollback(managed, 500);
          expect(managed.lastScrollbackReduceAt).toBe(0);

          // T = 1999ms → still inside cooldown (Date.now() - last = 1999 < 2000)
          managed.terminal.options.scrollback = 5000;
          nowSpy.mockReturnValue(1999);
          reduceScrollback(managed, 500);
          expect(managed.terminal.options.scrollback).toBe(5000);

          // T = 2000ms → cooldown expires (2000 < 2000 is false)
          nowSpy.mockReturnValue(2000);
          reduceScrollback(managed, 500);
          expect(managed.terminal.options.scrollback).toBe(500);
        } finally {
          nowSpy.mockRestore();
        }
      });
    });
  });

  describe("restoreScrollback", () => {
    it("restores to PERFORMANCE_MODE_SCROLLBACK when performance mode is on", () => {
      mockPerformanceModeStore.performanceMode = true;
      const managed = makeMockManaged();
      managed.terminal.options.scrollback = 50;

      restoreScrollback(managed);
      expect(managed.terminal.options.scrollback).toBe(100);
    });

    it("restores using getScrollbackForType for normal terminals", () => {
      const managed = makeMockManaged({ type: "terminal" });
      managed.terminal.options.scrollback = 500;

      restoreScrollback(managed);
      expect(managed.terminal.options.scrollback).toBe(1500);
    });

    it("uses project-level scrollback override for non-agent terminals", () => {
      mockProjectSettingsStore.settings = { terminalSettings: { scrollbackLines: 2000 } };
      const managed = makeMockManaged({ type: "terminal", kind: "terminal" });
      managed.terminal.options.scrollback = 100;

      restoreScrollback(managed);
      expect(managed.terminal.options.scrollback).toBe(600);
    });

    it("ignores project override for agent terminals", () => {
      mockProjectSettingsStore.settings = { terminalSettings: { scrollbackLines: 2000 } };
      const managed = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        runtimeAgentId: "claude",
      });
      managed.terminal.options.scrollback = 100;

      restoreScrollback(managed);
      // getScrollbackForType(true, 5000) = min(10000, floor(5000*10)) = 10000
      expect(managed.terminal.options.scrollback).toBe(10000);
    });

    // #10911 — a demotion flap (agent→plain) calls restoreScrollback with a
    // smaller plain target. That write irreversibly evicts scrollback in
    // xterm, so it must respect the same protections as reduceScrollback when
    // history would actually be dropped. Growth must stay unguarded.
    describe("destructive shrink guard (#10911)", () => {
      it("skips a demotion shrink for a focused terminal (preserves history)", () => {
        const managed = makeMockManaged({ isFocused: true });
        managed.terminal.options.scrollback = largeCurrent; // was an agent
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("skips a demotion shrink when the user has scrolled back", () => {
        const managed = makeMockManaged({ isUserScrolledBack: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });

      it("skips a demotion shrink in alt-buffer mode", () => {
        const managed = makeMockManaged({ isAltBuffer: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });

      it("skips a demotion shrink with an active text selection", () => {
        const managed = makeMockManaged();
        managed.terminal.hasSelection = vi.fn(() => true);
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });

      it("applies the shrink and stamps the cooldown for an idle background terminal", () => {
        const managed = makeMockManaged();
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);
        const before = Date.now();

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
        expect(managed.lastScrollbackReduceAt).toBeGreaterThanOrEqual(before);
      });

      it("shrinks even a focused terminal when no lines would be evicted", () => {
        const managed = makeMockManaged({ isFocused: true });
        managed.terminal.options.scrollback = largeCurrent;
        // Used scrollback well below the target ⇒ shrink drops nothing.
        setBufferLength(managed, managed.terminal.rows + 10);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
        // Non-destructive shrink is not a "reduce" — leave the cooldown alone.
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("respects the reduce cooldown for destructive shrinks", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          const managed = makeMockManaged();
          managed.lastScrollbackReduceAt = 10_000;
          managed.terminal.options.scrollback = largeCurrent;
          setBufferLength(managed, largeCurrent);

          nowSpy.mockReturnValue(10_000 + SCROLLBACK_REDUCE_COOLDOWN_MS - 1); // still inside cooldown
          restoreScrollback(managed);
          expect(managed.terminal.options.scrollback).toBe(largeCurrent);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("never guards a growth restore even when focused", () => {
        const managed = makeMockManaged({ isFocused: true });
        managed.terminal.options.scrollback = Math.floor(plainTarget / 3); // below target ⇒ grow
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
      });
    });

    // #11673 — a resource-profile downshift lowers the agent ceiling and
    // re-derives every foreground pane. Only one of them can be focused, so
    // the guards above leave every other on-screen pane exposed to a
    // destructive write.
    describe("visible-pane shrink clamp (#11673)", () => {
      it("clamps to retained history instead of evicting on a visible unfocused pane", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);

        // Ceiling comes down, but only as far as the lines already held.
        expect(managed.terminal.options.scrollback).toBe(retained(managed));
        expect(managed.terminal.options.scrollback).toBeGreaterThan(plainTarget);
        expect(managed.terminal.options.scrollback).toBeLessThan(largeCurrent);
      });

      it("keeps every retained line when it clamps", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);

        // The applied ceiling still holds everything the buffer had.
        expect(managed.terminal.options.scrollback).toBeGreaterThanOrEqual(retained(managed));
      });

      it("is idempotent — a second pass on a clamped buffer writes nothing", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        const afterFirst = managed.terminal.options.scrollback;
        // Buffer now sits at the clamped capacity.
        setBufferLength(managed, afterFirst + managed.terminal.rows);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(afterFirst);
      });

      it("does not stamp the reduce cooldown for a clamp", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("clamps regardless of a live reduce cooldown", () => {
        const nowSpy = vi.spyOn(Date, "now");
        try {
          const managed = makeMockManaged({ isVisible: true });
          managed.lastScrollbackReduceAt = 10_000;
          managed.terminal.options.scrollback = largeCurrent;
          setBufferLength(managed, largeCurrent);

          nowSpy.mockReturnValue(10_000 + SCROLLBACK_REDUCE_COOLDOWN_MS - 1);
          restoreScrollback(managed);

          // The cooldown exists to rate-limit destructive reduces; a clamp
          // evicts nothing, so it must not be gated by one.
          expect(managed.terminal.options.scrollback).toBe(retained(managed));
          expect(managed.lastScrollbackReduceAt).toBe(10_000);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("still evicts on a hidden pane", () => {
        const managed = makeMockManaged({ isVisible: false });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
        expect(managed.lastScrollbackReduceAt).toBeDefined();
      });

      it("logs the eviction on a hidden pane so the clip is not silent", () => {
        const managed = makeMockManaged({ isVisible: false });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(logInfo).toHaveBeenCalledWith(
          "Terminal scrollback ceiling lowered, evicting history",
          expect.objectContaining({
            targetLines: plainTarget,
            previousScrollback: largeCurrent,
            rows: managed.terminal.rows,
          })
        );
      });

      it("applies the full target on a visible pane when nothing would be evicted", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, managed.terminal.rows + 10);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
      });

      it("never clamps a growth restore on a visible pane", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.options.scrollback = Math.floor(plainTarget / 3);
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
      });

      it("leaves the focused bare-return ahead of the clamp", () => {
        const managed = makeMockManaged({ isVisible: true, isFocused: true });
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        // Interaction guards win: no write at all, not even a lossless one.
        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });

      it("leaves the selection bare-return ahead of the clamp", () => {
        const managed = makeMockManaged({ isVisible: true });
        managed.terminal.hasSelection = vi.fn(() => true);
        managed.terminal.options.scrollback = largeCurrent;
        setBufferLength(managed, largeCurrent);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });
    });

    // #11673 — while the alternate screen is up, buffer.active is only `rows`
    // tall. Measuring eviction on it reported zero, so the isAltBuffer guard
    // sat inside a branch that could not be entered and xterm trimmed the
    // normal buffer underneath a visible TUI.
    describe("alt-buffer eviction accounting (#11673)", () => {
      function makeAltBufferManaged(overrides: Record<string, unknown> = {}): ManagedTerminal {
        const managed = makeMockManaged({ isAltBuffer: true, ...overrides });
        // Alternate screen active: the visible buffer holds a viewport only,
        // while the normal buffer still carries the session's history.
        splitBuffers(managed, managed.terminal.rows, largeCurrent);
        managed.terminal.options.scrollback = largeCurrent;
        return managed;
      }

      it("skips the shrink for an alt-buffer pane holding normal-buffer history", () => {
        const managed = makeAltBufferManaged();

        restoreScrollback(managed);

        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
        expect(managed.lastScrollbackReduceAt).toBeUndefined();
      });

      it("skips it for a hidden alt-buffer pane too", () => {
        const managed = makeAltBufferManaged({ isVisible: false });

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(largeCurrent);
      });

      it("would have shrunk under viewport-only accounting", () => {
        const managed = makeAltBufferManaged();

        // Pins the regression: active.length is a bare viewport, so measuring
        // eviction on it yields zero and lets the write through.
        expect(managed.terminal.buffer.active.length - managed.terminal.rows).toBe(0);
        expect(managed.terminal.buffer.normal.length - managed.terminal.rows).toBeGreaterThan(
          plainTarget
        );
      });

      it("applies the shrink when the normal buffer holds nothing to lose", () => {
        const managed = makeAltBufferManaged();
        splitBuffers(managed, managed.terminal.rows, managed.terminal.rows + 5);

        restoreScrollback(managed);
        expect(managed.terminal.options.scrollback).toBe(plainTarget);
      });
    });
  });
});
