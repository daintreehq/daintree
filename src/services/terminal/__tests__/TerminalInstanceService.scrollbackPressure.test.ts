// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import {
  AGENT_SCROLLBACK_MAX_LINES,
  getScrollbackForType,
  setAgentScrollbackMaxLines,
} from "@/utils/scrollbackConfig";
import { SCROLLBACK_BACKGROUND } from "@shared/config/scrollback";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useScrollbackStore } from "@/store/scrollbackStore";

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    resize: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    acknowledgePortData: vi.fn(),
    getPortAckGeneration: vi.fn(() => 0),
    discardPortAcks: vi.fn(),
    acknowledgeData: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

type ScrollbackTestService = {
  instances: Map<string, Record<string, unknown>>;
  applyAgentPromotion: (id: string, agentId: string) => void;
  reduceScrollbackHidden: (targetLines: number) => void;
  restoreScrollbackAll: () => void;
};

type MockManaged = {
  terminal: { options: { scrollback: number }; [key: string]: unknown };
  lastScrollbackReduceAt?: number;
};

// Retained history is set well above every target below, so each shrink in
// this file is a destructive one and runs the full guard set.
function makeManaged(
  overrides: Record<string, unknown> = {}
): MockManaged & Record<string, unknown> {
  const buffer = { length: 6000 };
  return {
    terminal: {
      options: { scrollback: AGENT_SCROLLBACK_MAX_LINES },
      rows: 24,
      buffer: { active: buffer, normal: buffer },
      hasSelection: vi.fn(() => false),
    },
    type: "terminal",
    kind: "terminal",
    runtimeAgentId: "claude",
    isVisible: false,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastAppliedTier: TerminalRefreshTier.BACKGROUND,
    ...overrides,
  };
}

function scrollbackOf(managed: MockManaged): number {
  return managed.terminal.options.scrollback;
}

