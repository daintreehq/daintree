// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AgentSettings, CliAvailability } from "@shared/types";

// The launcher's inventory hook, which both placements read. Its one subtle job
// is that `pinnedCount` has to index the same group the model slices — the
// LAUNCHABLE agents — or the Pinned/Other boundary lands a row off.

let mockAvailability: CliAvailability = {} as CliAvailability;
let mockHasRealData = true;
let mockAgentSettings: AgentSettings | null = { agents: {} } as AgentSettings;
let mockLeftButtons: string[] = [];
let mockRightButtons: string[] = [];

// Hoisted: a fresh object per selector call would churn the hook's memo for
// reasons that have nothing to do with the hook — the real store hands back a
// stable reference between changes.
const CURRENT_PROJECT = { id: "p", path: "/repo" };

vi.mock("@/store", () => ({
  useProjectStore: (selector: (s: { currentProject: unknown }) => unknown) =>
    selector({ currentProject: CURRENT_PROJECT }),
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: null }),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (s: { currentScratch: unknown }) => unknown) =>
    selector({ currentScratch: null }),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (s: { settings: AgentSettings | null }) => unknown) =>
    selector({ settings: mockAgentSettings }),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (
    selector: (s: { availability: CliAvailability; hasRealData: boolean }) => unknown
  ) => selector({ availability: mockAvailability, hasRealData: mockHasRealData }),
}));

vi.mock("@/store/toolbarPreferencesStore", () => ({
  useToolbarPreferencesStore: (
    selector: (s: { layout: { leftButtons: string[]; rightButtons: string[] } }) => unknown
  ) => selector({ layout: { leftButtons: mockLeftButtons, rightButtons: mockRightButtons } }),
}));

vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ worktrees: [] }) }));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude", "gemini", "codex"],
  getAgentConfig: (id: string) => ({ id, name: id, icon: undefined, color: undefined }),
}));

import { useLauncherData } from "../useLauncherData";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";

beforeEach(() => {
  mockAvailability = {} as CliAvailability;
  mockHasRealData = true;
  mockAgentSettings = { agents: {} } as AgentSettings;
  mockLeftButtons = [];
  mockRightButtons = [];
});

describe("useLauncherData", () => {
  it("counts pins against the launchable group the split actually slices", () => {
    // Claude is pinned but BLOCKED, so it never reaches the launchable group.
    // Counting it would push the Pinned/Other boundary one row down and label
    // an unpinned, ready agent as pinned.
    mockAvailability = { claude: "blocked", gemini: "ready", codex: "ready" } as CliAvailability;
    mockAgentSettings = {
      agents: { claude: { pinned: true }, gemini: { pinned: false }, codex: { pinned: false } },
    } as AgentSettings;
    mockLeftButtons = ["claude"];

    const { result } = renderHook(() => useLauncherData());
    const launchable = result.current.agents.filter((a) => isAgentLaunchable(a.availability));

    expect(result.current.pinnedCount).toBeLessThanOrEqual(launchable.length);
    // Neither ready agent is pinned, so nothing may be claimed as pinned.
    expect(result.current.pinnedCount).toBe(0);
  });

  it("counts a pinned launchable agent", () => {
    mockAvailability = { claude: "ready", gemini: "ready" } as CliAvailability;
    mockAgentSettings = {
      agents: { claude: { pinned: true }, gemini: { pinned: false } },
    } as AgentSettings;
    mockLeftButtons = ["claude"];

    const { result } = renderHook(() => useLauncherData());
    expect(result.current.pinnedCount).toBe(1);
    // The pinned one leads, so the model's slice takes it.
    expect(result.current.agents[0]?.id).toBe("claude");
  });

  it("orders every launchable agent ahead of the ones that only need setup", () => {
    // The setup rows render under their own band, so their position within the
    // array is irrelevant — but they must not sit inside the slice range.
    mockAvailability = { claude: "ready", gemini: "blocked", codex: "ready" } as CliAvailability;

    const { result } = renderHook(() => useLauncherData());
    const ids = result.current.agents.map((a) => a.id);
    const firstNotLaunchable = result.current.agents.findIndex(
      (a) => !isAgentLaunchable(a.availability)
    );
    const lastLaunchable = result.current.agents.reduce(
      (acc, a, i) => (isAgentLaunchable(a.availability) ? i : acc),
      -1
    );

    expect(ids).toContain("gemini");
    expect(firstNotLaunchable).toBeGreaterThan(lastLaunchable);
  });

  it("falls back to every built-in agent only once detection has really landed", () => {
    // Nothing installed. While detection is still running the two are
    // indistinguishable, so the discovery list must not commit yet.
    mockAvailability = {} as CliAvailability;
    mockHasRealData = false;
    const loading = renderHook(() => useLauncherData());
    expect(loading.result.current.agentInventoryState).toBe("loading");

    mockHasRealData = true;
    const settled = renderHook(() => useLauncherData());
    expect(settled.result.current.agentInventoryState).toBe("fallback");
    expect(settled.result.current.agents.length).toBeGreaterThan(0);
    // A discovery list is nobody's pinned group.
    expect(settled.result.current.pinnedCount).toBe(0);
  });

  it("reports the workspace preconditions the gated panel rows read", () => {
    const { result } = renderHook(() => useLauncherData());
    expect(result.current.hasProject).toBe(true);
    // A project is a workspace, so the file browser has something to browse.
    expect(result.current.hasWorkspace).toBe(true);
  });

  it("returns a stable object so a consumer can key a memo on it", () => {
    // `Toolbar` builds its whole button registry in a memo keyed on this value;
    // a fresh object every render would rebuild the toolbar on every store tick.
    const { result, rerender } = renderHook(() => useLauncherData());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
