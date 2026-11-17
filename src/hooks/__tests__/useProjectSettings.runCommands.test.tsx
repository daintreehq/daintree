// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings, RunCommand } from "@/types";

const { disk, projectState } = vi.hoisted(() => ({
  disk: new Map<string, ProjectSettings>(),
  projectState: {
    currentProject: { id: "proj-1" } as { id: string } | null,
  },
}));

// Main's settings file. Reads and writes go through JSON, as they do over IPC,
// so nothing the renderer holds aliases what is stored.
vi.mock("@/clients", () => ({
  projectClient: {
    getSettings: vi.fn(async (projectId: string) =>
      JSON.parse(JSON.stringify(disk.get(projectId) ?? { runCommands: [] }))
    ),
    saveSettings: vi.fn(async (projectId: string, settings: ProjectSettings) => {
      disk.set(projectId, JSON.parse(JSON.stringify(settings)));
    }),
    detectRunners: vi.fn(async () => []),
  },
}));

vi.mock("@/store/projectStore", () => {
  const useProjectStore = Object.assign(
    (selector?: (state: typeof projectState) => unknown) =>
      selector ? selector(projectState) : projectState,
    { getState: () => projectState }
  );
  return { useProjectStore };
});

import { projectClient } from "@/clients";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useProjectSettings } from "../useProjectSettings";

const PROJECT_ID = "proj-1";
const OTHER_PROJECT_ID = "proj-2";
const THIRD_PROJECT_ID = "proj-3";

const dev: RunCommand = { id: "rc-1", name: "Dev", command: "npm run dev" };
const test: RunCommand = { id: "rc-2", name: "Test", command: "npm test" };
const lint: RunCommand = { id: "rc-3", name: "Lint", command: "npm run lint" };

function stored(projectId = PROJECT_ID): ProjectSettings {
  return disk.get(projectId)!;
}

function commandsOnDisk(projectId = PROJECT_ID): string[] {
  return stored(projectId).runCommands.map((c) => c.command);
}

// McpActivityTracker.alwaysAllowTier and saves from another window: disk-only
// read-modify-writes that never touch useProjectSettingsStore.
async function writeOutOfBand(projectId: string, patch: Partial<ProjectSettings>): Promise<void> {
  const settings = await projectClient.getSettings(projectId);
  await projectClient.saveSettings(projectId, { ...settings, ...patch });
}

async function renderCurrentProject() {
  const hook = renderHook(() => useProjectSettings());
  await waitFor(() => {
    expect(hook.result.current.settings).not.toBeNull();
  });
  return hook;
}

async function renderOtherProject() {
  const hook = renderHook(() => useProjectSettings(OTHER_PROJECT_ID));
  await waitFor(() => {
    expect(hook.result.current.settings).not.toBeNull();
  });
  return hook;
}

