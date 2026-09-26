import crypto from "node:crypto";
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

vi.mock("../terminal/TerminalStreamBridge.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../terminal/TerminalStreamBridge.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  class ObservedTerminalStreamBridge extends original.TerminalStreamBridge {
    constructor(options: ConstructorParameters<typeof original.TerminalStreamBridge>[0]) {
      super(options);
      harnessState.bridges.set(options.endpointId, this);
    }
  }
  return { ...original, TerminalStreamBridge: ObservedTerminalStreamBridge };
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

vi.mock("../../services/getSoundService.js", () => ({
  getSoundService: async () => ({ play: () => undefined }),
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: () => null,
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
import type { OperationOutcome } from "../../../shared/types/remoteHosts.js";
import type { WorktreeCreateResult } from "../../../shared/types/worktree.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import { CHANNELS } from "../../ipc/channels.js";
import { registerTerminalLayoutHandlers } from "../../ipc/handlers/terminalLayout.js";
import { registerWorktreeLifecycleHandlers } from "../../ipc/handlers/worktree/lifecycle.js";
import type { HandlerDependencies } from "../../ipc/types.js";
import type { WorkspaceClient } from "../../services/WorkspaceClient.js";
import { getOperationRegistry } from "../../services/operations/index.js";
import type { FakeView } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW_A = 11; // studio-01:proj-1, the first to attach: it drives
const VIEW_B = 12; // studio-01:proj-1, a second frontend on the same project
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
});

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

function errorCode(envelope: IpcEnvelope): string | null {
  return envelope.ok ? null : (envelope.error.code ?? null);
}

/**
 * The host's worktree service behind the real `worktree:create` handler. Each
 * create waits for `release` when one is armed, so a test can drop the link
 * while it is under way.
 */
/** The host's settings the real create handler reads after creating. */
function quietHost(): void {
  harnessState.store.set("notificationSettings", { uiFeedbackSoundEnabled: false });
}

function fakeWorktreeService() {
  quietHost();
  const creates: Array<{ rootPath: string; newBranch: string }> = [];
  const gate: { hold: Promise<void> | null } = { hold: null };
  const service = {
    async createWorktree(rootPath: string, options: { newBranch: string }) {
      creates.push({ rootPath, newBranch: options.newBranch });
      if (gate.hold) await gate.hold;
      return {
        worktreeId: path.join(rootPath, "..", `wt-${options.newBranch}`),
        branch: options.newBranch,
        setupState: "pending",
      } satisfies WorktreeCreateResult;
    },
    invalidatePulseCache: () => undefined,
  };
  return { service, creates, gate };
}

function createPayload(r: RemoteHarness, branch: string, opId?: string) {
  const rootPath = r.projects.get("proj-1")!.path;
  return {
    rootPath,
    options: { baseBranch: "main", newBranch: branch, path: path.join(rootPath, "..", branch) },
    ...(opId !== undefined ? { opId } : {}),
  };
}

async function twoFrontends(r: RemoteHarness): Promise<{ a: FakeView; b: FakeView }> {
  const a = r.addView(VIEW_A, "proj-1");
  await r.openStreams(a);
  const b = r.addView(VIEW_B, "proj-1");
  await r.openStreams(b);
  const leaseOf = async (view: FakeView) =>
    unwrap<{ isHolderEndpoint: boolean }>(
      await r.invoke(CHANNELS.DRIVE_LEASE_GET, view, { projectId: "proj-1" })
    );
  expect((await leaseOf(a)).isHolderEndpoint).toBe(true);
  expect((await leaseOf(b)).isHolderEndpoint).toBe(false);
  return { a, b };
}

describe("drive lease, operation outcomes and state after takeover (integration harness)", () => {
  it(
    "lease: a displaced frontend's project mutations are refused; after it takes over, it drives and the old driver is refused",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      const worktrees = fakeWorktreeService();
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: worktrees.service as unknown as WorkspaceClient,
        } as HandlerDependencies)
      );
      const { a, b } = await twoFrontends(r);

      const refused = await r.invoke(CHANNELS.WORKTREE_CREATE, b, createPayload(r, "from-b"));
      expect(errorCode(refused)).toBe("DRIVEN_ELSEWHERE");
      expect(refused.ok ? "" : refused.error.userMessage).toContain("Take it over first");
      expect(worktrees.creates).toEqual([]);
      // Reads stay open to it: it still sees the project.
      expect((await r.invoke(CHANNELS.OPERATIONS_LIST, b, { projectId: "proj-1" })).ok).toBe(true);

      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, b, { projectId: "proj-1" }));
      const created = unwrap<WorktreeCreateResult>(
        await r.invoke(CHANNELS.WORKTREE_CREATE, b, createPayload(r, "from-b"))
      );
      expect(created.branch).toBe("from-b");
      expect(worktrees.creates.map((c) => c.newBranch)).toEqual(["from-b"]);

      const displaced = await r.invoke(CHANNELS.WORKTREE_CREATE, a, createPayload(r, "from-a"));
      expect(errorCode(displaced)).toBe("DRIVEN_ELSEWHERE");
      expect(worktrees.creates.map((c) => c.newBranch)).toEqual(["from-b"]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "operation outcome: a worktree create whose answer was lost resolves by its id over the reconnected link, and a retry doesn't create twice",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      const worktrees = fakeWorktreeService();
      let release!: () => void;
      worktrees.gate.hold = new Promise<void>((resolve) => (release = resolve));
      cleanups.push(
        registerWorktreeLifecycleHandlers({
          worktreeService: worktrees.service as unknown as WorkspaceClient,
        } as HandlerDependencies)
      );
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      const opId = `op-${crypto.randomUUID()}`;
      const reply = r.invoke(CHANNELS.WORKTREE_CREATE, view, createPayload(r, "feature-x", opId));
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "running",
        "the create to start on the host"
      );
      // Progress goes to the operation, where a reconnecting client can read it.
      await waitUntil(() => {
        const outcome = getOperationRegistry().get(opId)?.outcome;
        return outcome?.status === "running" && outcome.progress?.stage === "creating";
      }, "the create's progress on its operation");
      expect(getOperationRegistry().get(opId)).toMatchObject({
        kind: "worktree-create",
        projectId: "proj-1",
      });

      await r.dropLink();
      const lost = await reply;
      expect(["HOST_DISCONNECTED", "OUTCOME_UNKNOWN"]).toContain(errorCode(lost));

      release();
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "succeeded",
        "the create to finish on the host"
      );

      // The renderer's own recovery path, fed by this view's link.
      const modulePath = "../../../src/utils/resolveUnknownOutcome.ts";
      const { resolveUnknownOutcome } = (await import(/* @vite-ignore */ modulePath)) as {
        resolveUnknownOutcome: (
          opId: string,
          options: Record<string, unknown>
        ) => Promise<OperationOutcome>;
      };
      const restored = r.restoreLink();
      const outcome = await resolveUnknownOutcome(opId, {
        waitForConnected: () => restored,
        pollIntervalMs: 20,
        settleTimeoutMs: 10_000,
        client: {
          getStatus: async (id: string) =>
            unwrap<OperationOutcome>(
              await r.invoke(CHANNELS.OPERATIONS_GET_STATUS, view, { opId: id })
            ),
          onEvent: () => () => undefined,
        },
      });
      const expected = {
        worktreeId: path.join(r.projects.get("proj-1")!.path, "..", "wt-feature-x"),
        branch: "feature-x",
        setupState: "pending",
      };
      expect(outcome).toEqual({
        status: "succeeded",
        result: expected,
        settledAt: expect.any(Number),
      });

      // A retry under the same id is answered from the host's record.
      const again = await r.invoke(
        CHANNELS.WORKTREE_CREATE,
        view,
        createPayload(r, "feature-x", opId)
      );
      expect(again).toEqual(wrapSuccess(expected));
      expect(worktrees.creates).toHaveLength(1);
      // The same id for a different create is refused, never answered with this one.
      const reused = await r.invoke(
        CHANNELS.WORKTREE_CREATE,
        view,
        createPayload(r, "feature-y", opId)
      );
      expect(reused.ok).toBe(false);
      expect(worktrees.creates).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "takeover: the host keeps the driver's saved layout and drafts against a displaced frontend's writes, and hands them to whoever takes over",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      cleanups.push(registerTerminalLayoutHandlers({} as HandlerDependencies));
      const { a, b } = await twoFrontends(r);

      const driverLayout = [
        {
          id: "browser-1",
          kind: "browser",
          title: "Preview",
          location: "grid",
          browserUrl: "http://localhost:3000",
        },
        {
          id: "browser-2",
          kind: "browser",
          title: "Docs",
          location: "grid",
          browserUrl: "http://localhost:4000",
        },
      ];
      const driverGroups = [
        {
          id: "g1",
          location: "grid",
          panelIds: ["browser-1", "browser-2"],
          activeTabId: "browser-2",
        },
      ];
      unwrap(
        await r.invoke(CHANNELS.PROJECT_SET_TERMINALS, a, {
          projectId: "proj-1",
          terminals: driverLayout,
        })
      );
      unwrap(
        await r.invoke(CHANNELS.PROJECT_SET_TAB_GROUPS, a, {
          projectId: "proj-1",
          tabGroups: driverGroups,
        })
      );
      unwrap(
        await r.invoke(CHANNELS.PROJECT_SET_DRAFT_INPUTS, a, {
          projectId: "proj-1",
          draftInputs: { t1: "half a prompt" },
        })
      );

      // The displaced frontend's stale layout never lands on the host.
      for (const [channel, payload] of [
        [CHANNELS.PROJECT_SET_TERMINALS, { projectId: "proj-1", terminals: [] }],
        [CHANNELS.PROJECT_SET_TAB_GROUPS, { projectId: "proj-1", tabGroups: [] }],
        [CHANNELS.PROJECT_SET_DRAFT_INPUTS, { projectId: "proj-1", draftInputs: {} }],
      ] as const) {
        expect(errorCode(await r.invoke(channel, b, payload)), channel).toBe("DRIVEN_ELSEWHERE");
      }

      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, b, { projectId: "proj-1" }));
      // What the new driver reads back to rehydrate from is the old driver's.
      const terminals = unwrap<Array<{ id: string }>>(
        await r.invoke(CHANNELS.PROJECT_GET_TERMINALS, b, "proj-1")
      );
      expect(terminals.map((t) => t.id)).toEqual(["browser-1", "browser-2"]);
      expect(
        unwrap<Array<{ id: string }>>(
          await r.invoke(CHANNELS.PROJECT_GET_TAB_GROUPS, b, "proj-1")
        ).map((g) => g.id)
      ).toEqual(["g1"]);
      expect(
        unwrap<Record<string, string>>(
          await r.invoke(CHANNELS.PROJECT_GET_DRAFT_INPUTS, b, "proj-1")
        )
      ).toEqual({ t1: "half a prompt" });
      expect(harnessState.projectStates.get("proj-1")).toMatchObject({
        draftInputs: { t1: "half a prompt" },
      });
    },
    TEST_TIMEOUT_MS
  );
});
