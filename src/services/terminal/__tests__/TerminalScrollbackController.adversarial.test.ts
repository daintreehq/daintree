import { beforeEach, describe, expect, it, vi } from "vitest";
import { reduceScrollback, restoreScrollback } from "../TerminalScrollbackController";
import type { ManagedTerminal } from "../types";
import { TerminalRefreshTier } from "@shared/types/panel";
import { logInfo } from "@/utils/logger";

const mockState = vi.hoisted(() => ({
  scrollbackStore: { scrollbackLines: 5000 },
  performanceModeStore: { performanceMode: false },
  projectSettingsStore: {
    settings: null as { terminalSettings?: { scrollbackLines?: number } } | null,
  },
}));

vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => mockState.scrollbackStore },
}));

vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => mockState.performanceModeStore },
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: { getState: () => mockState.projectSettingsStore },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function createManagedTerminal(
  overrides: Partial<ManagedTerminal> = {},
  terminalOverrides: Partial<ManagedTerminal["terminal"]> = {}
): ManagedTerminal {
  const write = vi.fn();
  const hasSelection = vi.fn(() => false);
  const buffer = { length: 3000 };

  return {
    terminal: {
      options: { scrollback: 5000 },
      buffer: { active: buffer, normal: buffer },
      rows: 24,
      hasSelection,
      write,
      ...terminalOverrides,
    } as ManagedTerminal["terminal"],
    type: "terminal",
    kind: "terminal",
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    ...overrides,
  } as ManagedTerminal;
}

describe("TerminalScrollbackController adversarial", () => {
  beforeEach(() => {
    mockState.scrollbackStore.scrollbackLines = 5000;
    mockState.performanceModeStore.performanceMode = false;
    mockState.projectSettingsStore.settings = null;
    vi.mocked(logInfo).mockClear();
  });

  it("INVALID_PROJECT_OVERRIDE_NAN", () => {
    mockState.projectSettingsStore.settings = {
      terminalSettings: { scrollbackLines: Number.NaN },
    };
    const managed = createManagedTerminal();

    restoreScrollback(managed);

    expect(managed.terminal.options.scrollback).toBe(1500);
    expect(Number.isFinite(managed.terminal.options.scrollback)).toBe(true);
  });

  it("ZERO_BASE_SCROLLBACK_USES_POLICY_MAX", () => {
    mockState.scrollbackStore.scrollbackLines = 0;
    mockState.projectSettingsStore.settings = {
      terminalSettings: { scrollbackLines: 0 },
    };

    const terminalManaged = createManagedTerminal();
    const agentManaged = createManagedTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      runtimeAgentId: "claude",
    });

    restoreScrollback(terminalManaged);
    restoreScrollback(agentManaged);

    expect(terminalManaged.terminal.options.scrollback).toBe(2000);
    expect(agentManaged.terminal.options.scrollback).toBe(10000);
  });

  it("NEGATIVE_SCROLLBACK_USED_NO_WARN", () => {
    const managed = createManagedTerminal({}, {
      options: { scrollback: 4000 },
      rows: 24,
      buffer: { active: { length: 12 }, normal: { length: 12 } },
    } as unknown as Partial<ManagedTerminal["terminal"]>);

    reduceScrollback(managed, 500);

    expect(managed.terminal.options.scrollback).toBe(500);
    expect(managed.terminal.write).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("HUGE_BUFFER_REDUCTION_LOGS_ONCE_NO_TERMINAL_WRITE", () => {
    const managed = createManagedTerminal({}, {
      options: { scrollback: 2_000_000 },
      buffer: { active: { length: 5_000_000 }, normal: { length: 5_000_000 } },
    } as unknown as Partial<ManagedTerminal["terminal"]>);

    reduceScrollback(managed, 500);

    expect(managed.terminal.options.scrollback).toBe(500);
    expect(managed.terminal.write).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      "Terminal scrollback reduced under memory pressure",
      expect.objectContaining({
        targetLines: 500,
        scrollbackUsed: 4_999_976,
        previousScrollback: 2_000_000,
        rows: 24,
      })
    );
  });

  // #11673 — visibility is read from managed.isVisible, never derived from the
  // refresh tier. A hidden pane can sit at BURST while streaming, and a visible
  // pane can lag at BACKGROUND during a handoff; deriving one from the other
  // protects the wrong terminals in both directions.
  it("VISIBLE_AT_BACKGROUND_TIER_IS_PROTECTED", () => {
    const managed = createManagedTerminal({
      isVisible: true,
      lastAppliedTier: TerminalRefreshTier.BACKGROUND,
    });

    restoreScrollback(managed);

    // 3000 - 24 = 2976 retained vs a 1500 plain target ⇒ clamp, not evict.
    expect(managed.terminal.options.scrollback).toBe(2976);
  });

  it("HIDDEN_AT_BURST_TIER_IS_NOT_PROTECTED", () => {
    const managed = createManagedTerminal({
      isVisible: false,
      lastAppliedTier: TerminalRefreshTier.BURST,
    });

    restoreScrollback(managed);

    expect(managed.terminal.options.scrollback).toBe(1500);
    expect(managed.lastScrollbackReduceAt).toBeDefined();
  });

  it("STORE_FLIP_NO_CACHE", () => {
    const managed = createManagedTerminal();
    mockState.projectSettingsStore.settings = {
      terminalSettings: { scrollbackLines: 2000 },
    };

    restoreScrollback(managed);
    expect(managed.terminal.options.scrollback).toBe(600);

    mockState.projectSettingsStore.settings = null;
    mockState.scrollbackStore.scrollbackLines = 0;

    restoreScrollback(managed);

    expect(managed.terminal.options.scrollback).toBe(2000);
  });
});
