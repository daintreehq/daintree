import { beforeEach, describe, expect, it, vi } from "vitest";
import { reduceScrollback, restoreScrollback } from "../TerminalScrollbackController";
import type { ManagedTerminal } from "../types";

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

function createManagedTerminal(
  overrides: Partial<ManagedTerminal> = {},
  terminalOverrides: Partial<ManagedTerminal["terminal"]> = {}
): ManagedTerminal {
  const write = vi.fn();
  const hasSelection = vi.fn(() => false);

  return {
    terminal: {
      options: { scrollback: 5000 },
      buffer: { active: { length: 3000 } },
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
      kind: "agent",
      type: "claude",
    });

    restoreScrollback(terminalManaged);
    restoreScrollback(agentManaged);

    expect(terminalManaged.terminal.options.scrollback).toBe(2000);
    expect(agentManaged.terminal.options.scrollback).toBe(5000);
  });

  it("NEGATIVE_SCROLLBACK_USED_NO_WARN", () => {
    const managed = createManagedTerminal({}, {
      options: { scrollback: 4000 },
      rows: 24,
      buffer: { active: { length: 12 } },
    } as unknown as Partial<ManagedTerminal["terminal"]>);

    reduceScrollback(managed, 500);

    expect(managed.terminal.options.scrollback).toBe(500);
    expect(managed.terminal.write).not.toHaveBeenCalled();
  });

  it("HUGE_BUFFER_REDUCTION_ONE_NOTICE", () => {
    const managed = createManagedTerminal({}, {
      options: { scrollback: 2_000_000 },
      buffer: { active: { length: 5_000_000 } },
    } as unknown as Partial<ManagedTerminal["terminal"]>);

    reduceScrollback(managed, 500);

    expect(managed.terminal.options.scrollback).toBe(500);
    expect(managed.terminal.write).toHaveBeenCalledTimes(1);
    expect(managed.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining("Scrollback reduced to 500 lines")
    );
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
