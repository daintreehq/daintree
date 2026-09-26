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
import { CHANNELS } from "../../ipc/channels.js";
import { registerAppStateHandlers } from "../../ipc/handlers/app/state.js";
import { FakeView, liveViews, projectKeys } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";
type HostOwnedWriteOutcome = "sent" | "deferred" | "skipped";
type HostBlock = { kind: "disconnected"; hostName: string } | null;
type LeaseBlock = { kind: "driven-elsewhere"; driverName: string; projectId?: string } | null;

/** The renderer's own gate, loaded from its source (the renderer isn't part of this project). */
interface RendererGate {
  _resetHostOwnedWritesForTesting(): void;
  hasDeferredHostOwnedWrite(key: string): boolean;
  sendHostOwnedWrite(
    key: string,
    send: () => Promise<unknown>,
    replay: () => void
  ): Promise<HostOwnedWriteOutcome>;
  setHostOwnedWriteFlushBarrier(barrier: () => Promise<void>): () => void;
  _resetTerminalInputGateForTesting(): void;
  setHostInputBlock(block: HostBlock): void;
  setLeaseInputBlock(block: LeaseBlock): void;
}

async function loadRendererGate(): Promise<RendererGate> {
  const writesPath = "../../../src/store/persistence/hostOwnedWrites.ts";
  const gatePath = "../../../src/services/terminal/inputGate.ts";
  const [writes, gate] = await Promise.all([
    import(/* @vite-ignore */ writesPath),
    import(/* @vite-ignore */ gatePath),
  ]);
  return { ...writes, ...gate } as RendererGate;
}

const {
  _resetHostOwnedWritesForTesting,
  hasDeferredHostOwnedWrite,
  sendHostOwnedWrite,
  setHostOwnedWriteFlushBarrier,
  _resetTerminalInputGateForTesting,
  setHostInputBlock,
  setLeaseInputBlock,
} = await loadRendererGate();

const TEST_TIMEOUT_MS = 60_000;
const KEY = "app-state:activeWorktreeId";

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  _resetHostOwnedWritesForTesting();
  _resetTerminalInputGateForTesting();
});

/** What the preload hands the renderer: an envelope's error as an `[AppError|CODE]` Error. */
function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

function addLocalView(id: number, projectId: string): FakeView {
  const view = new FakeView(id);
  liveViews.set(id, view);
  projectKeys.set(id, projectId);
  return view;
}

function hostActiveWorktree(): unknown {
  return (harnessState.store.get("appState") as Record<string, unknown> | undefined)
    ?.activeWorktreeId;
}

/**
 * The renderer's own route for an active-worktree save (worktreeStore's `persistActiveWorktree`),
 * sending over the real link: the gate decides, a replay re-enters it.
 */
function activeWorktreeSaver(r: RemoteHarness, view: FakeView) {
  const outcomes: HostOwnedWriteOutcome[] = [];
  const save = (id: string): Promise<HostOwnedWriteOutcome> =>
    sendHostOwnedWrite(
      KEY,
      async () => unwrap(await r.invoke(CHANNELS.APP_SET_STATE, view, { activeWorktreeId: id })),
      () => void save(id).then((outcome) => outcomes.push(outcome))
    );
  return { save, replayOutcomes: outcomes };
}

