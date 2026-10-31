// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "@/types";

const { disk, projectState } = vi.hoisted(() => {
  const project = {
    id: "proj-1",
    name: "Test Project",
    emoji: "🌲",
    color: undefined as string | undefined,
    path: "/test",
  };
  return {
    disk: new Map<string, ProjectSettings>(),
    projectState: {
      currentProject: project,
      projects: [project],
      updateProject: vi.fn().mockResolvedValue(undefined),
      enableInRepoSettings: vi.fn(),
      disableInRepoSettings: vi.fn(),
    },
  };
});

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

vi.mock("@/lib/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify")>()),
  notify: vi.fn(),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({ worktrees: [], worktreeMap: new Map() }),
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: () => ({ recipes: [], isLoading: false }),
}));

import { projectClient } from "@/clients";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { ActionCallbacks, ActionRegistry } from "@/services/actions/actionTypes";
import { registerProjectActions } from "@/services/actions/definitions/projectActions";
import { registerEnvActions } from "@/services/actions/definitions/envActions";
import { useProjectSettingsForm } from "../useProjectSettingsForm";

const PROJECT_ID = "proj-1";

const storedSettings: ProjectSettings = {
  runCommands: [{ id: "rc-1", name: "Dev", command: "npm run dev" }],
  environmentVariables: { NODE_ENV: "development" },
  devServerCommand: "npm run dev",
  notificationOverrides: { soundEnabled: true },
};

function stored(): ProjectSettings {
  return disk.get(PROJECT_ID)!;
}

async function runAction(id: string, args: unknown): Promise<void> {
  const actions: ActionRegistry = new Map();
  const callbacks = { onOpenProjectSwitcherPalette: vi.fn() } as unknown as ActionCallbacks;
  registerProjectActions(actions, callbacks);
  registerEnvActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`${id} is not registered`);
  await act(async () => {
    await factory().run(args, {} as never);
  });
}

// McpActivityTracker.alwaysAllowTier: a disk-only read-modify-write.
async function setProjectDefaultTier(tier: "core" | "full"): Promise<void> {
  const settings = await projectClient.getSettings(PROJECT_ID);
  await projectClient.saveSettings(PROJECT_ID, { ...settings, daintreeMcpTier: tier });
}

// The view loads the project's settings when it starts, long before Settings opens.
async function renderClosedForm() {
  const hook = renderHook(
    ({ isOpen }: { isOpen: boolean }) => useProjectSettingsForm({ projectId: PROJECT_ID, isOpen }),
    { initialProps: { isOpen: false } }
  );
  await waitFor(() => {
    expect(useProjectSettingsStore.getState().settings).not.toBeNull();
  });
  return hook;
}

async function openForm(hook: Awaited<ReturnType<typeof renderClosedForm>>) {
  hook.rerender({ isOpen: true });
  await waitFor(() => {
    expect(hook.result.current.projectIsInitialized).toBe(true);
  });
}

async function editDevServerCommandAndClose(hook: Awaited<ReturnType<typeof renderClosedForm>>) {
  act(() => {
    hook.result.current.setDevServerCommand("npm start");
  });
  await act(async () => {
    await hook.result.current.flush();
  });
  expect(stored().devServerCommand).toBe("npm start");
}

