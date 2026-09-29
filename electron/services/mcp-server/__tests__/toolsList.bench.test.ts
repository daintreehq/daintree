// Benchmark for the local MCP server's `tools/list` path against the real
// action manifest. Prints metrics with MCP_TOOLS_LIST_BENCH=1; the assertions
// pin the coalesced shape.
//
// The renderer side is simulated in-process: a manifest request runs the real
// `ActionService.list()` over the real registry and `structuredClone`s the
// result, which stands in for the IPC serialize + deserialize the payload pays
// crossing to main. Everything runs on one thread, so wall time here is the
// combined renderer + main CPU a burst of handshakes costs. Timings are warm:
// one `tools/list` runs first, priming ActionService's compiled-schema cache.
//
// 1. Burst: 5 sessions issue `tools/list` at once through one real renderer
//    bridge. Counts manifest requests sent to the renderer and the burst's wall
//    time, and checks every session gets byte-identical output.
// 2. Single: one `tools/list`, end to end.
// 3. Projection: `buildToolInputSchema` over every manifest entry.
import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

const { mockIpcMain } = vi.hoisted(() => {
  class IpcMainMock {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void): this {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const set = this.listeners.get(event);
      if (!set) return false;
      for (const fn of set) fn(...args);
      return set.size > 0;
    }
  }
  return { mockIpcMain: new IpcMainMock() };
});

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  ipcMain: mockIpcMain,
  webContents: { fromId: () => undefined },
}));
vi.mock("../../../window/windowRef.js", () => ({ getProjectViewManager: () => null }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => [],
  getWindowForWebContents: () => null,
}));
vi.mock("../../../utils/webContentsLifecycle.js", () => ({
  unfreezeWebContents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() }),
  },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: () => null, getDisplayCombo: () => "" },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { CHANNELS } from "../../../ipc/channels.js";
import { createRendererBridge } from "../rendererBridge.js";
import { createSessionServer, type SessionServerDeps } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import { GrantCache } from "../grantCache.js";
import { ResourceOwnershipLedger } from "../resourceOwnership.js";
import { buildToolInputSchema } from "../tierAuth.js";
import type { PendingRequest, DispatchEnvelope } from "../shared.js";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

const BURST = 5;
const ROUNDS = 10;
const PROJECTION_ITERATIONS = 100;
const WEBCONTENTS_ID = 7;

interface RendererActionService {
  has(id: string): boolean;
  register(definition: { id: string }): void;
  list(): ActionManifestEntry[];
}

/**
 * The real renderer registry, loaded through computed specifiers: the electron
 * typecheck project cannot compile renderer source, so these stay invisible to
 * tsc and are resolved by vitest at run time.
 */
async function buildRenderer(): Promise<RendererActionService> {
  const serviceModule = "@/services/ActionService";
  const registryModule = "@/services/actions/__tests__/helpers/wireSurface";
  const { ActionService } = (await import(serviceModule)) as {
    ActionService: new () => RendererActionService;
  };
  const { createActionRegistry } = (await import(registryModule)) as {
    createActionRegistry: () => Promise<Map<string, () => { id: string }>>;
  };
  const registry = await createActionRegistry();
  const service = new ActionService();
  for (const factory of registry.values()) {
    const definition = factory();
    if (!service.has(definition.id)) service.register(definition);
  }
  return service;
}

function makeBridge(service: RendererActionService) {
  const manifestRequests = { count: 0 };
  const webContents = {
    id: WEBCONTENTS_ID,
    isDestroyed: () => false,
    once: () => {},
    removeListener: () => {},
    send: (channel: string, payload: { requestId: string }) => {
      if (channel !== CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) return;
      manifestRequests.count += 1;
      // A separate task, like a real IPC hop: concurrent callers all reach the
      // bridge before the renderer answers any of them.
      setImmediate(() => {
        const manifest = structuredClone(service.list());
        mockIpcMain.emit(
          CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
          { sender: { id: WEBCONTENTS_ID } },
          { requestId: payload.requestId, manifest }
        );
      });
    },
  };
  const ctx = {
    browserWindow: { isDestroyed: () => false },
    services: { projectViewManager: { getActiveView: () => ({ webContents }) } },
  };
  const registry = { all: () => [ctx], focusOrder: () => [ctx], getByWebContentsId: () => ctx };
  const bridge = createRendererBridge(
    new Map<string, PendingRequest<ActionManifestEntry[]>>(),
    new Map<string, PendingRequest<DispatchEnvelope>>(),
    () => registry as never
  );
  bridge.setupListeners([]);
  return { bridge, manifestRequests };
}

