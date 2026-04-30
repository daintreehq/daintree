// @vitest-environment node
/**
 * Tests the default-sentinel preset resolution logic from useAgentLauncher.ts.
 *
 * The full hook has deep React/Electron dependencies that make direct rendering
 * costly here, so we test the pure branching logic inline — mirroring lines
 * 159-167 of useAgentLauncher.ts — using the real getMergedPreset function.
 * Any change to those lines should require a corresponding update here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentPreset } from "@/config/agents";
import { resolveEffectivePresetId, type AgentSettingsEntry } from "@shared/types";

// ── mocks ────────────────────────────────────────────────────────────────────

const getMergedPresetMock = vi.hoisted(() =>
  vi.fn<
    (
      agentId: string,
      presetId: string | undefined,
      customPresets: AgentPreset[] | undefined,
      ccrPresets: AgentPreset[] | undefined,
      projectPresets?: AgentPreset[] | undefined
    ) => AgentPreset | undefined
  >()
);

vi.mock("@/config/agents", () => ({
  getMergedPreset: getMergedPresetMock,
  getMergedPresets: vi.fn(() => []),
  getAgentConfig: vi.fn(),
  isRegisteredAgent: vi.fn(() => true),
  getAgentDisplayTitle: vi.fn((id: string) => id),
}));

// ── mirror of the hook's preset resolution block (useAgentLauncher.ts:159-167) ─

import { getMergedPreset } from "@/config/agents";

function resolvePresetForLaunch(
  presetId: string | null | undefined,
  entry: AgentSettingsEntry,
  ccrPresets: AgentPreset[] | undefined,
  agentId: string,
  isAgent: boolean,
  projectPresets?: AgentPreset[] | undefined,
  worktreeId?: string | null
): AgentPreset | undefined {
  const explicitDefault = presetId === null;
  const savedPresetId = resolveEffectivePresetId(entry, worktreeId);
  const resolvedPresetId = explicitDefault ? undefined : (presetId ?? savedPresetId);
  const primary =
    isAgent && !explicitDefault
      ? getMergedPreset(agentId, resolvedPresetId, entry.customPresets, ccrPresets, projectPresets)
      : undefined;
  if (primary) return primary;

  // Mirror of the launch-time fallback in useAgentLauncher.ts: a stale
  // worktree-scoped override falls through to the agent-level default so
  // a deleted scoped pick doesn't silently drop the launch's preset.
  const scopedId =
    worktreeId && entry.worktreePresets ? entry.worktreePresets[worktreeId] : undefined;
  if (
    isAgent &&
    !explicitDefault &&
    presetId === undefined &&
    scopedId &&
    scopedId === resolvedPresetId &&
    entry.presetId &&
    entry.presetId !== scopedId
  ) {
    return getMergedPreset(
      agentId,
      entry.presetId,
      entry.customPresets,
      ccrPresets,
      projectPresets
    );
  }
  return undefined;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const CUSTOM_PRESET: AgentPreset = {
  id: "user-111",
  name: "My Preset",
  env: { MY_VAR: "hello" },
};

const CCR_PRESET: AgentPreset = {
  id: "ccr-abc",
  name: "CCR: Some Route",
  env: { ANTHROPIC_BASE_URL: "https://proxy.test" },
};

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getMergedPresetMock.mockReset();
});

describe("default sentinel: presetId === null", () => {
  it("does NOT call getMergedPreset", () => {
    resolvePresetForLaunch(null, { presetId: "user-111" }, undefined, "claude", true);
    expect(getMergedPresetMock).not.toHaveBeenCalled();
  });

  it("returns undefined (no preset applied)", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    const result = resolvePresetForLaunch(
      null,
      { presetId: "user-111" },
      undefined,
      "claude",
      true
    );
    expect(result).toBeUndefined();
  });

  it("ignores a saved entry.presetId when presetId is null", () => {
    resolvePresetForLaunch(null, { presetId: "user-saved" }, undefined, "claude", true);
    expect(getMergedPresetMock).not.toHaveBeenCalled();
  });
});

describe("saved default: presetId === undefined", () => {
  it("calls getMergedPreset with the saved entry.presetId", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch(undefined, { presetId: "user-111" }, undefined, "claude", true);
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-111",
      undefined,
      undefined,
      undefined
    );
  });

  it("returns the preset resolved from the saved ID", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    const result = resolvePresetForLaunch(
      undefined,
      { presetId: "user-111", customPresets: [CUSTOM_PRESET] },
      undefined,
      "claude",
      true
    );
    expect(result).toBe(CUSTOM_PRESET);
  });

  it("passes customPresets and ccrPresets to getMergedPreset", () => {
    getMergedPresetMock.mockReturnValue(CCR_PRESET);
    resolvePresetForLaunch(
      undefined,
      { presetId: "ccr-abc", customPresets: [CUSTOM_PRESET] },
      [CCR_PRESET],
      "claude",
      true
    );
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "ccr-abc",
      [CUSTOM_PRESET],
      [CCR_PRESET],
      undefined
    );
  });

  it("forwards projectPresets to getMergedPreset", () => {
    const PROJECT_PRESET: AgentPreset = {
      id: "team-opus",
      name: "Team Opus",
    };
    getMergedPresetMock.mockReturnValue(PROJECT_PRESET);
    resolvePresetForLaunch(undefined, { presetId: "team-opus" }, undefined, "claude", true, [
      PROJECT_PRESET,
    ]);
    expect(getMergedPresetMock).toHaveBeenCalledWith("claude", "team-opus", undefined, undefined, [
      PROJECT_PRESET,
    ]);
  });
});

describe("explicit preset ID provided (presetId is a string)", () => {
  it("calls getMergedPreset with the explicit ID, ignoring saved entry.presetId", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch("user-222", { presetId: "user-old" }, undefined, "claude", true);
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-222",
      undefined,
      undefined,
      undefined
    );
  });
});

describe("non-agent panels (isAgent === false)", () => {
  it("does NOT call getMergedPreset regardless of presetId", () => {
    resolvePresetForLaunch(undefined, { presetId: "user-111" }, undefined, "terminal", false);
    expect(getMergedPresetMock).not.toHaveBeenCalled();
  });

  it("always returns undefined for non-agent panels", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    const result = resolvePresetForLaunch(
      "user-111",
      { presetId: "user-111" },
      undefined,
      "terminal",
      false
    );
    expect(result).toBeUndefined();
  });
});

describe("stale preset handling: getMergedPreset returns undefined", () => {
  it("returns undefined when the saved presetId no longer exists", () => {
    getMergedPresetMock.mockReturnValue(undefined);
    const result = resolvePresetForLaunch(
      undefined,
      { presetId: "user-deleted" },
      undefined,
      "claude",
      true
    );
    expect(result).toBeUndefined();
  });
});

describe("worktree-scoped preset resolution", () => {
  it("worktree override wins over agent-level default", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch(
      undefined,
      { presetId: "user-global", worktreePresets: { "wt-A": "user-111" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-A"
    );
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-111",
      undefined,
      undefined,
      undefined
    );
  });

  it("falls back to agent-level default when no override exists for this worktree", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch(
      undefined,
      { presetId: "user-global", worktreePresets: { "wt-A": "user-111" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-B"
    );
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-global",
      undefined,
      undefined,
      undefined
    );
  });

  it("returns undefined when neither scope has a preset", () => {
    resolvePresetForLaunch(undefined, {}, undefined, "claude", true, undefined, "wt-A");
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it("null sentinel ignores both worktree override and agent-level default", () => {
    resolvePresetForLaunch(
      null,
      { presetId: "user-global", worktreePresets: { "wt-A": "user-111" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-A"
    );
    expect(getMergedPresetMock).not.toHaveBeenCalled();
  });

  it("explicit string presetId overrides both scopes", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch(
      "user-explicit",
      { presetId: "user-global", worktreePresets: { "wt-A": "user-111" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-A"
    );
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-explicit",
      undefined,
      undefined,
      undefined
    );
  });

  it("worktreeId of null/undefined disables scoped lookup", () => {
    getMergedPresetMock.mockReturnValue(CUSTOM_PRESET);
    resolvePresetForLaunch(
      undefined,
      { presetId: "user-global", worktreePresets: { "wt-A": "user-111" } },
      undefined,
      "claude",
      true,
      undefined,
      null
    );
    expect(getMergedPresetMock).toHaveBeenCalledWith(
      "claude",
      "user-global",
      undefined,
      undefined,
      undefined
    );
  });

  it("stale worktree override falls back to the agent-level default for the current launch", () => {
    getMergedPresetMock.mockImplementation((_agentId, presetId) =>
      presetId === "user-global" ? CUSTOM_PRESET : undefined
    );
    const result = resolvePresetForLaunch(
      undefined,
      { presetId: "user-global", worktreePresets: { "wt-A": "deleted-id" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-A"
    );
    expect(result).toBe(CUSTOM_PRESET);
  });

  it("returns undefined when both worktree override and agent default are stale", () => {
    getMergedPresetMock.mockReturnValue(undefined);
    const result = resolvePresetForLaunch(
      undefined,
      { presetId: "also-deleted", worktreePresets: { "wt-A": "deleted-id" } },
      undefined,
      "claude",
      true,
      undefined,
      "wt-A"
    );
    expect(result).toBeUndefined();
  });
});

describe("resolveEffectivePresetId helper", () => {
  it("returns worktree override when present", () => {
    expect(
      resolveEffectivePresetId(
        { presetId: "global", worktreePresets: { "wt-A": "scoped" } },
        "wt-A"
      )
    ).toBe("scoped");
  });

  it("falls back to agent-level default when no override for this worktree", () => {
    expect(
      resolveEffectivePresetId(
        { presetId: "global", worktreePresets: { "wt-A": "scoped" } },
        "wt-B"
      )
    ).toBe("global");
  });

  it("returns agent-level default when worktreeId is null", () => {
    expect(resolveEffectivePresetId({ presetId: "global" }, null)).toBe("global");
  });

  it("returns undefined for an empty entry", () => {
    expect(resolveEffectivePresetId({}, "wt-A")).toBeUndefined();
  });

  it("returns undefined when the entry itself is null", () => {
    expect(resolveEffectivePresetId(null, "wt-A")).toBeUndefined();
  });
});
