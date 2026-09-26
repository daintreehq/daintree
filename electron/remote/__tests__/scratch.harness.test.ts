import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-harness",
}));

vi.mock("../../store.js", async () => ({
  store: (await import("./harness/harnessState.js")).memoryStore,
}));

vi.mock("../../services/ProjectStore.js", async () => ({
  projectStore: (await import("./harness/harnessState.js")).memoryProjectStore,
}));

vi.mock("../../boot/hostServices.js", () => ({
  isWorkspaceClientStarting: () => false,
  ensureWorkspaceClient: async () => undefined,
}));

vi.mock("../host/hostCommands.js", async () => {
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    runCommand: async () => ({ code: 1, stdout: "", stderr: "not in the harness" }),
    spawnOwnedProcess: (file: string, args: readonly string[]) => {
      const record = { file, args, killed: false };
      harnessState.spawned.push(record);
      return { kill: () => (record.killed = true), onExit: () => undefined };
    },
  };
});

vi.mock("../client/initClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/initClient.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    ...original,
    initRemoteHostsClient: (...args: Parameters<typeof original.initRemoteHostsClient>) => {
      const client = original.initRemoteHostsClient(...args);
      harnessState.client = client;
      return client;
    },
  };
});

vi.mock("../../ipc/handlers/app/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/handlers/app/state.js")>()),
  readShellHydrateFields: () => ({ safeMode: false, crashCount: 0 }),
}));

vi.mock("../../services/PluginService.js", async () => ({
  pluginService: (await import("./harness/fakePluginService.js")).fakePluginService,
}));

/**
 * The host's scratch table, in memory over real folders. The real store is
 * SQLite behind Electron's native build, which this process can't load; the
 * handlers, the link and both splits around it are real.
 */
const scratches = vi.hoisted(() => ({
  root: "",
  rows: new Map<string, { id: string; name: string; path: string; lastOpened: number }>(),
}));
vi.mock("../../services/ScratchStore.js", () => ({
  scratchStore: {
    getAllScratches: () => [...scratches.rows.values()],
    getCurrentScratch: () => null,
    getScratchById: (id: string) => scratches.rows.get(id) ?? null,
    async createScratch(name?: string) {
      const id = crypto.randomUUID();
      const dir = path.join(scratches.root, id);
      await fs.mkdir(dir, { recursive: true });
      const row = { id, name: name ?? "Scratch", path: dir, lastOpened: Date.now() };
      scratches.rows.set(id, row);
      return row;
    },
    updateScratch(id: string, updates: { name?: string; lastOpened?: number }) {
      const row = scratches.rows.get(id);
      if (!row) throw new Error(`Scratch not found: ${id}`);
      Object.assign(row, updates);
      return { ...row };
    },
    setCurrentScratch: () => {
      throw new Error("a remote view must not move the host's current scratch");
    },
    removeScratch: async (id: string) => void scratches.rows.delete(id),
  },
}));

// Registering a project needs the real ProjectStore's git and settings
// machinery; the harness's host project list stands in for it.
vi.mock("../../ipc/handlers/projectCrud/crud.js", async () => {
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    addProjectByPath: async (projectPath: string) => {
      const project = {
        id: crypto.createHash("sha256").update(projectPath).digest("hex"),
        name: path.basename(projectPath),
        path: projectPath,
      };
      harnessState.projects.set(project.id, project);
      return project;
    },
  };
});

/**
 * The Shell's one window and its ProjectViewManager. Every other harness view
 * has no window; here a window is needed so a switch has something to rebind.
 * The fake manager keys views exactly as the real one does (host-scoped key)
 * and registers each new view where the webContents registry looks it up.
 */