describe("TerminalInstanceService scrollback under memory pressure (#14215)", () => {
  let service: ScrollbackTestService;
  const initialPerformanceMode = usePerformanceModeStore.getState().performanceMode;
  const initialScrollbackLines = useScrollbackStore.getState().scrollbackLines;

  beforeEach(async () => {
    service = (await (
      await import("../terminalInstanceServiceAccessor")
    ).load()) as unknown as ScrollbackTestService;
    vi.useFakeTimers();
    service.instances.clear();
    usePerformanceModeStore.setState({ performanceMode: false });
    useScrollbackStore.setState({ scrollbackLines: 5000 });
  });

  afterEach(() => {
    service.instances.clear();
    setAgentScrollbackMaxLines(AGENT_SCROLLBACK_MAX_LINES);
    usePerformanceModeStore.setState({ performanceMode: initialPerformanceMode });
    useScrollbackStore.setState({ scrollbackLines: initialScrollbackLines });
    vi.useRealTimers();
  });

  describe("reduceScrollbackHidden", () => {
    it("trims hidden terminals and leaves visible ones alone", () => {
      const hidden = makeManaged();
      const visible = makeManaged({ isVisible: true });
      service.instances.set("hidden", hidden);
      service.instances.set("visible", visible);

      service.reduceScrollbackHidden(SCROLLBACK_BACKGROUND);

      expect(scrollbackOf(hidden)).toBe(SCROLLBACK_BACKGROUND);
      expect(scrollbackOf(visible)).toBe(AGENT_SCROLLBACK_MAX_LINES);
      expect(hidden.scrollbackPressureCapped).toBe(true);
      expect(visible.scrollbackPressureCapped).toBeUndefined();
    });

    it("selects by visibility, not refresh tier", () => {
      // A hidden pane streaming output sits at BURST; a just-revealed pane can
      // still read BACKGROUND until the tier catches up.
      const hiddenBurst = makeManaged({ lastAppliedTier: TerminalRefreshTier.BURST });
      const visibleBackground = makeManaged({ isVisible: true });
      service.instances.set("hidden-burst", hiddenBurst);
      service.instances.set("visible-background", visibleBackground);

      service.reduceScrollbackHidden(SCROLLBACK_BACKGROUND);

      expect(scrollbackOf(hiddenBurst)).toBe(SCROLLBACK_BACKGROUND);
      expect(scrollbackOf(visibleBackground)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    });

    it("keeps the interaction guards for hidden terminals", () => {
      const guarded = [
        makeManaged({ isFocused: true }),
        makeManaged({ isUserScrolledBack: true }),
        makeManaged({ isAltBuffer: true }),
      ];
      const selecting = makeManaged();
      (selecting.terminal as unknown as { hasSelection: () => boolean }).hasSelection = () => true;
      guarded.push(selecting);
      guarded.forEach((managed, i) => service.instances.set(`t${i}`, managed));

      service.reduceScrollbackHidden(SCROLLBACK_BACKGROUND);

      for (const managed of guarded) {
        expect(scrollbackOf(managed)).toBe(AGENT_SCROLLBACK_MAX_LINES);
      }
    });

    it("respects the per-terminal cooldown", () => {
      const recentlyReduced = makeManaged({ lastScrollbackReduceAt: Date.now() });
      service.instances.set("t1", recentlyReduced);

      service.reduceScrollbackHidden(SCROLLBACK_BACKGROUND);

      expect(scrollbackOf(recentlyReduced)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    });
  });

  describe("restoreScrollbackAll", () => {
    it("lowers the agent ceiling on background terminals after a profile downshift", () => {
      setAgentScrollbackMaxLines(AGENT_SCROLLBACK_MAX_LINES - 1000);
      const background = makeManaged();
      service.instances.set("t1", background);

      service.restoreScrollbackAll();

      expect(scrollbackOf(background)).toBe(getScrollbackForType(true, 5000));
      expect(scrollbackOf(background)).toBeLessThan(AGENT_SCROLLBACK_MAX_LINES);
    });

    it("keeps the guards for a background terminal whose history would be evicted", () => {
      setAgentScrollbackMaxLines(AGENT_SCROLLBACK_MAX_LINES - 1000);
      const scrolledBack = makeManaged({ isUserScrolledBack: true });
      service.instances.set("t1", scrolledBack);

      service.restoreScrollbackAll();

      expect(scrollbackOf(scrolledBack)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    });

    it("never raises a hidden pane's pressure cap", () => {
      // Raising it would let a streaming agent refill memory mid-episode; the
      // reveal gives the capacity back. An uncapped hidden pane, or a visible
      // one, still takes the new ceiling.
      setAgentScrollbackMaxLines(AGENT_SCROLLBACK_MAX_LINES - 1000);
      const capped = makeManaged({ scrollbackPressureCapped: true });
      const uncapped = makeManaged();
      const visible = makeManaged({ isVisible: true, scrollbackPressureCapped: true });
      for (const managed of [capped, uncapped, visible]) {
        managed.terminal.options.scrollback = SCROLLBACK_BACKGROUND;
      }
      service.instances.set("capped", capped);
      service.instances.set("uncapped", uncapped);
      service.instances.set("visible", visible);

      service.restoreScrollbackAll();

      const ceiling = getScrollbackForType(true, 5000);
      expect(scrollbackOf(capped)).toBe(SCROLLBACK_BACKGROUND);
      expect(scrollbackOf(uncapped)).toBe(ceiling);
      expect(scrollbackOf(visible)).toBe(ceiling);
      expect(visible.scrollbackPressureCapped).toBeUndefined();
    });

    it("keeps a hidden pane's pressure cap across agent promotion", () => {
      const capped = makeManaged({ scrollbackPressureCapped: true });
      capped.terminal.options.scrollback = SCROLLBACK_BACKGROUND;
      service.instances.set("t1", capped);

      service.applyAgentPromotion("t1", "claude");
      service.applyAgentPromotion("t1", "codex");

      expect(scrollbackOf(capped)).toBe(SCROLLBACK_BACKGROUND);
    });

    it("does nothing in performance mode, whose fixed limit ignores the agent ceiling", () => {
      // Performance mode's restore writes unconditionally, guards and all — a
      // profile change must not spread that to every terminal in the view.
      usePerformanceModeStore.setState({ performanceMode: true });
      const scrolledBack = makeManaged({ isUserScrolledBack: true });
      service.instances.set("t1", scrolledBack);

      service.restoreScrollbackAll();

      expect(scrollbackOf(scrolledBack)).toBe(AGENT_SCROLLBACK_MAX_LINES);
    });
  });
});