/** What the host connection sync's barrier does first: ask the host who drives now. */
function leaseBarrier(r: RemoteHarness, view: FakeView) {
  return async () => {
    const lease = unwrap<{ drivingHere: boolean; holder: { clientName: string } | null }>(
      await r.invoke(CHANNELS.DRIVE_LEASE_GET, view, { projectId: "proj-1" })
    );
    setLeaseInputBlock(
      lease.drivingHere || !lease.holder
        ? null
        : { kind: "driven-elsewhere", driverName: lease.holder.clientName, projectId: "proj-1" }
    );
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("host-owned saves across a dropped link (integration harness)", () => {
  it(
    "a save lost to a dropped link lands on the host once the link is back, and only the latest",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      cleanups.push(registerAppStateHandlers());
      harnessState.store.set("appState", { terminals: [], activeWorktreeId: "wt-before" });
      const view = r.addView(11, "proj-1");
      await r.openStreams(view);
      setHostOwnedWriteFlushBarrier(leaseBarrier(r, view));
      const { save, replayOutcomes } = activeWorktreeSaver(r, view);

      await expect(save("wt-first")).resolves.toBe("sent");
      expect(hostActiveWorktree()).toEqual("wt-first");

      await r.dropLink();
      // The link died before the renderer's connection state heard of it.
      await expect(save("wt-lost")).resolves.toBe("deferred");
      setHostInputBlock({ kind: "disconnected", hostName: "harness" });
      await expect(save("wt-latest")).resolves.toBe("deferred");
      expect(hasDeferredHostOwnedWrite(KEY)).toBe(true);
      expect(hostActiveWorktree()).toEqual("wt-first");

      await r.restoreLink();
      setHostInputBlock(null);
      await settle();
      // The lost write may get its one retry while the link is still down;
      // exactly one replay lands, and it carries the latest value.
      expect(replayOutcomes.filter((outcome) => outcome === "sent")).toHaveLength(1);
      expect(replayOutcomes.at(-1)).toBe("sent");
      expect(hostActiveWorktree()).toEqual("wt-latest");
      expect(hasDeferredHostOwnedWrite(KEY)).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a save held through a takeover on the host is dropped, and the new driver's state stands",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      cleanups.push(registerAppStateHandlers());
      harnessState.store.set("appState", { terminals: [], activeWorktreeId: "wt-before" });
      const view = r.addView(11, "proj-1");
      await r.openStreams(view);
      setHostOwnedWriteFlushBarrier(leaseBarrier(r, view));
      const { save, replayOutcomes } = activeWorktreeSaver(r, view);

      await r.dropLink();
      setHostInputBlock({ kind: "disconnected", hostName: "harness" });
      await expect(save("wt-stale")).resolves.toBe("deferred");

      // Someone at the host's own screen takes the project while the link is down.
      const local = addLocalView(51, "proj-1");
      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, local, { projectId: "proj-1" }));
      unwrap(await r.invoke(CHANNELS.APP_SET_STATE, local, { activeWorktreeId: "wt-driver" }));
      expect(hostActiveWorktree()).toEqual("wt-driver");

      await r.restoreLink();
      setHostInputBlock(null);
      await settle();
      expect(replayOutcomes).toEqual([]);
      expect(hasDeferredHostOwnedWrite(KEY)).toBe(false);
      expect(hostActiveWorktree()).toEqual("wt-driver");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a flush the host refuses as DRIVEN_ELSEWHERE is skipped, not an error, and changes nothing",
    async () => {
      const r = (h = await startRemoteHarness());
      await r.connect();
      cleanups.push(registerAppStateHandlers());
      harnessState.store.set("appState", { terminals: [], activeWorktreeId: "wt-before" });
      const view = r.addView(11, "proj-1");
      await r.openStreams(view);
      // No lease read before flushing: the view's lease knowledge is stale.
      const { save, replayOutcomes } = activeWorktreeSaver(r, view);

      await r.dropLink();
      setHostInputBlock({ kind: "disconnected", hostName: "harness" });
      await expect(save("wt-stale")).resolves.toBe("deferred");
      const local = addLocalView(51, "proj-1");
      unwrap(await r.invoke(CHANNELS.DRIVE_LEASE_TAKE_OVER, local, { projectId: "proj-1" }));
      unwrap(await r.invoke(CHANNELS.APP_SET_STATE, local, { activeWorktreeId: "wt-driver" }));

      await r.restoreLink();
      setHostInputBlock(null);
      await settle();
      expect(replayOutcomes).toEqual(["skipped"]);
      expect(hostActiveWorktree()).toEqual("wt-driver");
    },
    TEST_TIMEOUT_MS
  );
});