function fakeSessionStore(): SessionStore {
  return {
    sessions: new Map(),
    httpSessions: new Map(),
    sessionTierMap: new Map(),
    sessionWebContentsMap: new Map(),
    sessionOriginMap: new Map(),
    getOrigin: () => "external",
    isRendererOwnedOrigin: () => false,
    sessionWorkspaceMap: new Map(),
    resourceSubscriptions: new Map(),
    dedupInFlight: new Map(),
    dedupResultCache: new Map(),
    grantCache: new GrantCache({ sweepIntervalMs: 0 }),
    resourceOwnership: new ResourceOwnershipLedger(),
    drain: vi.fn(),
    getTier: () => "full",
    createIdleTimer: () => setTimeout(() => {}, 1_000_000),
    createHttpIdleTimer: () => setTimeout(() => {}, 1_000_000),
    resetIdleTimer: vi.fn(),
    resetHttpIdleTimer: vi.fn(),
    clearDedupState: vi.fn(),
  } as unknown as SessionStore;
}

function makeServer(bridge: ReturnType<typeof makeBridge>["bridge"], sessionId: string) {
  const deps: SessionServerDeps = {
    sessionStore: fakeSessionStore(),
    requestManifest: () => bridge.requestManifest(),
    getCachedManifest: () => bridge.getCachedManifest(),
    dispatchAction: vi.fn(),
    handleWaitUntilIdle: vi.fn(),
    handleWaitUntilIdleBatch: vi.fn(),
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn(),
    handleTerminalGetStatusViewless: vi.fn(),
    handleTerminalReadLastMessageOwned: vi.fn(),
    isTerminalIdInUse: vi.fn(() => false),
    appendAuditRecord: vi.fn(),
  } as unknown as SessionServerDeps;
  const server = createSessionServer(sessionId, deps);
  const handler = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers.get("tools/list")!;
  return () =>
    handler(
      { method: "tools/list", params: {}, jsonrpc: "2.0", id: 1 },
      { signal: new AbortController().signal, _meta: {}, sendNotification: vi.fn(), requestId: 1 }
    ) as Promise<{ tools: unknown[] }>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("tools/list bench", () => {
  it("coalesces a handshake burst onto one manifest request", async () => {
    const service = await buildRenderer();
    const { bridge, manifestRequests } = makeBridge(service);
    const lists = Array.from({ length: BURST }, (_, i) => makeServer(bridge, `session-${i}`));

    const reference = JSON.stringify(await lists[0]());
    expect((JSON.parse(reference) as { tools: unknown[] }).tools.length).toBeGreaterThan(0);

    const burstMs: number[] = [];
    const burstRequests: number[] = [];
    const singleMs: number[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      manifestRequests.count = 0;
      let start = performance.now();
      const results = await Promise.all(lists.map((list) => list()));
      burstMs.push(performance.now() - start);
      burstRequests.push(manifestRequests.count);
      for (const result of results) expect(JSON.stringify(result)).toBe(reference);

      start = performance.now();
      expect(JSON.stringify(await lists[0]())).toBe(reference);
      singleMs.push(performance.now() - start);
    }

    const manifest = structuredClone(service.list());
    const projectionMs: number[] = [];
    for (let round = 0; round < 5; round++) {
      const start = performance.now();
      for (let i = 0; i < PROJECTION_ITERATIONS; i++) manifest.map((e) => buildToolInputSchema(e));
      projectionMs.push((performance.now() - start) / PROJECTION_ITERATIONS);
    }

    const metrics = {
      entries: manifest.length,
      toolsListed: (JSON.parse(reference) as { tools: unknown[] }).tools.length,
      burstManifestRequests: median(burstRequests),
      burstWallMs: median(burstMs),
      singleWallMs: median(singleMs),
      projectionMsPerManifest: median(projectionMs),
    };
    if (process.env.MCP_TOOLS_LIST_BENCH) {
      // Console output is swallowed by the vitest config.
      writeFileSync(process.env.MCP_TOOLS_LIST_BENCH, JSON.stringify(metrics) + "\n", {
        flag: "a",
      });
    }

    for (const requests of burstRequests) expect(requests).toBe(1);
  }, 60_000);
});