const shellWindow = vi.hoisted(() => ({
  id: 1,
  isDestroyed: () => false,
  once: () => undefined,
}));
const pvmState = vi.hoisted(() => ({
  active: null as string | null,
  views: new Map<string, { webContents: unknown }>(),
  create: null as null | ((projectId: string) => { webContents: unknown }),
  focusIntents: [] as Array<[string, unknown]>,
}));
const fakePvm = vi.hoisted(() => ({
  async switchToHostProject(hostId: string, projectId: string, _projectPath: string) {
    const key = `${hostId}:${projectId}`;
    let view = pvmState.views.get(key);
    const isNew = !view;
    if (!view) {
      view = pvmState.create!(projectId);
      pvmState.views.set(key, view);
    }
    pvmState.active = key;
    return { view, isNew };
  },
  getActiveProjectId: () => pvmState.active,
  getActiveView: () => (pvmState.active ? (pvmState.views.get(pvmState.active) ?? null) : null),
  setPendingFocusIntent: (key: string, intent: unknown) =>
    pvmState.focusIntents.push([key, intent]),
}));

vi.mock("../../window/windowRef.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../window/windowRef.js")>()),
  getWindowRegistry: () => ({
    getByWindowId: (id: number) =>
      id === shellWindow.id
        ? {
            windowId: shellWindow.id,
            browserWindow: shellWindow,
            services: { projectViewManager: fakePvm },
          }
        : undefined,
  }),
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: (wc: { id: number } | null) =>
      wc && liveViews.has(wc.id) ? shellWindow : null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
    getAllAppWebContents: () => [],
    getWebContentsForProject: () => [],
    hasRegisteredProjectViews: () => false,
    isCachedViewWebContents: () => false,
    resolveLiveWebContents: (id: number) => liveViews.get(id)?.webContents ?? null,
    registerPortHolderWebContents: () => undefined,
    clearPortHolderWebContents: () => undefined,
    clearPortHolderWebContentsIfCurrent: () => undefined,
    getPortHolderWebContentsId: () => undefined,
  };
});

import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { Scratch } from "../../../shared/types/scratch.js";
import type { ScratchSaveAsProjectResult } from "../../../shared/types/ipc/scratch.js";
import { toHostScopedKey } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { registerScratchHandlers } from "../../ipc/handlers/scratch/index.js";
import type { HandlerDependencies } from "../../ipc/types.js";
import type { FakeView } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW_A = 11; // studio-01:proj-1
const SCRATCH_VIEW = 31; // what the window's manager creates for the scratch
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await h?.dispose();
  h = null;
  scratches.rows.clear();
  pvmState.active = null;
  pvmState.views.clear();
  pvmState.create = null;
  pvmState.focusIntents.length = 0;
});

function data<T>(envelope: IpcEnvelope): T {
  if (!envelope.ok) throw new Error(`call failed: ${envelope.error.message}`);
  return envelope.data as T;
}

function eventsOn(view: FakeView, channel: string): unknown[][] {
  return view.events.filter((event) => event.channel === channel).map((event) => event.args);
}

