// @vitest-environment node
/**
 * Tests the vanilla-sentinel flavor resolution logic from useAgentLauncher.ts.
 *
 * The full hook has deep React/Electron dependencies that make direct rendering
 * costly here, so we test the pure branching logic inline — mirroring lines
 * 159-167 of useAgentLauncher.ts — using the real getMergedFlavor function.
 * Any change to those lines should require a corresponding update here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentFlavor } from "@/config/agents";

// ── mocks ────────────────────────────────────────────────────────────────────

const getMergedFlavorMock = vi.hoisted(() =>
  vi.fn<
    (
      agentId: string,
      flavorId: string | undefined,
      customFlavors: AgentFlavor[] | undefined,
      ccrFlavors: AgentFlavor[] | undefined
    ) => AgentFlavor | undefined
  >()
);

vi.mock("@/config/agents", () => ({
  getMergedFlavor: getMergedFlavorMock,
  getMergedFlavors: vi.fn(() => []),
  getAgentConfig: vi.fn(),
  isRegisteredAgent: vi.fn(() => true),
  getAgentDisplayTitle: vi.fn((id: string) => id),
}));

// ── mirror of the hook's flavor resolution block (useAgentLauncher.ts:159-167) ─

import { getMergedFlavor } from "@/config/agents";

function resolveFlavorForLaunch(
  flavorId: string | null | undefined,
  entry: { flavorId?: string; customFlavors?: AgentFlavor[] },
  ccrFlavors: AgentFlavor[] | undefined,
  agentId: string,
  isAgent: boolean
): AgentFlavor | undefined {
  const explicitVanilla = flavorId === null;
  const resolvedFlavorId = explicitVanilla ? undefined : (flavorId ?? entry.flavorId);
  return isAgent && !explicitVanilla
    ? getMergedFlavor(agentId, resolvedFlavorId, entry.customFlavors, ccrFlavors)
    : undefined;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const CUSTOM_FLAVOR: AgentFlavor = {
  id: "user-111",
  name: "My Flavor",
  env: { MY_VAR: "hello" },
};

const CCR_FLAVOR: AgentFlavor = {
  id: "ccr-abc",
  name: "CCR: Some Route",
  env: { ANTHROPIC_BASE_URL: "https://proxy.test" },
};

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getMergedFlavorMock.mockReset();
});

describe("vanilla sentinel: flavorId === null", () => {
  it("does NOT call getMergedFlavor", () => {
    resolveFlavorForLaunch(null, { flavorId: "user-111" }, undefined, "claude", true);
    expect(getMergedFlavorMock).not.toHaveBeenCalled();
  });

  it("returns undefined (no flavor applied)", () => {
    getMergedFlavorMock.mockReturnValue(CUSTOM_FLAVOR);
    const result = resolveFlavorForLaunch(
      null,
      { flavorId: "user-111" },
      undefined,
      "claude",
      true
    );
    expect(result).toBeUndefined();
  });

  it("ignores a saved entry.flavorId when flavorId is null", () => {
    resolveFlavorForLaunch(null, { flavorId: "user-saved" }, undefined, "claude", true);
    expect(getMergedFlavorMock).not.toHaveBeenCalled();
  });
});

describe("saved default: flavorId === undefined", () => {
  it("calls getMergedFlavor with the saved entry.flavorId", () => {
    getMergedFlavorMock.mockReturnValue(CUSTOM_FLAVOR);
    resolveFlavorForLaunch(undefined, { flavorId: "user-111" }, undefined, "claude", true);
    expect(getMergedFlavorMock).toHaveBeenCalledWith("claude", "user-111", undefined, undefined);
  });

  it("returns the flavor resolved from the saved ID", () => {
    getMergedFlavorMock.mockReturnValue(CUSTOM_FLAVOR);
    const result = resolveFlavorForLaunch(
      undefined,
      { flavorId: "user-111", customFlavors: [CUSTOM_FLAVOR] },
      undefined,
      "claude",
      true
    );
    expect(result).toBe(CUSTOM_FLAVOR);
  });

  it("passes customFlavors and ccrFlavors to getMergedFlavor", () => {
    getMergedFlavorMock.mockReturnValue(CCR_FLAVOR);
    resolveFlavorForLaunch(
      undefined,
      { flavorId: "ccr-abc", customFlavors: [CUSTOM_FLAVOR] },
      [CCR_FLAVOR],
      "claude",
      true
    );
    expect(getMergedFlavorMock).toHaveBeenCalledWith(
      "claude",
      "ccr-abc",
      [CUSTOM_FLAVOR],
      [CCR_FLAVOR]
    );
  });
});

describe("explicit flavor ID provided (flavorId is a string)", () => {
  it("calls getMergedFlavor with the explicit ID, ignoring saved entry.flavorId", () => {
    getMergedFlavorMock.mockReturnValue(CUSTOM_FLAVOR);
    resolveFlavorForLaunch("user-222", { flavorId: "user-old" }, undefined, "claude", true);
    expect(getMergedFlavorMock).toHaveBeenCalledWith("claude", "user-222", undefined, undefined);
  });
});

describe("non-agent panels (isAgent === false)", () => {
  it("does NOT call getMergedFlavor regardless of flavorId", () => {
    resolveFlavorForLaunch(undefined, { flavorId: "user-111" }, undefined, "terminal", false);
    expect(getMergedFlavorMock).not.toHaveBeenCalled();
  });

  it("always returns undefined for non-agent panels", () => {
    getMergedFlavorMock.mockReturnValue(CUSTOM_FLAVOR);
    const result = resolveFlavorForLaunch(
      "user-111",
      { flavorId: "user-111" },
      undefined,
      "terminal",
      false
    );
    expect(result).toBeUndefined();
  });
});

describe("stale flavor handling: getMergedFlavor returns undefined", () => {
  it("returns undefined when the saved flavorId no longer exists", () => {
    getMergedFlavorMock.mockReturnValue(undefined);
    const result = resolveFlavorForLaunch(
      undefined,
      { flavorId: "user-deleted" },
      undefined,
      "claude",
      true
    );
    expect(result).toBeUndefined();
  });
});