describe("useProjectSettings pin and unpin beside other settings writers (#17199)", () => {
  beforeEach(() => {
    disk.clear();
    disk.set(PROJECT_ID, { runCommands: [dev], devServerCommand: "npm run dev" });
    disk.set(OTHER_PROJECT_ID, { runCommands: [dev] });
    disk.set(THIRD_PROJECT_ID, { runCommands: [lint] });
    projectState.currentProject = { id: PROJECT_ID };
    vi.clearAllMocks();
    vi.mocked(projectClient.detectRunners).mockResolvedValue([]);
    useProjectSettingsStore.getState().reset();
  });

  it("keeps fields saved out of band after the store loaded when pinning", async () => {
    const { result } = await renderCurrentProject();
    await writeOutOfBand(PROJECT_ID, {
      daintreeMcpTier: "full",
      preferredImageViewer: { mode: "custom", customCommand: "open -a Preview" },
      devServerCommand: undefined,
    });

    await act(async () => {
      await result.current.promoteToSaved(test);
    });

    expect(stored()).toMatchObject({
      daintreeMcpTier: "full",
      preferredImageViewer: { mode: "custom", customCommand: "open -a Preview" },
    });
    expect(stored().devServerCommand).toBeUndefined();
    expect(commandsOnDisk()).toEqual(["npm run dev", "npm test"]);
    expect(useProjectSettingsStore.getState().settings).toMatchObject({
      daintreeMcpTier: "full",
      preferredImageViewer: { mode: "custom", customCommand: "open -a Preview" },
    });
    expect(useProjectSettingsStore.getState().settings?.devServerCommand).toBeUndefined();
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run dev",
      "npm test",
    ]);
  });

  it("keeps fields saved out of band after the store loaded when unpinning", async () => {
    const { result } = await renderCurrentProject();
    await writeOutOfBand(PROJECT_ID, { daintreeMcpTier: "full" });

    await act(async () => {
      await result.current.removeFromSaved(dev.command);
    });

    expect(stored().daintreeMcpTier).toBe("full");
    expect(commandsOnDisk()).toEqual([]);
    expect(result.current.settings?.runCommands).toEqual([]);
  });

  it("lands every pin and unpin made back to back", async () => {
    const { result } = await renderCurrentProject();
    const { promoteToSaved, removeFromSaved } = result.current;

    await act(async () => {
      await Promise.all([promoteToSaved(test), promoteToSaved(lint), removeFromSaved(dev.command)]);
    });

    expect(commandsOnDisk()).toEqual(["npm test", "npm run lint"]);
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm test",
      "npm run lint",
    ]);
  });

  it("does not pin a command twice when a back-to-back pin already saved it", async () => {
    const { result } = await renderCurrentProject();
    const { promoteToSaved } = result.current;

    await act(async () => {
      await Promise.all([promoteToSaved(test), promoteToSaved(test)]);
    });

    expect(commandsOnDisk()).toEqual(["npm run dev", "npm test"]);
  });

  it("keeps fields saved out of band when pinning for a project other than the current one", async () => {
    vi.mocked(projectClient.detectRunners).mockResolvedValue([dev, test, lint]);
    const { result } = await renderOtherProject();
    expect(result.current.detectedRunners).toEqual([test, lint]);
    await writeOutOfBand(OTHER_PROJECT_ID, { daintreeMcpTier: "core" });

    await act(async () => {
      await Promise.all([result.current.promoteToSaved(test), result.current.promoteToSaved(lint)]);
    });

    expect(stored(OTHER_PROJECT_ID).daintreeMcpTier).toBe("core");
    expect(commandsOnDisk(OTHER_PROJECT_ID)).toEqual(["npm run dev", "npm test", "npm run lint"]);
    expect(result.current.settings?.daintreeMcpTier).toBe("core");
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run dev",
      "npm test",
      "npm run lint",
    ]);
    expect(result.current.detectedRunners).toEqual([]);

    await act(async () => {
      await result.current.removeFromSaved(dev.command);
    });

    expect(result.current.detectedRunners).toEqual([dev]);
    expect(result.current.allDetectedRunners).toEqual([dev, test, lint]);
  });

  it("finishes a pin for the project it started on without showing it on the next one", async () => {
    const hook = renderHook(({ projectId }) => useProjectSettings(projectId), {
      initialProps: { projectId: OTHER_PROJECT_ID },
    });
    await waitFor(() => {
      expect(hook.result.current.settings).not.toBeNull();
    });

    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
    vi.mocked(projectClient.saveSettings).mockImplementationOnce(async (projectId, settings) => {
      await saveHeld;
      disk.set(projectId, JSON.parse(JSON.stringify(settings)));
    });

    let pinning!: Promise<void>;
    try {
      act(() => {
        pinning = hook.result.current.promoteToSaved(test);
      });
      await waitFor(() => {
        expect(projectClient.saveSettings).toHaveBeenCalled();
      });

      hook.rerender({ projectId: THIRD_PROJECT_ID });
      await waitFor(() => {
        expect(hook.result.current.settings?.runCommands.map((c) => c.command)).toEqual([
          "npm run lint",
        ]);
      });
    } finally {
      // The write queue outlives this test: a held save would block the next one.
      releaseSave();
    }

    await act(async () => {
      await pinning;
    });

    expect(commandsOnDisk(OTHER_PROJECT_ID)).toEqual(["npm run dev", "npm test"]);
    expect(commandsOnDisk(THIRD_PROJECT_ID)).toEqual(["npm run lint"]);
    expect(hook.result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run lint",
    ]);
  });

  it("pins and unpins against what is saved, not what this view last loaded", async () => {
    const { result } = await renderCurrentProject();
    await writeOutOfBand(PROJECT_ID, { runCommands: [dev, test] });
    vi.mocked(projectClient.saveSettings).mockClear();

    await act(async () => {
      await result.current.promoteToSaved(test);
    });

    expect(projectClient.saveSettings).not.toHaveBeenCalled();
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run dev",
      "npm test",
    ]);

    await writeOutOfBand(PROJECT_ID, { runCommands: [test] });
    vi.mocked(projectClient.saveSettings).mockClear();

    await act(async () => {
      await result.current.removeFromSaved(dev.command);
    });

    expect(projectClient.saveSettings).not.toHaveBeenCalled();
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual(["npm test"]);

    await act(async () => {
      await result.current.removeFromSaved(test.command);
    });

    expect(commandsOnDisk()).toEqual([]);
  });

  it("rejects a pin whose read failed without blocking the next one or saving the cache", async () => {
    const { result } = await renderCurrentProject();
    vi.mocked(projectClient.getSettings).mockRejectedValueOnce(new Error("EACCES"));
    const { promoteToSaved } = result.current;

    let failed: unknown;
    await act(async () => {
      const results = await Promise.allSettled([promoteToSaved(test), promoteToSaved(lint)]);
      failed = results[0].status === "rejected" ? results[0].reason : undefined;
    });

    expect(failed).toBeInstanceOf(Error);
    expect(commandsOnDisk()).toEqual(["npm run dev", "npm run lint"]);
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run dev",
      "npm run lint",
    ]);
  });

  it("rejects a pin whose save failed and publishes nothing from it", async () => {
    const { result } = await renderCurrentProject();
    vi.mocked(projectClient.saveSettings).mockRejectedValueOnce(new Error("ENOSPC"));
    const { promoteToSaved } = result.current;

    let failed: unknown;
    await act(async () => {
      const results = await Promise.allSettled([promoteToSaved(test), promoteToSaved(lint)]);
      failed = results[0].status === "rejected" ? results[0].reason : undefined;
    });

    expect((failed as Error).message).toBe("ENOSPC");
    expect(commandsOnDisk()).toEqual(["npm run dev", "npm run lint"]);
    expect(result.current.settings?.runCommands.map((c) => c.command)).toEqual([
      "npm run dev",
      "npm run lint",
    ]);
  });
});