describe("scratch workspaces on a remote host (integration harness)", () => {
  it(
    "creates a scratch on the host, switches the window to it, and saves it as a host project",
    async () => {
      h = await startRemoteHarness();
      scratches.root = path.join(h.dir, "host-scratches");
      // The host's handlers, on this process's dispatcher where the link lands.
      cleanups.push(registerScratchHandlers({} as HandlerDependencies));
      const harness = h;
      pvmState.create = (projectId) => harness.addView(SCRATCH_VIEW, projectId);
      await h.connect();

      const viewA = h.addView(VIEW_A, "proj-1");
      pvmState.views.set(toHostScopedKey(HOST_ID, "proj-1"), viewA);
      pvmState.active = toHostScopedKey(HOST_ID, "proj-1");

      // Create, from the remote view, on the host.
      const created = data<Scratch>(await h.invoke(CHANNELS.SCRATCH_CREATE, viewA, "Spike"));
      expect(path.dirname(created.path)).toBe(scratches.root);
      await expect(fs.stat(created.path)).resolves.toBeTruthy();
      await waitUntil(
        () =>
          eventsOn(viewA, CHANNELS.SCRATCH_UPDATED).some(
            ([row]) => (row as Scratch).id === created.id
          ),
        "the host's scratch:updated to reach the view"
      );
      const listed = data<Scratch[]>(await h.invoke(CHANNELS.SCRATCH_GET_ALL, viewA));
      expect(listed.map((row) => row.id)).toContain(created.id);

      // Switch: the host confirms, the window's view rebinds to the host-scoped key.
      const focusIntent = { intent: "focus-panel", panelId: "t1" };
      const switched = data<Scratch>(
        await h.invoke(CHANNELS.SCRATCH_SWITCH, viewA, created.id, { focusIntent })
      );
      expect(switched.id).toBe(created.id);
      const scratchKey = toHostScopedKey(HOST_ID, created.id);
      expect(pvmState.active).toBe(scratchKey);
      expect(pvmState.focusIntents).toEqual([[scratchKey, focusIntent]]);
      expect(harnessState.client!.hostForView(SCRATCH_VIEW)).toBe(HOST_ID);

      const scratchView = pvmState.views.get(scratchKey) as FakeView | undefined;
      expect(scratchView?.id).toBe(SCRATCH_VIEW);
      const onSwitch = eventsOn(scratchView!, CHANNELS.SCRATCH_ON_SWITCH);
      expect(onSwitch).toHaveLength(1);
      expect(onSwitch[0]![0]).toMatchObject({
        scratch: { id: created.id, path: created.path },
        switchId: expect.any(String),
      });
      // Only the view it landed on is told.
      expect(eventsOn(viewA, CHANNELS.SCRATCH_ON_SWITCH)).toHaveLength(0);

      // The new view's endpoint on the host is bound to the scratch.
      const current = data<Scratch | null>(
        await h.invoke(CHANNELS.SCRATCH_GET_CURRENT, scratchView!)
      );
      expect(current?.id).toBe(created.id);
      await fs.writeFile(path.join(created.path, "notes.md"), "kept");

      // Save as project: the folder is chosen in the view's host picker.
      const parent = path.join(h.dir, "host-work");
      await fs.mkdir(parent, { recursive: true });
      const saving = h.invoke(CHANNELS.SCRATCH_SAVE_AS_PROJECT, scratchView!, created.id);
      await waitUntil(
        () =>
          eventsOn(scratchView!, CHANNELS.FILE_TRANSFER_EVENT).some(
            ([event]) => (event as { type?: string }).type === "host-pick-request"
          ),
        "the host picker request to reach the view"
      );
      const pickRequest = eventsOn(scratchView!, CHANNELS.FILE_TRANSFER_EVENT)
        .map(([event]) => event as { type: string; requestId: string })
        .find((event) => event.type === "host-pick-request")!;
      data(
        await h.invoke(CHANNELS.FILE_TRANSFER_ANSWER_HOST_PICK, scratchView!, {
          requestId: pickRequest.requestId,
          paths: [parent],
        })
      );
      const result = data<ScratchSaveAsProjectResult>(await saving);
      if (result.status !== "saved") throw new Error("expected the scratch to be saved");
      expect(result.destinationPath).toBe(path.join(parent, "Spike"));
      await expect(fs.readFile(path.join(parent, "Spike", "notes.md"), "utf8")).resolves.toBe(
        "kept"
      );
      await expect(fs.stat(path.join(parent, "Spike", ".git"))).resolves.toBeTruthy();

      // Registered on the host, as the host itself describes it over the link.
      const connection = h.manager.get(HOST_ID)!;
      await expect(connection.describeProject(result.project.id)).resolves.toMatchObject({
        projectId: result.project.id,
        path: path.join(parent, "Spike"),
      });
      const hostProjects = await connection.listProjects();
      expect(hostProjects.map((project) => project.id)).toContain(result.project.id);
      // The window stays on that host, on the scratch it saved.
      expect(pvmState.active).toBe(scratchKey);
      expect(harnessState.client!.hostForView(SCRATCH_VIEW)).toBe(HOST_ID);
    },
    TEST_TIMEOUT_MS
  );
});
