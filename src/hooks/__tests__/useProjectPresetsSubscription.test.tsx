// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgentPreset } from "@shared/config/agentRegistry";

let mockCurrentProjectId: string | null = null;
const getInRepoPresetsMock = vi.fn<(projectId: string) => Promise<Record<string, AgentPreset[]>>>();

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({
      currentProject: mockCurrentProjectId ? { id: mockCurrentProjectId } : null,
    }),
}));

vi.mock("@/clients", () => ({
  projectClient: {
    getInRepoPresets: (projectId: string) => getInRepoPresetsMock(projectId),
  },
}));

import { useProjectPresetsSubscription } from "../useProjectPresetsSubscription";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

beforeEach(() => {
  mockCurrentProjectId = null;
  getInRepoPresetsMock.mockReset();
  useProjectPresetsStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useProjectPresetsSubscription", () => {
  it("resets the store when the current project becomes null", async () => {
    mockCurrentProjectId = "project-a";
    getInRepoPresetsMock.mockResolvedValueOnce({
      claude: [{ id: "team-a", name: "Team A" }],
    });

    const { rerender } = renderHook(() => useProjectPresetsSubscription());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useProjectPresetsStore.getState().presetsByAgent.claude).toBeDefined();

    mockCurrentProjectId = null;
    rerender();

    expect(useProjectPresetsStore.getState().presetsByAgent).toEqual({});
  });

  it("clears previous project's presets when the new project's load fails", async () => {
    mockCurrentProjectId = "project-a";
    getInRepoPresetsMock.mockResolvedValueOnce({
      claude: [{ id: "team-a", name: "Team A" }],
    });

    const { rerender } = renderHook(() => useProjectPresetsSubscription());
    await act(async () => {
      await Promise.resolve();
    });
    expect(useProjectPresetsStore.getState().presetsByAgent.claude?.[0]?.id).toBe("team-a");

    // Switch to project-b, and make its IPC fail.
    mockCurrentProjectId = "project-b";
    getInRepoPresetsMock.mockRejectedValueOnce(new Error("IPC failure"));
    // Silence the console.warn from the hook's catch block during this test.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useProjectPresetsStore.getState().presetsByAgent).toEqual({});
    warnSpy.mockRestore();
  });

  it("drops a stale response from the previous project", async () => {
    let resolveA: (v: Record<string, AgentPreset[]>) => void = () => {};
    const pendingA = new Promise<Record<string, AgentPreset[]>>((r) => {
      resolveA = r;
    });

    mockCurrentProjectId = "project-a";
    getInRepoPresetsMock.mockReturnValueOnce(pendingA);

    const { rerender } = renderHook(() => useProjectPresetsSubscription());

    // Switch to project-b before A resolves.
    mockCurrentProjectId = "project-b";
    getInRepoPresetsMock.mockResolvedValueOnce({
      claude: [{ id: "team-b", name: "Team B" }],
    });
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useProjectPresetsStore.getState().presetsByAgent.claude?.[0]?.id).toBe("team-b");

    // Now resolve A's stale request — must NOT overwrite B's state.
    await act(async () => {
      resolveA({ claude: [{ id: "team-a", name: "Team A" }] });
      await Promise.resolve();
    });
    expect(useProjectPresetsStore.getState().presetsByAgent.claude?.[0]?.id).toBe("team-b");
  });
});