describe("useProjectSettingsForm with settings written outside the form (#15573)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disk.clear();
    disk.set(PROJECT_ID, JSON.parse(JSON.stringify(storedSettings)));
    useProjectSettingsStore.getState().reset();
  });

  it("opens on a tier set with Set project default and keeps it through an unrelated edit", async () => {
    const hook = await renderClosedForm();
    await setProjectDefaultTier("full");

    await openForm(hook);
    expect(hook.result.current.daintreeMcpTier).toBe("full");

    await editDevServerCommandAndClose(hook);
    expect(stored().daintreeMcpTier).toBe("full");
  });

  it("opens on a kind silenced from a toast and keeps it through an unrelated edit", async () => {
    const hook = await renderClosedForm();
    await runAction("project.silenceNotificationKind", {
      kind: "waiting",
      projectId: PROJECT_ID,
    });

    await openForm(hook);
    expect(hook.result.current.notificationOverrides).toEqual({
      soundEnabled: true,
      waitingEnabled: false,
    });

    await editDevServerCommandAndClose(hook);
    expect(stored().notificationOverrides).toEqual({ soundEnabled: true, waitingEnabled: false });
  });

  it("keeps project notifications muted from a toast while the dialog is open", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await runAction("project.muteNotifications", { projectId: PROJECT_ID });

    await editDevServerCommandAndClose(hook);
    expect(stored().notificationOverrides).toEqual({
      soundEnabled: true,
      completedEnabled: false,
      waitingEnabled: false,
    });
  });

  it("keeps a kind silenced from a toast while the dialog is open", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await runAction("project.silenceNotificationKind", {
      kind: "completed",
      projectId: PROJECT_ID,
    });

    await editDevServerCommandAndClose(hook);
    expect(stored().notificationOverrides).toEqual({ soundEnabled: true, completedEnabled: false });
  });

  it("keeps environment variables and resource environments set by actions while the dialog is open", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await runAction("env.project.set", {
      projectId: PROJECT_ID,
      variables: { API_URL: "http://localhost:4000" },
    });
    await runAction("worktree.resource.config.set", {
      projectId: PROJECT_ID,
      resourceEnvironments: { docker: { provision: ["docker compose up -d"] } },
    });

    await editDevServerCommandAndClose(hook);
    expect(stored().environmentVariables).toEqual({
      NODE_ENV: "development",
      API_URL: "http://localhost:4000",
    });
    expect(stored().resourceEnvironments).toEqual({
      docker: { provision: ["docker compose up -d"] },
    });
  });

  it("lets the user's edit win a field another writer changed while the dialog was open", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await setProjectDefaultTier("full");
    await runAction("project.silenceNotificationKind", {
      kind: "completed",
      projectId: PROJECT_ID,
    });

    act(() => {
      hook.result.current.setDaintreeMcpTier("core");
    });
    await act(async () => {
      await hook.result.current.flush();
    });

    expect(stored().daintreeMcpTier).toBe("core");
    expect(stored().notificationOverrides).toEqual({ soundEnabled: true, completedEnabled: false });
  });

  it("merges notification overrides and environment variables key by key", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await runAction("project.muteNotifications", { projectId: PROJECT_ID });
    await runAction("env.project.set", {
      projectId: PROJECT_ID,
      variables: { API_URL: "http://localhost:4000", NODE_ENV: "test" },
    });

    act(() => {
      hook.result.current.setNotificationOverrides({
        ...hook.result.current.notificationOverrides,
        completedEnabled: true,
      });
      hook.result.current.setEnvironmentVariables([
        ...hook.result.current.environmentVariables,
        { id: "env-new", key: "DEBUG", value: "1" },
      ]);
    });
    await act(async () => {
      await hook.result.current.flush();
    });

    // The user's toggle wins its own key; the mute's other key and the
    // action's variables, including the one the user left alone, survive.
    expect(stored().notificationOverrides).toEqual({
      soundEnabled: true,
      completedEnabled: true,
      waitingEnabled: false,
    });
    expect(stored().environmentVariables).toEqual({
      NODE_ENV: "test",
      API_URL: "http://localhost:4000",
      DEBUG: "1",
    });
  });

  it("removes a variable the user deletes without dropping ones added elsewhere", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);

    await runAction("env.project.set", {
      projectId: PROJECT_ID,
      variables: { API_URL: "http://localhost:4000" },
    });

    act(() => {
      hook.result.current.setEnvironmentVariables([]);
    });
    await act(async () => {
      await hook.result.current.flush();
    });

    expect(stored().environmentVariables).toEqual({ API_URL: "http://localhost:4000" });
  });

  it("passes secure variables main couldn't read through an unrelated edit", async () => {
    disk.set(PROJECT_ID, {
      ...JSON.parse(JSON.stringify(storedSettings)),
      secureEnvironmentVariables: ["API_TOKEN"],
      unresolvedSecureEnvironmentVariables: ["API_TOKEN"],
    });
    const hook = await renderClosedForm();
    await openForm(hook);

    await editDevServerCommandAndClose(hook);
    // Main keeps a secure key it couldn't decrypt only while a save names it.
    expect(stored().unresolvedSecureEnvironmentVariables).toEqual(["API_TOKEN"]);
  });

  it("waits for a successful read before seeding when the read on open fails", async () => {
    const hook = await renderClosedForm();
    await setProjectDefaultTier("full");
    vi.mocked(projectClient.getSettings).mockRejectedValueOnce(new Error("disk unavailable"));

    hook.rerender({ isOpen: true });
    await waitFor(() => {
      expect(hook.result.current.projectError).not.toBeNull();
    });
    expect(hook.result.current.projectIsInitialized).toBe(false);

    await act(async () => {
      await hook.result.current.refreshProjectSettings();
    });
    await waitFor(() => {
      expect(hook.result.current.projectIsInitialized).toBe(true);
    });
    expect(hook.result.current.daintreeMcpTier).toBe("full");
  });

  it("writes nothing when an untouched dialog closes", async () => {
    const hook = await renderClosedForm();
    await openForm(hook);
    await setProjectDefaultTier("full");
    const writesBefore = vi.mocked(projectClient.saveSettings).mock.calls.length;

    await act(async () => {
      await hook.result.current.flush();
    });

    expect(vi.mocked(projectClient.saveSettings).mock.calls.length).toBe(writesBefore);
    expect(stored().daintreeMcpTier).toBe("full");
  });
});
