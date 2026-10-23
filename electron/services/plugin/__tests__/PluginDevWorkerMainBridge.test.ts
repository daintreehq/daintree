/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

// One shared logger instance so a test can make it throw — the failure paths
// have to survive a logger that is itself broken.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => loggerMock,
}));

import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import { inertPluginTaskHandle } from "../../../../shared/utils/pluginTasks.js";
import { PluginDevWorkerHostProxy } from "../pluginDevWorkerHostProxy.js";
import { PluginInvokeTimeoutError, runWithInvokeDeadline } from "../pluginInvokeDeadline.js";
import type { PluginIpcContext } from "../../../../shared/types/plugin.js";
import { databaseBackupApprovers, databaseWriteAuthorizers } from "../pluginInternalApprovers.js";
import { parseWorkerToHostMessage } from "../../../schemas/pluginDevWorker.js";
import { PLUGIN_PUSH_MAX_PAYLOAD_BYTES } from "../../../../shared/config/pluginBudgets.js";
import {
  _resetPluginFrontendRoutingForTesting,
  getPluginInvokeOrigin,
  runInPluginInvocation,
  setPluginFrontendRouter,
} from "../pluginFrontendRouting.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";

class FakeWorkerHost extends EventEmitter {
  sent: any[] = [];
  ready = true;
  send = vi.fn((msg: any) => {
    this.sent.push(msg);
    return this.ready;
  });
  isReady = () => this.ready;
  off = this.removeListener;
  dispose = vi.fn(() => {
    this.ready = false;
    this.removeAllListeners();
  });
}

function makeHost() {
  return {
    pluginId: "acme.demo",
    // Annotated `Promise<void>` so a test can drive the deep-validation outcome
    // (`mockReturnValueOnce` a still-pending promise, `mockRejectedValueOnce` a
    // rejection); the default-inferred `undefined` return would reject both.
    registerAction: vi.fn((_descriptor: any, _handler: any): Promise<void> => Promise.resolve()),
    registerHandler: vi.fn((_channel: any, _handler: any): Promise<void> => Promise.resolve()),
    broadcastToRenderer: vi.fn(),
    getActiveWorktree: vi.fn(async () => null),
    getWorktrees: vi.fn(async () => [{ id: "w1" }]),
    getWorktreesResult: vi.fn(async () => ({
      status: "ok",
      projectId: "project-1",
      worktrees: [{ id: "w1" }],
    })),
    onDidChangeActiveWorktree: vi.fn((_cb: any) => vi.fn()),
    onDidChangeWorktrees: vi.fn((_cb: any) => vi.fn()),
    onDidWake: vi.fn((_cb: any) => vi.fn()),
    onDidChangeTerminalLifecycle: vi.fn((_cb: any) => vi.fn()),
    registerForgeProvider: vi.fn(() => vi.fn()),
    registerFileDecorationProvider: vi.fn(() => vi.fn()),
    registerWorktreeSetupStep: vi.fn((_stepId: string, _handler: any) => vi.fn()),
    registerContextProvider: vi.fn(async () => vi.fn()),
    registerWorktreeDeleteNotesProvider: vi.fn(() => vi.fn()),
    invalidateFileDecorations: vi.fn(),
    setPanelBadge: vi.fn(async () => {}),
    setToolbarButtonBadge: vi.fn(async () => {}),
    setToolbarButtonState: vi.fn(async () => {}),
    setContext: vi.fn(async () => {}),
    setWorktreeCardStatus: vi.fn(async () => {}),
    setWorktreeReviewChecks: vi.fn(async () => {}),
    setPanelActivity: vi.fn(async () => {}),
    setPanelMenuItems: vi.fn(async () => {}),
    tasks: {
      start: vi.fn(async (_options: unknown): Promise<unknown> => {
        throw new Error("no task");
      }),
    },
    showToast: vi.fn(async () => {}),
    notify: vi.fn(async (_options: unknown) => ({ id: "n-1" })),
    showQuickPick: vi.fn(async (): Promise<unknown> => undefined),
    sendToAgent: vi.fn(async (): Promise<unknown> => ({ status: "drafted", terminalId: "t-1" })),
    agents: {
      list: vi.fn(async () => [{ terminalId: "t-1", canDraft: true }]),
      listAll: vi.fn(async () => ({ agents: [], degraded: false, lastSuccessfulAt: 1 })),
      interrupt: vi.fn(async () => ({ status: "sent", cancelKey: "advertised" })),
      sendKeys: vi.fn(async () => ({ status: "sent", keys: ["Enter"] })),
      submit: vi.fn(async () => ({ status: "not-found" })),
    },
    terminals: {
      readScreen: vi.fn(async (): Promise<unknown> => ({
        status: "ok",
        text: "Waiting",
        lineCount: 1,
        truncated: false,
      })),
    },
    showInputBox: vi.fn(async (): Promise<unknown> => undefined),
    showConfirm: vi.fn(async () => false),
    dispatch: vi.fn(async () => ({ ok: true, result: undefined })),
    reloadPanel: vi.fn(async () => "scheduled"),
    restartWorker: vi.fn(async () => "scheduled"),
    actions: {
      list: vi.fn(async () => [{ id: "terminal.new", danger: "safe", requiresArgs: false }]),
      get: vi.fn(async (id: string) => ({ id, danger: "safe", requiresArgs: false })),
      canDispatch: vi.fn(async () => "ok"),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      // Annotated `Promise<unknown>` so a test can `mockResolvedValueOnce` a
      // concrete value (the default-inferred `Promise<undefined>` would reject it).
      get: vi.fn(async (): Promise<unknown> => undefined),
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
      onDidChange: vi.fn(() => vi.fn()),
    },
    system: {
      openExternal: vi.fn(async () => {}),
    },
    storage: {
      // Annotated `Promise<unknown>` so a test can `mockResolvedValueOnce` a
      // concrete value (the default-inferred `Promise<undefined>` would reject it).
      get: vi.fn(async (): Promise<unknown> => undefined),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      onDidChange: vi.fn((_key: any, _cb: any) => vi.fn()),
    },
    process: {
      spawn: vi.fn(async () => ({
        id: "p0",
        kill: vi.fn(),
        restart: vi.fn(async () => {}),
        onExit: vi.fn(() => vi.fn()),
        onCrash: vi.fn(() => vi.fn()),
      })),
    },
    fs: {
      readFile: vi.fn(async () => ""),
      readFileWithRevision: vi.fn(async () => ({ contents: "", revision: "0".repeat(64) })),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      appendFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({})),
      watch: vi.fn(async (_paths: string[], _cb: (p: string) => void) => vi.fn()),
    },
    clipboard: {
      writeText: vi.fn(async () => {}),
      readText: vi.fn(async () => "clip-contents"),
    },
    documents: {
      renderPdf: vi.fn(async (): Promise<unknown> => ({
        path: "/data/out.pdf",
        bytes: 1234,
        revision: "a".repeat(64),
      })),
    },
    artifacts: {
      import: vi.fn(),
      download: vi.fn(
        async (
          _request: unknown,
          options: { onProgress?: (p: unknown) => void; signal?: AbortSignal }
        ): Promise<unknown> => {
          options.onProgress?.({ transferredBytes: 5, totalBytes: 5, attempt: 1 });
          return { id: "a".repeat(32) };
        }
      ),
      upload: vi.fn(),
      stat: vi.fn(async (): Promise<unknown> => null),
      list: vi.fn(async (): Promise<unknown> => []),
      release: vi.fn(async (): Promise<unknown> => true),
    },
  };
}

/** A controllable spawned-process handle whose lifecycle callbacks can be fired. */
function makeProcessHandle(id = "p1") {
  let exitCb: ((info: unknown) => void) | undefined;
  let crashCb: ((info: unknown) => void) | undefined;
  return {
    id,
    kill: vi.fn(),
    restart: vi.fn(async () => {}),
    onExit: vi.fn((cb: (info: unknown) => void) => {
      exitCb = cb;
      return vi.fn();
    }),
    onCrash: vi.fn((cb: (info: unknown) => void) => {
      crashCb = cb;
      return vi.fn();
    }),
    emitExit: (info: unknown) => exitCb?.(info),
    emitCrash: (info: unknown) => crashCb?.(info),
  };
}

/** The PTY variant: adds the two methods the bridge's structural check reads. */
function makePtyProcessHandle(id = "p1") {
  const base = makeProcessHandle(id);
  let dataCb: ((chunk: unknown) => void) | undefined;
  return {
    ...base,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((cb: (chunk: unknown) => void) => {
      dataCb = cb;
      return vi.fn();
    }),
    emitData: (chunk: unknown) => dataCb?.(chunk),
  };
}

/**
 * The duplex variant (#11871): a writable handle with NO `resize`. This is the
 * shape that must be classified as "duplex", not misread as pipe (which would
 * strand the plugin without a write) or as pty (which would offer a resize the
 * child has no terminal for).
 */
function makeDuplexProcessHandle(id = "p1") {
  const base = makeProcessHandle(id);
  let dataCb: ((chunk: unknown) => void) | undefined;
  return {
    ...base,
    write: vi.fn(),
    onData: vi.fn((cb: (chunk: unknown) => void) => {
      dataCb = cb;
      return vi.fn();
    }),
    emitData: (chunk: unknown) => dataCb?.(chunk),
  };
}

function makeBridge(
  overrides?: Partial<{
    capabilities: string[];
    clear: () => void;
    pluginId: string;
    onActivationResult: (r: { ok: true } | { ok: false; error: string; stack?: string }) => void;
  }>
) {
  const host = makeHost();
  const workerHost = new FakeWorkerHost();
  const clear = overrides?.clear ?? vi.fn();
  const onActivationResult = overrides?.onActivationResult ?? vi.fn();
  const onTerminalFailure = vi.fn();
  const onPushRejected = vi.fn();
  const bridge = new PluginDevWorkerMainBridge({
    pluginId: overrides?.pluginId ?? "acme.demo",
    host: host as any,
    workerHost: workerHost as any,
    getCapabilities: () => overrides?.capabilities ?? [],
    clearPriorRegistrations: clear,
    onActivationResult,
    onTerminalFailure,
    onPushRejected,
  });
  return { host, workerHost, bridge, clear, onActivationResult, onTerminalFailure, onPushRejected };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("PluginDevWorkerMainBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, so a throwing logger would leak.
    for (const fn of Object.values(loggerMock)) fn.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes a host-call to the real host and replies with host-result", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c1",
      method: "getWorktrees",
      params: undefined,
    });
    await flush();
    expect(host.getWorktrees).toHaveBeenCalled();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c1");
    expect(result).toMatchObject({ ok: true, result: [{ id: "w1" }] });
  });

  it("relays dispatch options to the real host, and omits nothing when absent (#13119)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-d1",
      method: "dispatch",
      params: { actionId: "agent.launch", args: { a: 1 }, options: { projectId: "p-b" } },
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-d2",
      method: "dispatch",
      params: { actionId: "terminal.focus" },
    });
    await flush();
    expect(host.dispatch).toHaveBeenNthCalledWith(
      1,
      "agent.launch",
      { a: 1 },
      { projectId: "p-b" }
    );
    expect(host.dispatch).toHaveBeenNthCalledWith(2, "terminal.focus", undefined, undefined);
  });

  it("relays notify options whole, unknown keys included, and returns the host's id (#13505)", async () => {
    const { host, workerHost } = makeBridge();
    const options = {
      title: "t",
      body: "b",
      actions: [{ id: "o", label: "Open", actionId: "acme.demo.open", extra: true }],
      sound: true,
    };
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-n",
      method: "notify",
      params: { options },
    });
    await flush();
    expect(host.notify).toHaveBeenCalledWith(options);
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-n");
    expect(result).toMatchObject({ ok: true, result: { id: "n-1" } });
  });

  it("relays db.resolve with only the database id", async () => {
    const { host, workerHost } = makeBridge();
    (host as unknown as { db: { resolve: ReturnType<typeof vi.fn> } }).db = {
      resolve: vi.fn(async (id: string) => ({ id, path: "/p/.daintree/data/x/ledger.db" })),
    } as never;
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-db",
      method: "db.resolve",
      params: { id: "ledger", path: "/etc/passwd" },
    });
    await flush();
    expect(
      (host as unknown as { db: { resolve: ReturnType<typeof vi.fn> } }).db.resolve
    ).toHaveBeenCalledWith("ledger");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-db");
    expect(result).toMatchObject({ ok: true, result: { id: "ledger" } });
  });

  it("relays db.prepareBackup to the host's internal approver, never to the plugin's host.db", async () => {
    const { host, workerHost } = makeBridge();
    const db = { resolve: vi.fn(), open: vi.fn() };
    const approve = vi.fn(async (_id: string, destPath: string) => `/real${destPath}`);
    databaseBackupApprovers.set(db as never, approve);
    (host as unknown as { db: unknown }).db = db;
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-bk",
      method: "db.prepareBackup",
      params: { id: "ledger", destPath: "/p/backups/ledger.db" },
    });
    await flush();
    expect(approve).toHaveBeenCalledWith("ledger", "/p/backups/ledger.db");
    expect(workerHost.sent.find((m) => m.requestId === "c-bk")).toMatchObject({
      ok: true,
      result: "/real/p/backups/ledger.db",
    });

    (host as unknown as { db: unknown }).db = { resolve: vi.fn(), open: vi.fn() };
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-bk2",
      method: "db.prepareBackup",
      params: { id: "ledger", destPath: "/p/backups/ledger.db" },
    });
    await flush();
    expect(workerHost.sent.find((m) => m.requestId === "c-bk2")).toMatchObject({ ok: false });
  });

  it("answers db.authorizeWrite from the host's internal authorizer, in the worker's call", async () => {
    const { host, workerHost } = makeBridge();
    const db = { resolve: vi.fn(), open: vi.fn() };
    const authorize = vi.fn(async (_id: string, _path?: string) => {
      throw Object.assign(new Error("DRIVEN_ELSEWHERE: someone else drives"), {
        code: "DRIVEN_ELSEWHERE",
      });
    });
    databaseWriteAuthorizers.set(db as never, authorize);
    (host as unknown as { db: unknown }).db = db;
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-aw",
      method: "db.authorizeWrite",
      params: { id: "ledger", path: "/p/.daintree/data/x/ledger.db" },
    });
    await flush();
    expect(authorize).toHaveBeenCalledWith("ledger", "/p/.daintree/data/x/ledger.db");
    expect(workerHost.sent.find((m) => m.requestId === "c-aw")).toMatchObject({
      ok: false,
      errorFields: { code: "DRIVEN_ELSEWHERE" },
    });
  });

  it("carries a host error's primitive fields to the worker, not just its message", async () => {
    const { host, workerHost } = makeBridge();
    host.getWorktrees.mockRejectedValueOnce(
      Object.assign(new Error("REVISION_MISMATCH: the file changed"), {
        code: "REVISION_MISMATCH",
        currentRevision: "abc123",
        nested: { dropped: true },
      })
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-err",
      method: "getWorktrees",
      params: undefined,
    });
    await flush();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-err");
    expect(result).toMatchObject({
      ok: false,
      error: "REVISION_MISMATCH: the file changed",
      errorFields: { code: "REVISION_MISMATCH", currentRevision: "abc123" },
    });
    expect(result.errorFields).not.toHaveProperty("nested");
  });

  it("relays reloadPanel with only the panel id and returns the acknowledgment (#12610)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-rp",
      method: "reloadPanel",
      params: { panelId: "p1", pluginId: "someone-else" },
    });
    await flush();
    expect(host.reloadPanel).toHaveBeenCalledWith("p1");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-rp");
    expect(result).toMatchObject({ ok: true, result: "scheduled" });
  });

  it("relays setContext as a call and returns the host's rejection to the worker (#13506)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-sc",
      method: "setContext",
      params: { key: "needsYou", value: "triage" },
    });
    await flush();
    expect(host.setContext).toHaveBeenCalledWith("needsYou", "triage");
    const ok = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-sc");
    expect(ok).toMatchObject({ ok: true });

    host.setContext.mockRejectedValueOnce(new Error("setContext: at most 32 keys per plugin"));
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-sc-cap",
      method: "setContext",
      params: { key: "k33", value: true },
    });
    await flush();
    const refused = workerHost.sent.find(
      (m) => m.type === "host-result" && m.requestId === "c-sc-cap"
    );
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/at most 32 keys/) });
  });

  it("relays setToolbarButtonState as a call and returns the host's rejection (#13785)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-ts",
      method: "setToolbarButtonState",
      params: { buttonId: "sync", state: { pressed: true } },
    });
    await flush();
    expect(host.setToolbarButtonState).toHaveBeenCalledWith("sync", { pressed: true });
    const ok = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-ts");
    expect(ok).toMatchObject({ ok: true });

    host.setToolbarButtonState.mockRejectedValueOnce(
      new Error(
        "setToolbarButtonState: invalid state — disabledReason: a disabled button needs a disabledReason"
      )
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-ts-bad",
      method: "setToolbarButtonState",
      params: { buttonId: "sync", state: { disabled: true } },
    });
    await flush();
    const refused = workerHost.sent.find(
      (m) => m.type === "host-result" && m.requestId === "c-ts-bad"
    );
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/disabledReason/) });
  });

  it("relays setPanelActivity as a call and returns the host's rejection (#13820)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-pa",
      method: "setPanelActivity",
      params: { panelId: "panel-1", activity: { state: "working" } },
    });
    await flush();
    expect(host.setPanelActivity).toHaveBeenCalledWith("panel-1", { state: "working" });
    expect(
      workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-pa")
    ).toMatchObject({ ok: true });

    host.setPanelActivity.mockRejectedValueOnce(
      new Error('setPanelActivity: panel "panel-2" belongs to another plugin')
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-pa-foreign",
      method: "setPanelActivity",
      params: { panelId: "panel-2", activity: { state: "waiting" } },
    });
    await flush();
    expect(
      workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-pa-foreign")
    ).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to another plugin/) });
  });

  describe("tasks (#13819)", () => {
    function fakeTask(id = "t-1") {
      const controller = new AbortController();
      return {
        controller,
        handle: {
          id,
          signal: controller.signal,
          report: vi.fn(),
          finish: vi.fn(async (_result: unknown) => {}),
        },
      };
    }

    async function start(workerHost: FakeWorkerHost, requestId = "c-ts") {
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId,
        method: "tasks.start",
        params: {
          subscriptionId: "s-cancel",
          options: { title: "Import", cancellable: true, retry: { actionId: "acme.demo.go" } },
        },
      });
      await flush();
      return workerHost.sent.find((m) => m.type === "host-result" && m.requestId === requestId);
    }

    const cancelEvents = (workerHost: FakeWorkerHost) =>
      workerHost.sent.filter(
        (m) => m.type === "subscription-event" && m.subscriptionId === "s-cancel"
      );

    it("starts on the host, relays the user's cancel, routes reports and finishes", async () => {
      const { host, workerHost } = makeBridge();
      const { controller, handle } = fakeTask();
      host.tasks.start.mockResolvedValueOnce(handle);

      expect(await start(workerHost)).toMatchObject({ ok: true, result: { id: "t-1" } });
      expect(host.tasks.start).toHaveBeenCalledWith({
        title: "Import",
        cancellable: true,
        retry: { actionId: "acme.demo.go" },
      });

      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "tasks.report",
        params: {
          reports: [
            { taskId: "t-1", progress: { fraction: 0.5 } },
            { taskId: "someone-else", progress: { fraction: 1 } },
          ],
        },
      });
      await flush();
      expect(handle.report).toHaveBeenCalledTimes(1);
      expect(handle.report).toHaveBeenCalledWith({ fraction: 0.5 });

      controller.abort();
      expect(cancelEvents(workerHost)).toHaveLength(1);

      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "c-tf",
        method: "tasks.finish",
        params: { taskId: "t-1", result: { outcome: "cancelled" } },
      });
      await flush();
      expect(handle.finish).toHaveBeenCalledWith({ outcome: "cancelled" });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "tasks.report",
        params: { reports: [{ taskId: "t-1", progress: { fraction: 0.9 } }] },
      });
      await flush();
      expect(handle.report).toHaveBeenCalledTimes(1);
    });

    it("says so when the host handed back an inert handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle = inertPluginTaskHandle();
      host.tasks.start.mockResolvedValueOnce(handle);
      expect(await start(workerHost)).toMatchObject({
        ok: true,
        result: { id: handle.id, inert: true },
      });
      expect(cancelEvents(workerHost)).toEqual([]);
    });

    it("keeps a real task cancelled before start answered, and tells the worker first", async () => {
      const { host, workerHost } = makeBridge();
      const { controller, handle } = fakeTask();
      controller.abort();
      host.tasks.start.mockResolvedValueOnce(handle);

      const result = await start(workerHost);
      expect(result).toMatchObject({ ok: true, result: { id: "t-1" } });
      expect(result.result).not.toHaveProperty("inert");
      const cancelAt = workerHost.sent.findIndex(
        (m) => m.type === "subscription-event" && m.subscriptionId === "s-cancel"
      );
      expect(cancelAt).toBeGreaterThanOrEqual(0);
      expect(cancelAt).toBeLessThan(workerHost.sent.indexOf(result));

      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "c-tf",
        method: "tasks.finish",
        params: { taskId: "t-1", result: { outcome: "cancelled" } },
      });
      await flush();
      expect(handle.finish).toHaveBeenCalledWith({ outcome: "cancelled" });
    });

    it("stops relaying cancels once the worker generation is retired", async () => {
      const { host, workerHost } = makeBridge();
      const { controller, handle } = fakeTask();
      host.tasks.start.mockResolvedValueOnce(handle);
      await start(workerHost);

      workerHost.emit("exit", 139, false);
      controller.abort();
      expect(cancelEvents(workerHost)).toEqual([]);
    });
  });

  it("relays setWorktreeReviewChecks as a call and returns the host's rejection (#13806)", async () => {
    const { host, workerHost } = makeBridge();
    const checks = [{ label: "broken", severity: "warning", command: "acme.demo.open" }];
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-rc",
      method: "setWorktreeReviewChecks",
      params: { worktreeId: "/repo/wt", checks },
    });
    await flush();
    expect(host.setWorktreeReviewChecks).toHaveBeenCalledWith("/repo/wt", checks);
    expect(
      workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-rc")
    ).toMatchObject({
      ok: true,
    });

    host.setWorktreeReviewChecks.mockRejectedValueOnce(
      new Error('setWorktreeReviewChecks: "/other" is not a worktree this plugin can see')
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-rc-foreign",
      method: "setWorktreeReviewChecks",
      params: { worktreeId: "/other", checks: null },
    });
    await flush();
    expect(
      workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-rc-foreign")
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a worktree this plugin can see/),
    });
  });

  it("relays setWorktreeCardStatus as a call and returns the host's rejection (#13704)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-ws",
      method: "setWorktreeCardStatus",
      params: { worktreeId: "/repo/wt", status: { label: "up", command: "acme.demo.open" } },
    });
    await flush();
    // Relayed as sent: the host qualifies the command, as it vets the rest.
    expect(host.setWorktreeCardStatus).toHaveBeenCalledWith("/repo/wt", {
      label: "up",
      command: "acme.demo.open",
    });
    const ok = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-ws");
    expect(ok).toMatchObject({ ok: true });

    host.setWorktreeCardStatus.mockRejectedValueOnce(
      new Error('setWorktreeCardStatus: "/other" is not a worktree this plugin can see')
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-ws-foreign",
      method: "setWorktreeCardStatus",
      params: { worktreeId: "/other", status: null },
    });
    await flush();
    const refused = workerHost.sent.find(
      (m) => m.type === "host-result" && m.requestId === "c-ws-foreign"
    );
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a worktree this plugin can see/),
    });
  });

  it("relays restartWorker and returns the host's answer (#13410)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-rw",
      method: "restartWorker",
    });
    await flush();
    expect(host.restartWorker).toHaveBeenCalledTimes(1);
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-rw");
    expect(result).toMatchObject({ ok: true, result: "scheduled" });
  });

  it("relays getWorktreesResult and returns the union object unchanged (#12174)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c-wr",
      method: "getWorktreesResult",
      params: undefined,
    });
    await flush();
    expect(host.getWorktreesResult).toHaveBeenCalled();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c-wr");
    expect(result).toMatchObject({
      ok: true,
      result: { status: "ok", projectId: "project-1", worktrees: [{ id: "w1" }] },
    });
  });

  it("routes clipboard.writeText to the host and replies with undefined", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "cw",
      method: "clipboard.writeText",
      params: { text: "hello" },
    });
    await flush();
    expect(host.clipboard.writeText).toHaveBeenCalledWith("hello");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "cw");
    expect(result).toMatchObject({ ok: true, result: undefined });
  });

  it("relays an empty clipboard read as ok:true with an empty string", async () => {
    const { host, workerHost } = makeBridge();
    host.clipboard.readText.mockResolvedValueOnce("");
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "ce",
      method: "clipboard.readText",
      params: undefined,
    });
    await flush();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "ce");
    expect(result).toMatchObject({ ok: true, result: "" });
  });

  it("routes documents.renderPdf to the host with the options exactly as sent", async () => {
    const { host, workerHost } = makeBridge();
    // Unknown keys ride through untouched so the host's strict validation,
    // not the bridge, is what refuses them.
    const options = { html: "<p>hi</p>", outputPath: "/data/out.pdf", bogus: 1 };
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "pdf1",
      method: "documents.renderPdf",
      params: { options },
    });
    await flush();
    expect(host.documents.renderPdf).toHaveBeenCalledWith(options);
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "pdf1");
    expect(result).toMatchObject({
      ok: true,
      result: { path: "/data/out.pdf", bytes: 1234, revision: "a".repeat(64) },
    });
  });

  it("routes an artifact download with this call's signal and relays its progress", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "art1",
      method: "artifacts.download",
      params: {
        target: { url: "https://api.example.com/a" },
        options: { attempts: 2 },
        progressSubscriptionId: "s9",
      },
    });
    await flush();
    const [request, options] = host.artifacts.download.mock.calls[0]!;
    expect(request).toEqual({ url: "https://api.example.com/a" });
    expect(options).toMatchObject({ attempts: 2 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(workerHost.sent).toContainEqual({
      type: "subscription-event",
      subscriptionId: "s9",
      payload: { transferredBytes: 5, totalBytes: 5, attempt: 1 },
    });
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "art1");
    expect(result).toMatchObject({ ok: true, result: { id: "a".repeat(32) } });
  });

  it("replies host-result ok:false when the host method throws", async () => {
    const { host, workerHost } = makeBridge();
    host.getWorktrees.mockRejectedValueOnce(new Error("boom"));
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c2",
      method: "getWorktrees",
      params: undefined,
    });
    await flush();
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "c2");
    expect(result).toMatchObject({ ok: false, error: "boom" });
  });

  it("routes actions.list to the real host (#10561)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "a1",
      method: "actions.list",
      params: undefined,
    });
    await flush();
    expect(host.actions.list).toHaveBeenCalledTimes(1);
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "a1");
    expect(result).toMatchObject({
      ok: true,
      result: [{ id: "terminal.new", danger: "safe", requiresArgs: false }],
    });
  });

  it("routes agents.list and sendToAgent to the real host", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "g1",
      method: "agents.list",
      params: undefined,
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "g2",
      method: "sendToAgent",
      params: { text: "Card body", options: { title: "Fix login", terminalId: "t-1" } },
    });
    await flush();

    expect(host.agents.list).toHaveBeenCalledTimes(1);
    expect(host.sendToAgent).toHaveBeenCalledWith(
      "Card body",
      { title: "Fix login", terminalId: "t-1" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(workerHost.sent.find((m) => m.requestId === "g1")).toMatchObject({
      ok: true,
      result: [{ terminalId: "t-1", canDraft: true }],
    });
    expect(workerHost.sent.find((m) => m.requestId === "g2")).toMatchObject({
      ok: true,
      result: { status: "drafted", terminalId: "t-1" },
    });
  });

  it("routes terminals.readScreen with its id and options to the real host", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "s1",
      method: "terminals.readScreen",
      params: { terminalId: "t-1", options: { lines: 5 } },
    });
    await flush();

    expect(host.terminals.readScreen).toHaveBeenCalledWith("t-1", { lines: 5 });
    expect(workerHost.sent.find((m) => m.requestId === "s1")).toMatchObject({
      ok: true,
      result: { status: "ok", text: "Waiting" },
    });
  });

  it("routes actions.get with the action id to the real host (#10561)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "a2",
      method: "actions.get",
      params: { actionId: "recipe.run" },
    });
    await flush();
    expect(host.actions.get).toHaveBeenCalledWith("recipe.run");
    const result = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "a2");
    expect(result).toMatchObject({ ok: true, result: { id: "recipe.run" } });
  });

  it("registerAction wires a wrapper that round-trips invocation to the worker", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerAction",
      registrationKey: "action:acme.demo.greet",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    });
    expect(host.registerAction).toHaveBeenCalledTimes(1);
    const wrapper = host.registerAction.mock.calls[0][1] as (a: unknown) => Promise<unknown>;

    const resultPromise = wrapper({ name: "world" });
    const invoke = workerHost.sent.find((m) => m.type === "invoke" && m.kind === "action");
    expect(invoke).toMatchObject({ namespacedId: "acme.demo.greet", args: { name: "world" } });

    // Worker replies.
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: "hello world",
    });
    await expect(resultPromise).resolves.toBe("hello world");
  });

  it("forwards setPanelBadge host-notify to the real host (#10585)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelBadge",
      params: { panelId: "panel-1", badge: { kind: "label", text: "CI", color: "success" } },
    });
    await flush();
    expect(host.setPanelBadge).toHaveBeenCalledWith("panel-1", {
      kind: "label",
      text: "CI",
      color: "success",
    });
  });

  it("forwards setToolbarButtonBadge host-notify to the real host (#13503)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setToolbarButtonBadge",
      params: { buttonId: "needs", badge: { kind: "label", text: "4" } },
    });
    await flush();
    expect(host.setToolbarButtonBadge).toHaveBeenCalledWith("needs", { kind: "label", text: "4" });
  });

  it("forwards a null setPanelBadge (clear) host-notify to the real host (#10585)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelBadge",
      params: { panelId: "panel-1", badge: null },
    });
    await flush();
    expect(host.setPanelBadge).toHaveBeenCalledWith("panel-1", null);
  });

  it("forwards setPanelMenuItems host-notify to the real host, which vets the list (#13213)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelMenuItems",
      params: { panelId: "panel-1", items: [{ actionId: "acme.open", label: "Open" }] },
    });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "setPanelMenuItems",
      params: { panelId: "panel-1", items: null },
    });
    await flush();
    expect(host.setPanelMenuItems).toHaveBeenNthCalledWith(1, "panel-1", [
      { actionId: "acme.open", label: "Open" },
    ]);
    expect(host.setPanelMenuItems).toHaveBeenNthCalledWith(2, "panel-1", null);
  });

  it("fails closed on a typed handler whose required capability is undeclared", async () => {
    const { host, workerHost } = makeBridge({ capabilities: [] });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      registrationKey: "handler:secret",
      params: { channel: "secret", hasSchema: true, requires: ["worktree:read"] },
    });
    // host-notify dispatch is async (the host registration methods are
    // Promise-returning); flush microtasks so the capability-gate rejection
    // routes to register-error before asserting.
    await flush();
    expect(host.registerHandler).not.toHaveBeenCalled();
    const err = workerHost.sent.find((m) => m.type === "register-error");
    expect(err).toMatchObject({ registrationKey: "handler:secret" });
    expect(err.error).toMatch(/PERMISSION_REQUIRED/);
  });

  it("registers a typed handler when its required capability is declared", async () => {
    const { host, workerHost } = makeBridge({ capabilities: ["worktree:read"] });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "ok", hasSchema: true, requires: ["worktree:read"] },
    });
    expect(host.registerHandler).toHaveBeenCalledWith("ok", expect.any(Function));
  });

  it("opens a worktree subscription and pushes events to the worker", async () => {
    const { host, workerHost } = makeBridge();
    let emitActive: ((s: unknown) => void) | undefined;
    host.onDidChangeActiveWorktree.mockImplementation((cb: any) => {
      emitActive = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s1",
      kind: "active-worktree",
    });
    expect(host.onDidChangeActiveWorktree).toHaveBeenCalled();
    emitActive?.({ id: "w9" });
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({ subscriptionId: "s1", payload: { id: "w9" } });
  });

  it("routes a system-wake subscription to host.onDidWake (#12175)", async () => {
    const { host, workerHost } = makeBridge();
    let emitWake: ((e: unknown) => void) | undefined;
    host.onDidWake.mockImplementation((cb: any) => {
      emitWake = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-wake",
      kind: "system-wake",
    });
    expect(host.onDidWake).toHaveBeenCalled();
    emitWake?.({ sleepDuration: 42_000, timestamp: 1234 });
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({
      subscriptionId: "s-wake",
      payload: { sleepDuration: 42_000, timestamp: 1234 },
    });
  });

  it("routes a terminal-lifecycle subscription to host.onDidChangeTerminalLifecycle (#13814)", async () => {
    const { host, workerHost } = makeBridge();
    let emitLifecycle: ((e: unknown) => void) | undefined;
    host.onDidChangeTerminalLifecycle.mockImplementation((cb: any) => {
      emitLifecycle = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-term",
      kind: "terminal-lifecycle",
    });
    expect(host.onDidChangeTerminalLifecycle).toHaveBeenCalled();
    // A discrete stream: no debounce option is passed through.
    expect(host.onDidChangeTerminalLifecycle.mock.calls[0]).toHaveLength(1);
    emitLifecycle?.({ type: "spawned", terminalId: "t1", kind: "shell", timestamp: 1 });
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({
      subscriptionId: "s-term",
      payload: { type: "spawned", terminalId: "t1", kind: "shell", timestamp: 1 },
    });
  });

  it("disposes a subscription on unsubscribe", async () => {
    const { host, workerHost } = makeBridge();
    const dispose = vi.fn();
    host.onDidChangeWorktrees.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s2",
      kind: "worktrees",
    });
    // Subscribe is async now (onDidChangeWorktrees resolves the disposer); flush
    // so the disposer is recorded before the unsubscribe looks it up — mirrors
    // the per-message task boundary the MessagePort provides in production.
    await flush();
    workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "s2" });
    expect(dispose).toHaveBeenCalled();
  });

  it("routes storage.get/set/delete host-calls to the real host", async () => {
    const { host, workerHost } = makeBridge();
    host.storage.get.mockResolvedValueOnce("stored");

    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sg",
      method: "storage.get",
      params: { key: "k", scope: "worktree" },
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "ss",
      method: "storage.set",
      params: { key: "k", value: 7, scope: "project" },
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sd",
      method: "storage.delete",
      params: { key: "k", scope: "user" },
    });
    await flush();

    expect(host.storage.get).toHaveBeenCalledWith("k", "worktree");
    expect(host.storage.set).toHaveBeenCalledWith("k", 7, "project");
    expect(host.storage.delete).toHaveBeenCalledWith("k", "user");

    const getReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sg");
    expect(getReply).toMatchObject({ ok: true, result: "stored" });
    const setReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "ss");
    expect(setReply).toMatchObject({ ok: true, result: undefined });
    const delReply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sd");
    expect(delReply).toMatchObject({ ok: true, result: undefined });
  });

  // #10586: an omitted scope must reach the real host as `undefined` (not a
  // defaulted "user") so the host resolves the key's manifest-declared scope. A
  // forwarded "user" would make the host reject a project-scoped key.
  it("forwards settings.get with an omitted scope as undefined", async () => {
    const { host, workerHost } = makeBridge();
    host.settings.get.mockResolvedValueOnce("project-value");
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sgu",
      method: "settings.get",
      params: { key: "ref" },
    });
    await flush();
    expect(host.settings.get).toHaveBeenCalledWith("ref", undefined);
    const reply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "sgu");
    expect(reply).toMatchObject({ ok: true, result: "project-value" });
  });

  it("forwards an explicit settings.get scope unchanged", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "sge",
      method: "settings.get",
      params: { key: "ref", scope: "project" },
    });
    await flush();
    expect(host.settings.get).toHaveBeenCalledWith("ref", "project");
  });

  it("forwards settings.unset with an omitted scope as undefined", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "su1",
      method: "settings.unset",
      params: { key: "token" },
    });
    await flush();
    expect(host.settings.unset).toHaveBeenCalledWith("token", undefined);
    const reply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "su1");
    expect(reply).toMatchObject({ ok: true });
  });

  it("forwards system.openExternal to the host and relays its rejection", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "oe1",
      method: "system.openExternal",
      params: { url: "https://example.com/a" },
    });
    await flush();
    expect(host.system.openExternal).toHaveBeenCalledWith("https://example.com/a");

    host.system.openExternal.mockRejectedValueOnce(new Error("RATE_LIMITED: slow down"));
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "oe2",
      method: "system.openExternal",
      params: { url: "https://example.com/b" },
    });
    await flush();
    const reply = workerHost.sent.find((m) => m.type === "host-result" && m.requestId === "oe2");
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).toContain("RATE_LIMITED");
  });

  it("opens a storage subscription and pushes events to the worker", async () => {
    const { host, workerHost } = makeBridge();
    let emit: ((v: unknown) => void) | undefined;
    host.storage.onDidChange.mockImplementation((_key: any, cb: any) => {
      emit = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "st1",
      kind: "storage",
      key: "k",
      scope: "worktree",
    });
    await flush();
    expect(host.storage.onDidChange).toHaveBeenCalledWith("k", expect.any(Function), "worktree");
    emit?.("v9");
    const evt = workerHost.sent.find((m) => m.type === "subscription-event");
    expect(evt).toMatchObject({ subscriptionId: "st1", payload: "v9" });
  });

  it("drops a storage subscription that is missing its key", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "st2",
      kind: "storage",
    });
    await flush();
    expect(host.storage.onDidChange).not.toHaveBeenCalled();
    // The bridge never sends a subscription-event for the dropped subscription.
    expect(workerHost.sent.some((m) => m.type === "subscription-event")).toBe(false);
  });

  it("resolves waitForActivation on `activated` and rejects on `activate-error`", async () => {
    const ok = makeBridge();
    const okPromise = ok.bridge.waitForActivation();
    ok.workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    await expect(okPromise).resolves.toBeUndefined();

    const bad = makeBridge();
    const badPromise = bad.bridge.waitForActivation();
    bad.workerHost.emit("worker-message", { type: "activate-error", error: "nope" });
    await expect(badPromise).rejects.toThrow("nope");
  });

  it("reports every activation outcome, not just the first, via onActivationResult", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});

    // Initial activation succeeds; a later one (crash respawn) fails.
    workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    workerHost.emit("worker-message", { type: "activate-error", error: "broke on reload" });

    expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
    expect(onActivationResult).toHaveBeenNthCalledWith(2, { ok: false, error: "broke on reload" });
  });

  it("surfaces a dev-worker crash loop as a loadError via onActivationResult", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});

    // Activate first, so the crash loop trips after a successful activation —
    // the regression this guards: the post-activation crash never reached
    // provenance because onCrashLoop only rejected the (already-settled)
    // activation promise.
    workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    workerHost.emit("crash-loop", 42);

    expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
    expect(onActivationResult).toHaveBeenNthCalledWith(2, {
      ok: false,
      error: expect.stringContaining("crash loop (code 42)"),
    });
  });

  it("surfaces a crash loop that trips before the first activation", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    const activation = bridge.waitForActivation();
    activation.catch(() => {});

    workerHost.emit("crash-loop", 7);

    await expect(activation).rejects.toThrow("crash loop");
    expect(onActivationResult).toHaveBeenCalledTimes(1);
    expect(onActivationResult).toHaveBeenCalledWith({
      ok: false,
      error: expect.stringContaining("crash loop (code 7)"),
    });
  });

  describe("required registration activation (#12282)", () => {
    /** A registration whose main-side deep validation the test drives by hand. */
    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    } {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = () => res();
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    /** The shape the worker proxy posts for `registerAction` — keyed, so it is a
     * required registration the activation commit has to account for. */
    const ACTION_NOTIFY = {
      type: "host-notify",
      method: "registerAction",
      registrationKey: "action:acme.demo.greet",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    };

    it("holds activation open until a required registration settles", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      let resolved = false;
      const activation = bridge.waitForActivation().then(() => {
        resolved = true;
      });

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      // `activated` has landed, but the contribution the plugin believes it made
      // is still unvalidated — committing here is the bug.
      expect(resolved).toBe(false);
      expect(onActivationResult).not.toHaveBeenCalled();

      gate.resolve();
      await activation;
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("tracks two proposals of the same registration key independently", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const first = deferred();
      const second = deferred();
      host.registerAction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      bridge.waitForActivation().catch(() => {});

      // Re-registering an id is legal (replace semantics), so the key is not a
      // unique handle — only object identity stops one proposal from releasing
      // the other's slot and committing while validation is still outstanding.
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      second.resolve();
      await flush();
      expect(onActivationResult).not.toHaveBeenCalled();

      first.resolve();
      await flush();
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("does not commit before `activated`, even with every registration settled", async () => {
      const onActivationResult = vi.fn();
      const { workerHost, bridge } = makeBridge({ onActivationResult });
      let resolved = false;
      const activation = bridge.waitForActivation().then(() => {
        resolved = true;
      });

      // activate() registered early and is still awaiting other work. A settled
      // registration is not an activation.
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      expect(resolved).toBe(false);
      expect(onActivationResult).not.toHaveBeenCalled();

      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await activation;
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("drops a required registration that settles after dispose", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      bridge.dispose();
      await expect(activation).rejects.toThrow(/disposed/);

      onActivationResult.mockClear();
      workerHost.sent.length = 0;
      gate.reject(new Error("host went away"));
      await flush();

      expect(onActivationResult).not.toHaveBeenCalled();
      expect(workerHost.sent).toEqual([]);
    });

    it("fails activation naming the contribution when a required registration is rejected", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(
        new Error('descriptor.id "greet" is not declared in contributes.actions')
      );
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      await expect(activation).rejects.toThrow(/action:acme\.demo\.greet/);
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({
        ok: false,
        error: expect.stringContaining('registration "action:acme.demo.greet" was rejected'),
        stack: expect.any(String),
      });
      expect(onActivationResult.mock.calls[0][0].error).toContain("contributes.actions");
      // The worker's own terminal feedback must not regress.
      expect(workerHost.sent.find((m) => m.type === "register-error")).toMatchObject({
        registrationKey: "action:acme.demo.greet",
      });
    });

    it("remembers a registration rejection that lands before `activated`", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it("neither waits for nor fails activation on notifications without a registration key", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      // A never-settling call and a rejecting one. Neither is a contribution, so
      // neither participates in the activation commit.
      host.setPanelBadge
        .mockReturnValueOnce(deferred().promise)
        .mockRejectedValueOnce(new Error("bad badge"));
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "setPanelBadge",
        params: { panelId: "p1", badge: { kind: "label", text: "CI", color: "success" } },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "setPanelBadge",
        params: { panelId: "p2", badge: null },
      });
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });

      await expect(activation).resolves.toBeUndefined();
      await flush();
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
      expect(workerHost.sent.find((m) => m.type === "register-error")).toBeUndefined();
    });

    it("keeps the contribution-specific failure when activate-error follows it", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      workerHost.emit("worker-message", { type: "activate-error", error: "activate() threw" });

      // The rejected contribution names what the author has to fix; the vaguer
      // activate-error that follows must not overwrite it.
      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult.mock.calls[0][0].error).toContain("action:acme.demo.greet");
    });

    it("keeps activate-error terminal while a required registration is still pending", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const gate = deferred();
      host.registerAction.mockReturnValueOnce(gate.promise);
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      workerHost.emit("worker-message", { type: "activate-error", error: "boom" });
      // The straggler settling successfully must not commit over the failure.
      gate.resolve();
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "boom" })
      );
    });

    it("keeps a rejected registration as the reported failure when the worker then breaks the protocol", async () => {
      // #12276 × #12282: a protocol violation is terminal, but it reports a
      // generic phrase — it must go through the same latch, so the rejected
      // contribution (the thing the author can actually fix) stays the recorded
      // loadError rather than being relabelled by the teardown behind it.
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge, onTerminalFailure } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(
        new Error('descriptor.id "greet" is not declared in contributes.actions')
      );
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await expect(activation).rejects.toThrow(/action:acme\.demo\.greet/);

      workerHost.emit("worker-message", null);

      const failures = onActivationResult.mock.calls
        .map(([r]: any[]) => r)
        .filter((r: any) => !r.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toContain('registration "action:acme.demo.greet" was rejected');
      // Latched reporting, not latched teardown: the worker still stops.
      expect(workerHost.dispose).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });

    it("ignores a required registration that rejects after the generation was retired", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const stale = deferred();
      host.registerAction.mockReturnValueOnce(stale.promise);
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("exit", 139, false);
      // The respawn boots, re-proposes the same contribution, activates.
      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });

      onActivationResult.mockClear();
      workerHost.sent.length = 0;
      stale.reject(new Error("dead generation"));
      await flush();

      expect(onActivationResult).not.toHaveBeenCalled();
      expect(workerHost.sent.find((m) => m.type === "register-error")).toBeUndefined();
    });

    it("reports a registration rejected after activation already succeeded", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      const activation = bridge.waitForActivation();

      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await expect(activation).resolves.toBeUndefined();

      host.registerAction.mockRejectedValueOnce(new Error("too late"));
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();

      // The activation promise has settled and has no listener left, so
      // provenance is the only channel that still reaches the author.
      expect(onActivationResult).toHaveBeenNthCalledWith(1, { ok: true });
      expect(onActivationResult).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining("action:acme.demo.greet"),
        })
      );
    });

    it("lets a dying worker's activate-error veto neither the replacement nor its success", async () => {
      const onActivationResult = vi.fn();
      const { workerHost, bridge } = makeBridge({ onActivationResult });
      bridge.waitForActivation().catch(() => {});

      // The worker dies while activate() is still awaiting a host call, and the
      // activate-error it had already posted arrives behind the exit that
      // bumped the generation. It describes a worker that no longer exists and
      // must not bind the one now booting.
      workerHost.emit("exit", 139, false);
      workerHost.emit("worker-message", { type: "activate-error", error: "torn down mid-await" });
      // What the outgoing child died of still reaches provenance...
      expect(onActivationResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "torn down mid-await" })
      );
      onActivationResult.mockClear();

      // ...but it must not veto the respawn, whose success clears it again.
      workerHost.emit("ready");
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("does not enlist a required registration posted by a retired worker", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      bridge.waitForActivation().catch(() => {});

      // Same gap, a keyed host-notify this time: the straggler's rejection is
      // still reported to the worker, but it is not the booting generation's
      // contribution and cannot fail its activation.
      workerHost.emit("exit", 139, false);
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      workerHost.emit("worker-message", ACTION_NOTIFY);
      await flush();
      expect(onActivationResult).not.toHaveBeenCalled();
      // The worker still gets told, exactly as before.
      expect(workerHost.sent.find((m) => m.type === "register-error")).toMatchObject({
        registrationKey: "action:acme.demo.greet",
      });

      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenCalledTimes(1);
      expect(onActivationResult).toHaveBeenCalledWith({ ok: true });
    });

    it("clears a registration failure so the next generation can activate", async () => {
      const onActivationResult = vi.fn();
      const { host, workerHost, bridge } = makeBridge({ onActivationResult });
      host.registerAction.mockRejectedValueOnce(new Error("not declared"));
      bridge.waitForActivation().catch(() => {});

      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();
      expect(onActivationResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));

      // The worker crashes and the host respawns it — the new generation starts
      // from a clean verdict.
      workerHost.emit("exit", 139, false);
      workerHost.emit("ready");
      workerHost.emit("worker-message", ACTION_NOTIFY);
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      await flush();

      expect(onActivationResult).toHaveBeenLastCalledWith({ ok: true });
    });
  });

  it("registerFileDecorationProvider wires a proxy impl that round-trips provideDecorations", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      registrationKey: "fileDecorationProvider:acme.demo.deco",
      params: { descriptor: { id: "acme.demo.deco", scopes: ["pr"] } },
    });
    expect(host.registerFileDecorationProvider).toHaveBeenCalledTimes(1);
    const [descriptor, proxyImpl] = host.registerFileDecorationProvider.mock
      .calls[0] as unknown as [
      { id: string },
      { provideDecorations: (s: string, p: string[]) => Promise<unknown> },
    ];
    expect(descriptor).toMatchObject({ id: "acme.demo.deco", scopes: ["pr"] });

    const resultPromise = proxyImpl.provideDecorations("pr", ["a.ts", "b.ts"]);
    const invoke = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "file-decoration-method"
    );
    expect(invoke).toMatchObject({
      providerId: "acme.demo.deco",
      method: "provideDecorations",
      args: ["pr", ["a.ts", "b.ts"]],
    });

    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: { "a.ts": { badge: "M" } },
    });
    await expect(resultPromise).resolves.toEqual({ "a.ts": { badge: "M" } });
  });

  it("registerWorktreeSetupStep binds a handler that runs the worker's and cancels it on abort (#13807)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerWorktreeSetupStep",
      registrationKey: "worktreeSetupStep:db",
      params: { stepId: "db" },
    });
    await flush();
    expect(host.registerWorktreeSetupStep).toHaveBeenCalledTimes(1);
    const [stepId, handler] = host.registerWorktreeSetupStep.mock.calls[0] as unknown as [
      string,
      (ctx: Record<string, unknown>) => Promise<void>,
    ];
    expect(stepId).toBe("db");

    const context = {
      projectId: "project-1",
      worktreeId: "/repo/wt",
      worktreePath: "/repo/wt",
      branch: null,
    };
    const ok = handler({ ...context, signal: new AbortController().signal });
    const first = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "worktree-setup-step"
    );
    // The signal stays behind: it cannot cross the port.
    expect(first).toEqual({
      type: "invoke",
      requestId: first.requestId,
      kind: "worktree-setup-step",
      stepId: "db",
      context,
    });
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: first.requestId,
      ok: true,
      result: null,
    });
    await expect(ok).resolves.toBeUndefined();

    const controller = new AbortController();
    const cancelled = handler({ ...context, signal: controller.signal });
    const second = workerHost.sent.filter(
      (m) => m.type === "invoke" && m.kind === "worktree-setup-step"
    )[1];
    controller.abort(new Error("timed out"));
    await expect(cancelled).rejects.toThrow();
    expect(workerHost.sent.at(-1)).toEqual({ type: "invoke-cancel", requestId: second.requestId });
  });

  it("unregisterWorktreeSetupStep disposes the host registration", async () => {
    const { host, workerHost } = makeBridge();
    const dispose = vi.fn();
    host.registerWorktreeSetupStep.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerWorktreeSetupStep",
      params: { stepId: "db" },
    });
    await flush();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "unregisterWorktreeSetupStep",
      params: { stepId: "db" },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("registerContextProvider round-trips search and cancels the worker call when main stops waiting (#13795)", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerContextProvider",
      registrationKey: "contextProvider:cards",
      params: { descriptor: { id: "cards" } },
    });
    await flush();
    expect(host.registerContextProvider).toHaveBeenCalledTimes(1);
    const [descriptor, proxyImpl] = host.registerContextProvider.mock.calls[0] as unknown as [
      { id: string },
      {
        search: (q: string, o: { signal: AbortSignal }) => Promise<unknown>;
        resolve: (id: string, o: { signal: AbortSignal }) => Promise<unknown>;
      },
    ];
    expect(descriptor).toEqual({ id: "cards" });

    const found = proxyImpl.search("fix", { signal: new AbortController().signal });
    const search = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "context-provider-method" && m.method === "search"
    );
    expect(search).toMatchObject({ providerId: "cards", args: ["fix"] });
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: search.requestId,
      ok: true,
      result: [{ id: "1", label: "Fix" }],
    });
    await expect(found).resolves.toEqual([{ id: "1", label: "Fix" }]);

    const controller = new AbortController();
    const resolving = proxyImpl.resolve("7", { signal: controller.signal });
    const resolve = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "context-provider-method" && m.method === "resolve"
    );
    controller.abort(new Error("timed out"));
    await expect(resolving).rejects.toThrow();
    expect(workerHost.sent).toContainEqual({ type: "invoke-cancel", requestId: resolve.requestId });
  });

  it("unregisterFileDecorationProvider disposes the host registration", async () => {
    const { host, workerHost } = makeBridge();
    const dispose = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(dispose);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    // registerFileDecorationProvider records its disposer after awaiting the
    // (now Promise-returning) host registration; flush so the unregister finds it.
    await flush();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "unregisterFileDecorationProvider",
      params: { providerId: "acme.demo.deco" },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("registerWorktreeDeleteNotesProvider round-trips provideNotes and cancels it at the host's deadline (#13805)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerWorktreeDeleteNotesProvider",
      registrationKey: "worktreeDeleteNotesProvider:notes",
      params: { descriptor: { id: "notes" } },
    });
    expect(host.registerWorktreeDeleteNotesProvider).toHaveBeenCalledTimes(1);
    const [descriptor, proxyImpl] = host.registerWorktreeDeleteNotesProvider.mock
      .calls[0] as unknown as [
      { id: string },
      { provideNotes: (worktree: unknown, signal?: AbortSignal) => Promise<unknown> },
    ];
    expect(descriptor).toEqual({ id: "notes" });

    const answered = proxyImpl.provideNotes({ id: "/repo/wt" });
    const first = workerHost.sent.find(
      (m) => m.type === "invoke" && m.kind === "worktree-delete-notes"
    );
    expect(first).toMatchObject({ providerId: "notes", worktree: { id: "/repo/wt" } });
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: first.requestId,
      ok: true,
      result: [{ severity: "info", text: "hi" }],
    });
    await expect(answered).resolves.toEqual([{ severity: "info", text: "hi" }]);

    const deadline = new AbortController();
    const abandoned = proxyImpl.provideNotes({ id: "/repo/wt" }, deadline.signal);
    expect(bridge.pendingInvokeCount).toBe(1);
    deadline.abort(new Error("timed out"));
    await expect(abandoned).rejects.toThrow();
    expect(bridge.pendingInvokeCount).toBe(0);
    expect(workerHost.sent.some((m) => m.type === "invoke-cancel")).toBe(true);
  });

  it("keeps worktree delete notes and decoration providers apart when they share an id", async () => {
    const { host, workerHost } = makeBridge();
    const disposeNotes = vi.fn();
    const disposeDeco = vi.fn();
    host.registerWorktreeDeleteNotesProvider.mockReturnValueOnce(disposeNotes);
    host.registerFileDecorationProvider.mockReturnValueOnce(disposeDeco);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerWorktreeDeleteNotesProvider",
      params: { descriptor: { id: "shared" } },
    });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "shared", scopes: ["pr"] } },
    });
    await flush();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "unregisterWorktreeDeleteNotesProvider",
      params: { providerId: "shared" },
    });
    expect(disposeNotes).toHaveBeenCalledTimes(1);
    expect(disposeDeco).not.toHaveBeenCalled();
  });

  it("fails pending invokes when the worker crashes (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerAction",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    });
    const wrapper = host.registerAction.mock.calls[0][1] as (a: unknown) => Promise<unknown>;
    const pending = wrapper({});
    pending.catch(() => {});

    // A crash, not a reload: the host respawns a worker that has never seen
    // this request id, so nothing will ever reply to it. Before #12216 the
    // caller simply waited forever.
    workerHost.emit("exit", 139, false);

    await expect(pending).rejects.toThrow(/crashed \(code 139\)/);
  });

  it("fails pending invokes when the worker exits expectedly (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerAction",
      params: {
        descriptor: {
          id: "greet",
          title: "Greet",
          description: "",
          category: "Demo",
          kind: "command",
          danger: "safe",
        },
      },
    });
    const wrapper = host.registerAction.mock.calls[0][1] as (a: unknown) => Promise<unknown>;
    const pending = wrapper({});
    pending.catch(() => {});

    workerHost.emit("exit", 0, true);

    await expect(pending).rejects.toThrow(/stopped before invocation completed/);
  });

  it("aborts in-flight host calls when the worker dies (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let seenSignal: AbortSignal | undefined;
    host.fs.readFile.mockImplementation((async (_p: string, opts: { signal?: AbortSignal }) => {
      seenSignal = opts.signal;
      return new Promise<string>(() => {});
    }) as unknown as () => Promise<string>);
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "h1",
      method: "fs.readFile",
      params: { path: "/repo/a.txt" },
    });
    await flush();

    workerHost.emit("exit", 139, false);
    // The worker is gone, so the read has nowhere to deliver — cancel the I/O
    // rather than let it complete against a dead generation.
    expect(seenSignal?.aborted).toBe(true);
  });

  // #12279: a prompt is the one host call the user can SEE. Retiring the
  // generation that asked must take the question off the screen, not just drop
  // the answer — otherwise the user is left answering a dead worker, and the
  // per-plugin one-prompt cap makes the successor's first prompt resolve
  // instantly to its cancel value.
  describe.each([
    { method: "showQuickPick", params: { items: [{ id: "a", label: "A" }] }, signalArg: 2 },
    { method: "showInputBox", params: { options: {} }, signalArg: 1 },
    { method: "showConfirm", params: { options: { title: "Sure?" } }, signalArg: 1 },
    // The send-to-agent picker is a prompt too.
    { method: "sendToAgent", params: { text: "body", options: {} }, signalArg: 2 },
  ])("$method cancellation (#12279)", ({ method, params, signalArg }) => {
    const openPrompt = async (host: any, workerHost: FakeWorkerHost) => {
      let seenSignal: AbortSignal | undefined;
      host[method].mockImplementation((...args: any[]) => {
        seenSignal = args[signalArg]?.signal;
        // A prompt has no deadline — it stays open until the user answers.
        return new Promise(() => {});
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "p1",
        method,
        params,
      });
      await flush();
      return () => seenSignal;
    };

    it("forwards a signal that the generation boundary aborts", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const signal = await openPrompt(host, workerHost);
      expect(signal()).toBeDefined();
      expect(signal()?.aborted).toBe(false);

      // A crash is the only boundary this bridge is carried across now — a
      // rebuild disposes the bridge outright instead (#12277).
      workerHost.emit("exit", 139, false);

      expect(signal()?.aborted).toBe(true);
    });
  });

  it("still cancels prompts when registration cleanup throws at the boundary (#12279)", async () => {
    const clear = vi.fn(() => {
      throw new Error("registration cleanup exploded");
    });
    const { host, workerHost, bridge } = makeBridge({ clear });
    bridge.waitForActivation().catch(() => {});
    let seenSignal: AbortSignal | undefined;
    (host.showConfirm as any).mockImplementation((_o: any, call?: any) => {
      seenSignal = call?.signal;
      return new Promise(() => {});
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "p1",
      method: "showConfirm",
      params: { options: { title: "Sure?" } },
    });
    await flush();

    // A throwing teardown step must not strand a dialog on the user's screen,
    // nor skip the rest of the cascade (#9322).
    expect(() => workerHost.emit("exit", 139, false)).not.toThrow();
    expect(seenSignal?.aborted).toBe(true);
    expect(clear).toHaveBeenCalled();
  });

  it("retires the crashed generation's registrations and subscriptions (#12216)", async () => {
    const { host, workerHost, bridge, clear } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    const disposeProvider = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(disposeProvider);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    await flush();

    workerHost.emit("exit", 139, false);

    // A crash is the same generation boundary a reload is: the replacement
    // re-runs activate() and re-registers, so anything left behind is a
    // duplicate it cannot address.
    expect(disposeProvider).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalled();
  });

  it("drops a late host-result from a crashed generation (#12216)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let settle: ((v: string) => void) | undefined;
    host.fs.readFile.mockImplementation(
      () =>
        new Promise<string>((res) => {
          settle = res;
        })
    );
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "h1",
      method: "fs.readFile",
      params: { path: "/repo/a.txt" },
    });
    await flush();

    workerHost.emit("exit", 139, false);
    workerHost.sent.length = 0;

    // The replacement worker's requestId counter restarts from scratch, so a
    // result from the dead generation could otherwise be delivered against a
    // colliding id.
    settle?.("stale contents");
    await flush();

    expect(workerHost.sent.filter((m) => m.type === "host-result")).toEqual([]);
  });

  it("leaves an idle bridge's generation intact on an expected exit (#12216)", async () => {
    const clear = vi.fn();
    const { host, workerHost, bridge } = makeBridge({ clear });
    bridge.waitForActivation().catch(() => {});
    const disposeProvider = vi.fn();
    host.registerFileDecorationProvider.mockReturnValueOnce(disposeProvider);
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerFileDecorationProvider",
      params: { descriptor: { id: "acme.demo.deco" } },
    });
    await flush();
    clear.mockClear();

    // An expected exit is a deliberate stop, and the bridge is disposed before
    // the host that owns the worker — so a straggler admitted in the gap must
    // not tear registrations down on its way past.
    workerHost.emit("exit", 0, true);

    expect(disposeProvider).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("drops a subscription event queued before a reload (generation guard) (#10526)", async () => {
    const { host, workerHost, bridge } = makeBridge();
    bridge.waitForActivation().catch(() => {});
    let emitActive: ((s: unknown) => void) | undefined;
    host.onDidChangeActiveWorktree.mockImplementation((cb: any) => {
      emitActive = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s1",
      kind: "active-worktree",
    });
    await flush();
    // Retiring the generation tears the old subscription down.
    workerHost.emit("exit", 1, false);
    workerHost.sent.length = 0;
    // A late event from the now-dead subscription must NOT reach the new worker
    // (its proxy resets subscriptionIds and could collide on "s1").
    emitActive?.({ id: "stale" });
    expect(workerHost.sent.find((m) => m.type === "subscription-event")).toBeUndefined();
  });

  it("forwards the activate-error stack through onActivationResult (#10526)", async () => {
    const onActivationResult = vi.fn();
    const { workerHost, bridge } = makeBridge({ onActivationResult });
    bridge.waitForActivation().catch(() => {});
    workerHost.emit("worker-message", {
      type: "activate-error",
      error: "boom",
      stack: "Error: boom\n  at activate",
    });
    expect(onActivationResult).toHaveBeenCalledWith({
      ok: false,
      error: "boom",
      stack: "Error: boom\n  at activate",
    });
  });

  describe("host.process relay (#10526)", () => {
    async function spawn<T = ReturnType<typeof makeProcessHandle>>(
      workerHost: any,
      host: any,
      handle: T = makeProcessHandle("p1") as T
    ): Promise<T> {
      host.process.spawn.mockResolvedValueOnce(handle);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "spawn1",
        method: "process.spawn",
        params: { command: "node", options: { args: ["x.js"] } },
      });
      await flush();
      return handle;
    }

    it("kills a handle that arrives after the worker gave up on the spawn (#13410)", async () => {
      const { host, workerHost } = makeBridge();
      const handle = makeProcessHandle("late");
      let settle!: (value: typeof handle) => void;
      host.process.spawn.mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            settle = resolve;
          })
      );
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "spawn-late",
        method: "process.spawn",
        params: { command: "node", options: {} },
      });
      await flush();
      workerHost.emit("worker-message", { type: "host-cancel", requestId: "spawn-late" });
      settle(handle);
      await flush();
      expect(handle.kill).toHaveBeenCalledTimes(1);
      // Never stored, so a later restart by id finds nothing to act on.
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "restart-late",
        method: "process.restart",
        params: { processId: "late" },
      });
      await flush();
      expect(handle.restart).not.toHaveBeenCalled();
    });

    it("relays spawn to the host and replies with the handle id", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host);
      expect(host.process.spawn).toHaveBeenCalledWith("node", { args: ["x.js"] });
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      expect(res).toMatchObject({ ok: true, result: { id: "p1" } });
    });

    it("reports mode from the handle the host actually built, not the request", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host, makePtyProcessHandle("p1"));
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      // The worker proxy builds write()/resize() off this value, so it must
      // describe the real backend.
      expect(res).toMatchObject({ ok: true, result: { id: "p1", mode: "pty" } });
    });

    it("classifies a write-only handle as duplex, not pipe (#11871)", async () => {
      const { host, workerHost } = makeBridge();
      await spawn(workerHost, host, makeDuplexProcessHandle("p1"));
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "spawn1"
      );
      // Misreporting this as "pipe" would leave the worker proxy building a
      // handle with no write() for a child whose stdin is genuinely open.
      expect(res).toMatchObject({ ok: true, result: { id: "p1", mode: "duplex" } });
    });

    it("relays write to a duplex handle but refuses resize (#11871)", async () => {
      const { host, workerHost } = makeBridge();
      const handle: any = await spawn(workerHost, host, makeDuplexProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: '{"jsonrpc":"2.0"}\n' },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 120, rows: 40 },
      });
      await flush();

      expect(handle.write).toHaveBeenCalledWith('{"jsonrpc":"2.0"}\n');
      // The resize notification must be DROPPED, not rerouted or thrown: exactly
      // one relayed call total, so nothing turned the resize into a second write.
      expect(handle.write).toHaveBeenCalledTimes(1);
      // A duplex child has no terminal, so resize is not part of its shape.
      expect(handle.resize).toBeUndefined();
    });

    it("relays write and resize to an interactive handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: "q\n" },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 120, rows: 40 },
      });
      await flush();
      expect(handle.write).toHaveBeenCalledWith("q\n");
      expect(handle.resize).toHaveBeenCalledWith(120, 40);
    });

    it("refuses a fabricated write/resize against a pipe-mode handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle: any = await spawn(workerHost, host, makeProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "p1", data: "x" },
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.resize",
        params: { processId: "p1", cols: 10, rows: 10 },
      });
      await flush();
      // A pipe child has stdin closed; the proxy never exposes these, so
      // reaching here means the payload was fabricated.
      expect((handle as any).write).toBeUndefined();
      expect(host.process.spawn).toHaveBeenCalledTimes(1);
    });

    it("ignores a write for an unknown process id", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.write",
        params: { processId: "nope", data: "x" },
      });
      await flush();
      expect(handle.write).not.toHaveBeenCalled();
    });

    it("opens a process-data subscription and streams chunks to the worker", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host, makePtyProcessHandle("p1"));
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s9",
        kind: "process-data",
        processId: "p1",
      });
      await flush();
      expect(handle.onData).toHaveBeenCalled();

      handle.emitData({ stream: "data", chunk: "$ " });
      const event = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "s9"
      );
      expect(event).toMatchObject({ payload: { stream: "data", chunk: "$ " } });
    });

    it("process.kill notify kills the stored handle", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "process.kill",
        params: { processId: "p1" },
      });
      await flush();
      expect(handle.kill).toHaveBeenCalled();
    });

    it("process.restart awaits the stored handle's restart", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "r1",
        method: "process.restart",
        params: { processId: "p1" },
      });
      await flush();
      expect(handle.restart).toHaveBeenCalled();
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "r1"
      );
      expect(res).toMatchObject({ ok: true });
    });

    it("process.restart for an unknown process replies with an error", async () => {
      const { workerHost } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "r2",
        method: "process.restart",
        params: { processId: "ghost" },
      });
      await flush();
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "r2"
      );
      expect(res).toMatchObject({ ok: false });
      expect(res.error).toMatch(/No live process/);
    });

    it("process-exit subscription pushes exit events to the worker", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s1",
        kind: "process-exit",
        processId: "p1",
      });
      expect(handle.onExit).toHaveBeenCalled();
      handle.emitExit({ exitCode: 0, signal: null });
      const evt = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "s1"
      );
      expect(evt).toMatchObject({ payload: { exitCode: 0, signal: null } });
    });

    it("process-crash subscription wires onCrash", async () => {
      const { host, workerHost } = makeBridge();
      const handle = await spawn(workerHost, host);
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s2",
        kind: "process-crash",
        processId: "p1",
      });
      expect(handle.onCrash).toHaveBeenCalled();
    });

    it("kills spawned processes on dispose", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const handle = await spawn(workerHost, host);
      bridge.dispose();
      expect(handle.kill).toHaveBeenCalled();
    });

    it("kills spawned processes when a generation is retired", async () => {
      const { host, workerHost, bridge } = makeBridge();
      bridge.waitForActivation().catch(() => {});
      const handle = await spawn(workerHost, host);
      workerHost.emit("exit", 1, false);
      expect(handle.kill).toHaveBeenCalled();
    });
  });

  describe("host.fs.watch relay (#10526)", () => {
    it("wires the host watcher and pushes change events keyed by subscription id", async () => {
      const { host, workerHost } = makeBridge();
      let changeCb: ((p: string) => void) | undefined;
      host.fs.watch.mockImplementationOnce(async (_paths: string[], cb: (p: string) => void) => {
        changeCb = cb;
        return vi.fn();
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w1",
        method: "fs.watch",
        params: { subscriptionId: "fs1", paths: ["/repo/a.ts"] },
      });
      await flush();
      expect(host.fs.watch).toHaveBeenCalledWith(
        ["/repo/a.ts"],
        expect.any(Function),
        expect.objectContaining({ signal: expect.anything() })
      );
      changeCb?.("/repo/a.ts");
      const evt = workerHost.sent.find(
        (m: any) => m.type === "subscription-event" && m.subscriptionId === "fs1"
      );
      expect(evt).toMatchObject({ payload: "/repo/a.ts" });
    });

    it("disposes the watcher on unsubscribe", async () => {
      const { host, workerHost } = makeBridge();
      const dispose = vi.fn();
      host.fs.watch.mockResolvedValueOnce(dispose);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w2",
        method: "fs.watch",
        params: { subscriptionId: "fs2", paths: ["/repo"] },
      });
      await flush();
      workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "fs2" });
      expect(dispose).toHaveBeenCalled();
    });

    it("forwards recursive and debounceMs only when the worker sent them", async () => {
      const { host, workerHost } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w4",
        method: "fs.watch",
        params: { subscriptionId: "fs4", paths: ["/repo"], recursive: true, debounceMs: 200 },
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w5",
        method: "fs.watch",
        params: { subscriptionId: "fs5", paths: ["/repo"] },
      });
      await flush();
      const optionsOf = (call: number) => (host.fs.watch.mock.calls[call] as unknown[])[2];
      expect(optionsOf(0)).toMatchObject({ recursive: true, debounceMs: 200 });
      expect(optionsOf(1)).not.toHaveProperty("recursive");
      expect(optionsOf(1)).not.toHaveProperty("debounceMs");
    });

    it("forwards a supplied recursive unchanged so the host can reject a malformed one", async () => {
      const { host, workerHost } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w6",
        method: "fs.watch",
        params: { subscriptionId: "fs6", paths: ["/repo"], recursive: "true" },
      });
      await flush();
      expect((host.fs.watch.mock.calls[0] as unknown[])[2]).toMatchObject({ recursive: "true" });
    });

    it("disposes a watch that settles after the worker cancelled it", async () => {
      const { host, workerHost } = makeBridge();
      const dispose = vi.fn();
      let settle!: (value: typeof dispose) => void;
      host.fs.watch.mockImplementationOnce(
        () =>
          new Promise<typeof dispose>((resolve) => {
            settle = resolve;
          })
      );
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "w7",
        method: "fs.watch",
        params: { subscriptionId: "fs7", paths: ["/repo"] },
      });
      await flush();
      workerHost.emit("worker-message", { type: "host-cancel", requestId: "w7" });
      settle(dispose);
      await flush();
      expect(dispose).toHaveBeenCalledTimes(1);
      // Nothing was kept for a later unsubscribe to find.
      workerHost.emit("worker-message", { type: "unsubscribe", subscriptionId: "fs7" });
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("host.fs revision, mkdir and append relay", () => {
    it("relays readFileWithRevision with the call's signal and returns the host result", async () => {
      const { host, workerHost } = makeBridge();
      const result = { contents: "rows", revision: "a".repeat(64) };
      host.fs.readFileWithRevision.mockResolvedValueOnce(result);
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "r1",
        method: "fs.readFileWithRevision",
        params: { path: "/repo/ledger.json" },
      });
      await flush();
      expect(host.fs.readFileWithRevision).toHaveBeenCalledWith(
        "/repo/ledger.json",
        expect.objectContaining({ signal: expect.anything() })
      );
      const res = workerHost.sent.find(
        (m: any) => m.type === "host-result" && m.requestId === "r1"
      );
      expect(res).toMatchObject({ ok: true, result });
    });

    it("relays mkdir and appendFile and resolves them void", async () => {
      const { host, workerHost } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "m1",
        method: "fs.mkdir",
        params: { path: "/repo/data" },
      });
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "a1",
        method: "fs.appendFile",
        params: { path: "/repo/data/log.jsonl", contents: "{}\n" },
      });
      await flush();
      expect(host.fs.mkdir).toHaveBeenCalledWith("/repo/data");
      expect(host.fs.appendFile).toHaveBeenCalledWith("/repo/data/log.jsonl", "{}\n");
      for (const requestId of ["m1", "a1"]) {
        const res = workerHost.sent.find(
          (m: any) => m.type === "host-result" && m.requestId === requestId
        );
        expect(res).toMatchObject({ ok: true, result: undefined });
      }
    });
  });

  describe("protocol violations (#12276)", () => {
    /** The reason recorded as the plugin's user-visible loadError, if any. */
    function recordedError(onActivationResult: any): string | undefined {
      const failure = onActivationResult.mock.calls.map(([r]: any[]) => r).find((r: any) => !r.ok);
      return failure?.error;
    }

    it("contains every malformed worker message instead of letting it throw", () => {
      // One bridge per input: the first violation disposes the bridge and drops
      // the listener, so a shared one would only ever test the first case.
      for (const raw of [
        null,
        42,
        "host-call",
        { type: "not-a-type" },
        { type: "host-call", requestId: "c1", method: "fs.unlink" },
        { type: "invoke-result", requestId: "i1", ok: "maybe" },
      ]) {
        const { host, workerHost, onActivationResult, onTerminalFailure } = makeBridge();
        const label = JSON.stringify(raw) ?? "null";
        expect(() => workerHost.emit("worker-message", raw), label).not.toThrow();
        expect(recordedError(onActivationResult), label).toContain("acme.demo");
        expect(workerHost.dispose, label).toHaveBeenCalledTimes(1);
        expect(onTerminalFailure, label).toHaveBeenCalledTimes(1);
        expect(host.getWorktrees, label).not.toHaveBeenCalled();
      }
    });

    it("reports a violation the host detected and stops that worker", async () => {
      const { workerHost, onActivationResult, onTerminalFailure, bridge } = makeBridge();
      const activation = bridge.waitForActivation();
      workerHost.emit("protocol-violation", "worker sent a malformed message");
      await expect(activation).rejects.toThrow(/worker sent a malformed message/);
      expect(recordedError(onActivationResult)).toContain("worker sent a malformed message");
      expect(workerHost.dispose).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });

    it("still records provenance for a violation after a successful activation", () => {
      const { workerHost, onActivationResult } = makeBridge();
      workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      expect(onActivationResult as any).toHaveBeenCalledWith({ ok: true });
      workerHost.emit("worker-message", null);
      // The activation promise has already settled, so `onActivationResult` is
      // the only channel left that reaches the plugin's loadError.
      expect(recordedError(onActivationResult)).toBeDefined();
    });

    it("keeps the rejected message out of the reason it reports", () => {
      const { workerHost, onActivationResult } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "",
        method: "getWorktrees",
        params: { token: "s3cret-value" },
      });
      const error = recordedError(onActivationResult) ?? "";
      expect(error).not.toContain("s3cret-value");
      expect(error).not.toContain("requestId");
      expect(error).toContain("acme.demo");
    });

    it("fails the instance when the worker reuses an outstanding request id", async () => {
      const { host, workerHost, onActivationResult, bridge } = makeBridge();
      host.getWorktrees.mockImplementation(() => new Promise(() => {}));
      const call = { type: "host-call", requestId: "c1", method: "getWorktrees" };
      workerHost.emit("worker-message", { ...call });
      await flush();
      expect(bridge.pendingHostCallCount).toBe(1);

      workerHost.emit("worker-message", { ...call });
      await flush();
      expect(host.getWorktrees).toHaveBeenCalledTimes(1);
      expect(recordedError(onActivationResult)).toContain("outstanding request id");
      expect(workerHost.dispose).toHaveBeenCalled();
      // The first call was released rather than left dangling, and its late
      // result can no longer be delivered under the contested id.
      expect(bridge.pendingHostCallCount).toBe(0);
      expect(workerHost.sent.filter((m) => m.type === "host-result")).toHaveLength(0);
    });

    it("lets a request id be reused once its call has settled", async () => {
      const { host, workerHost, onActivationResult } = makeBridge();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "c1",
        method: "getWorktrees",
      });
      await flush();
      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "c1",
        method: "getWorktrees",
      });
      await flush();
      expect(host.getWorktrees).toHaveBeenCalledTimes(2);
      expect(workerHost.sent.filter((m) => m.type === "host-result" && m.ok)).toHaveLength(2);
      expect((onActivationResult as any).mock.calls.every(([r]: any[]) => r.ok)).toBe(true);
      expect(workerHost.dispose).not.toHaveBeenCalled();
    });

    it("retires the generation's registrations and subscriptions", async () => {
      const { host, workerHost, clear } = makeBridge();
      const unsubscribe = vi.fn();
      let pushEvent: ((payload: unknown) => void) | undefined;
      host.onDidChangeWorktrees.mockImplementation((cb: any) => {
        pushEvent = cb;
        return unsubscribe;
      });
      workerHost.emit("worker-message", {
        type: "subscribe",
        subscriptionId: "s1",
        kind: "worktrees",
      });
      await flush();
      // Witness the before state, so an eager teardown during setup cannot pass.
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();

      workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "",
        method: "getWorktrees",
      });
      expect(clear).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      // The retired subscription can no longer push to the dead worker.
      const before = workerHost.sent.length;
      pushEvent?.([{ id: "w2" }]);
      expect(workerHost.sent).toHaveLength(before);
    });

    it("reports and tears down once even when teardown re-enters the ingress", () => {
      // The re-entrant message is delivered from INSIDE the failure report, so
      // the listener is still attached — this is what the latch is for.
      let reentered = false;
      const onActivationResult = vi.fn((result: any) => {
        if (result.ok || reentered) return;
        reentered = true;
        workerHost.emit("worker-message", 7);
        workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
      });
      const { workerHost, onTerminalFailure } = makeBridge({ onActivationResult });
      workerHost.emit("worker-message", null);

      expect(reentered).toBe(true);
      expect(onActivationResult.mock.calls.filter(([r]: any[]) => !r.ok)).toHaveLength(1);
      // A late `activated` must not overwrite the failure as the last word.
      expect(onActivationResult.mock.calls.filter(([r]: any[]) => r.ok)).toHaveLength(0);
      expect(workerHost.dispose).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });

    it("still stops the worker when the failure report itself throws", () => {
      const onActivationResult = vi.fn(() => {
        throw new Error("provenance write blew up");
      });
      const { workerHost, onTerminalFailure } = makeBridge({ onActivationResult });
      expect(() => workerHost.emit("worker-message", null)).not.toThrow();
      expect(workerHost.dispose).toHaveBeenCalledTimes(1);
      expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    });

    it("stops the worker even when the rejection logger itself throws", () => {
      const { workerHost, onTerminalFailure } = makeBridge();
      loggerMock.error.mockImplementation(() => {
        throw new Error("log sink is down");
      });
      expect(() => workerHost.emit("worker-message", null)).not.toThrow();
      expect(workerHost.dispose).toHaveBeenCalled();
      expect(onTerminalFailure).toHaveBeenCalled();
    });

    it("treats an exception in a handler's own reporting as terminal", async () => {
      // A fire-and-forget dispatch whose internal catch throws used to reject
      // into nothing: no reply, no teardown, and the worker's promise hangs.
      const { host, workerHost, onTerminalFailure } = makeBridge();
      host.broadcastToRenderer.mockRejectedValue(new Error("host refused"));
      loggerMock.warn.mockImplementation(() => {
        throw new Error("log sink is down");
      });
      workerHost.emit("worker-message", {
        type: "host-notify",
        method: "broadcastToRenderer",
        params: { channel: "c", payload: 1 },
      });
      await flush();
      expect(onTerminalFailure).toHaveBeenCalled();
      expect(workerHost.dispose).toHaveBeenCalled();
    });

    it("keeps a healthy plugin serving while another one violates the protocol", async () => {
      const bad = makeBridge({ pluginId: "acme.broken" });
      const good = makeBridge({ pluginId: "acme.healthy" });
      bad.workerHost.emit("worker-message", null);
      good.workerHost.emit("worker-message", {
        type: "host-call",
        requestId: "c1",
        method: "getWorktrees",
      });
      await flush();

      expect(recordedError(bad.onActivationResult)).toContain("acme.broken");
      expect(bad.workerHost.dispose).toHaveBeenCalled();
      // The healthy instance completes its round trip, reply included.
      expect(good.host.getWorktrees).toHaveBeenCalled();
      expect(good.workerHost.sent).toContainEqual(
        expect.objectContaining({ type: "host-result", requestId: "c1", ok: true })
      );
      expect(good.workerHost.dispose).not.toHaveBeenCalled();
      expect(good.onTerminalFailure).not.toHaveBeenCalled();
      expect(good.clear).not.toHaveBeenCalled();
    });
  });
});

describe("PluginDevWorkerMainBridge manifest commands (#12274)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  /** Drive a bridge to a committed activation, the only state that serves commands. */
  function makeActivatedBridge() {
    const made = makeBridge();
    made.workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    return made;
  }

  it("sends the command id, the path main resolved, and the args", async () => {
    const { workerHost, bridge } = makeActivatedBridge();

    const resultPromise = bridge.invokeCommand("acme.demo.plan", "/plugins/acme.demo/src/plan.js", {
      issue: 42,
    });

    const invoke = workerHost.sent.find((m: any) => m.type === "invoke" && m.kind === "command");
    expect(invoke).toMatchObject({
      namespacedId: "acme.demo.plan",
      resolvedPath: "/plugins/acme.demo/src/plan.js",
      args: { issue: 42 },
    });

    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: "planned",
    });
    await expect(resultPromise).resolves.toBe("planned");
  });

  it("rejects with the worker's own error when the handler fails", async () => {
    const { workerHost, bridge } = makeActivatedBridge();

    const resultPromise = bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {});
    const invoke = workerHost.sent.find((m: any) => m.type === "invoke" && m.kind === "command");
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: false,
      error: "handler blew up",
    });

    await expect(resultPromise).rejects.toThrow("handler blew up");
  });

  it("rejects a command sent to a worker that is not running", async () => {
    const { workerHost, bridge } = makeActivatedBridge();
    workerHost.ready = false;

    await expect(bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {})).rejects.toThrow(
      /not running/
    );
  });

  it("rejects an in-flight command when the bridge is disposed", async () => {
    const { bridge } = makeActivatedBridge();

    const resultPromise = bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {});
    const assertion = expect(resultPromise).rejects.toThrow();
    bridge.dispose();
    await assertion;
  });

  it("refuses a command before this generation has activated", async () => {
    // A fresh bridge has a forked child but no completed handshake.
    const { workerHost, bridge } = makeBridge();

    await expect(bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {})).rejects.toThrow(
      /not ready to run command/
    );
    expect(workerHost.sent.find((m: any) => m.type === "invoke")).toBeUndefined();
  });

  it("refuses a NEW command while a crashed worker's replacement is booting", async () => {
    // Regression: `workerHost.isReady()` is true the instant a child exists, so
    // a replacement counts as ready before it has been sent `start` — its proxy
    // does not exist yet, so it drops the message and nothing ever answers.
    // Invokes have no timeout, so the caller would hang forever and the phantom
    // pending invoke would keep the worker off the idle-disposal path.
    const { workerHost, bridge } = makeActivatedBridge();
    // Sanity: it works before the crash.
    void bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {}).catch(() => undefined);
    expect(workerHost.sent.filter((m: any) => m.kind === "command")).toHaveLength(1);

    bridge.retire("worker crashed");

    await expect(bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {})).rejects.toThrow(
      /not ready to run command/
    );
    // Nothing new went to the booting replacement.
    expect(workerHost.sent.filter((m: any) => m.kind === "command")).toHaveLength(1);

    // Service returns exactly when the replacement finishes its own handshake:
    // `ready` marks the new generation as the live one, and its `activated`
    // commits it.
    workerHost.emit("ready");
    workerHost.emit("worker-message", { type: "activated", hasCleanup: false });
    void bridge.invokeCommand("acme.demo.plan", "/p/src/plan.js", {}).catch(() => undefined);
    expect(workerHost.sent.filter((m: any) => m.kind === "command")).toHaveLength(2);
  });
});

describe("sendToAgent cancelled from the worker after main has acted", () => {
  /** A bridge and a worker-side proxy wired back to back, as the port wires them. */
  function makeConnectedPair() {
    const pair = makeBridge();
    const proxy = new PluginDevWorkerHostProxy(
      "acme.demo",
      (msg) => pair.workerHost.emit("worker-message", msg),
      {
        instanceId: "acme.demo",
        manifestId: "acme.demo",
        origin: "global",
        projectId: null,
        projectRoot: null,
      }
    );
    pair.workerHost.send.mockImplementation((msg: any) => {
      pair.workerHost.sent.push(msg);
      proxy.handleMessage(msg);
      return true;
    });
    return { ...pair, proxy };
  }

  it("reports the draft main made rather than settling the abort as cancelled", async () => {
    const { host, proxy } = makeConnectedPair();
    let seenSignal: AbortSignal | undefined;
    let answer!: (value: unknown) => void;
    (host.sendToAgent as any).mockImplementation(
      (_text: any, _options: any, call?: { signal?: AbortSignal }) => {
        seenSignal = call?.signal;
        // A targeted send is atomic on the renderer: once it is on its way the
        // draft lands, and main reports it however the caller has since felt.
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
    );

    const controller = new AbortController();
    const result = proxy.host.sendToAgent(
      "Card body",
      { terminalId: "t-1" },
      { signal: controller.signal }
    );
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flush();

    controller.abort();
    await flush();
    // The cancel reached main, and the caller is still waiting on main's answer.
    expect(seenSignal?.aborted).toBe(true);
    expect(settled).toBe(false);

    answer({ status: "drafted", terminalId: "t-1" });
    await expect(result).resolves.toEqual({ status: "drafted", terminalId: "t-1" });
  });

  it("still settles as cancelled when main answers the cancel that way", async () => {
    const { host, proxy } = makeConnectedPair();
    (host.sendToAgent as any).mockImplementation(
      (_text: any, _options: any, call?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          call?.signal?.addEventListener("abort", () => resolve({ status: "cancelled" }));
        })
    );

    const controller = new AbortController();
    const result = proxy.host.sendToAgent("Card body", {}, { signal: controller.signal });
    await flush();
    controller.abort();

    await expect(result).resolves.toEqual({ status: "cancelled" });
  });
});

describe("PluginDevWorkerMainBridge handler invoke deadline", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  const ctx: PluginIpcContext = {
    projectId: null,
    worktreeId: null,
    webContentsId: 1,
    pluginId: "acme.demo",
  };

  it("forwards a declared timeoutMs to the host registration", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "slow", hasSchema: false, timeoutMs: 0 },
    });
    await flush();
    expect(host.registerHandler).toHaveBeenCalledWith("slow", expect.any(Function), {
      timeoutMs: 0,
    });
  });

  it("cancels the worker invoke when the deadline's signal aborts", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "slow", hasSchema: false },
    });
    await flush();
    const handler = host.registerHandler.mock.calls[0][1] as (
      c: PluginIpcContext,
      ...args: unknown[]
    ) => Promise<unknown>;

    vi.useFakeTimers();
    // What the host's deadline wrapper does around a registered handler.
    const pending = runWithInvokeDeadline("acme.demo", "slow", 100, ctx, (scoped) =>
      handler(scoped, "arg")
    ) as Promise<unknown>;
    const outcome = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);

    const invoke = workerHost.sent.find((m: any) => m.type === "invoke" && m.kind === "handler");
    expect(invoke).toMatchObject({ channel: "slow", args: ["arg"], ctx });

    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBeInstanceOf(PluginInvokeTimeoutError);
    expect(workerHost.sent).toContainEqual({ type: "invoke-cancel", requestId: invoke.requestId });

    // A late result for the cancelled id has nothing left to settle.
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invoke.requestId,
      ok: true,
      result: "late",
    });
  });
});

describe("PluginDevWorkerMainBridge input to launched agents (#14018)", () => {
  it.each([
    [
      "agents.interrupt",
      { terminalId: "t-1" },
      "interrupt",
      ["t-1"],
      { status: "sent", cancelKey: "advertised" },
    ],
    [
      "agents.sendKeys",
      { terminalId: "t-1", input: { choose: "Yes" } },
      "sendKeys",
      ["t-1", { choose: "Yes" }],
      { status: "sent", keys: ["Enter"] },
    ],
    [
      "agents.submit",
      { terminalId: "t-1", text: "/compact" },
      "submit",
      ["t-1", "/compact"],
      { status: "not-found" },
    ],
  ] as const)("routes %s to the real host", async (method, params, hostMethod, args, result) => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: `in-${hostMethod}`,
      method,
      params,
    });
    await flush();

    expect(host.agents[hostMethod]).toHaveBeenCalledWith(...args);
    expect(workerHost.sent.find((m) => m.requestId === `in-${hostMethod}`)).toMatchObject({
      ok: true,
      result,
    });
  });
});

describe("PluginDevWorkerMainBridge app-wide agent list (#13154)", () => {
  it("routes agents.listAll to the real host", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "la1",
      method: "agents.listAll",
      params: undefined,
    });
    await flush();

    expect(host.agents.listAll).toHaveBeenCalledTimes(1);
    expect(workerHost.sent.find((m) => m.requestId === "la1")).toMatchObject({
      ok: true,
      result: { agents: [], degraded: false, lastSuccessfulAt: 1 },
    });
  });

  it("subscribes all-agents through the real host and pushes each snapshot", async () => {
    const { host, workerHost } = makeBridge({ capabilities: ["agent:read"] });
    let deliver: ((snapshot: unknown) => void) | undefined;
    (host as any).onDidChangeAllAgents = vi.fn(async (cb: (snapshot: unknown) => void) => {
      deliver = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-all",
      kind: "all-agents",
      debounceMs: 250,
    });
    await flush();

    expect((host as any).onDidChangeAllAgents).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: 250,
    });
    const snapshot = { agents: [{ terminalId: "t-1" }], degraded: false, lastSuccessfulAt: 2 };
    deliver?.(snapshot);
    const evt = workerHost.sent.find(
      (m: any) => m.type === "subscription-event" && m.subscriptionId === "s-all"
    );
    expect(evt.payload).toEqual(snapshot);
  });
});

describe("PluginDevWorkerMainBridge focused-panel subscription", () => {
  it("subscribes focused-panel through the host and pushes each focus", async () => {
    const { host, workerHost } = makeBridge({ capabilities: ["panel:focus-read"] });
    let deliver: ((focus: unknown) => void) | undefined;
    (host as any).onDidChangeFocusedPanel = vi.fn(async (cb: (focus: unknown) => void) => {
      deliver = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-focus",
      kind: "focused-panel",
    });
    await flush();

    expect((host as any).onDidChangeFocusedPanel).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: undefined,
    });
    const focus = { kind: "diff", agent: false, worktreeId: "wt-1" };
    deliver?.(focus);
    const evt = workerHost.sent.find(
      (m: any) => m.type === "subscription-event" && m.subscriptionId === "s-focus"
    );
    expect(evt.payload).toEqual(focus);
  });
});

describe("PluginDevWorkerMainBridge project-presence subscription", () => {
  it("subscribes project-presence through the host with the caller's window and pushes each change", async () => {
    const { host, workerHost } = makeBridge();
    let deliver: ((presence: unknown) => void) | undefined;
    (host as any).onDidChangeProjectPresence = vi.fn(async (cb: (presence: unknown) => void) => {
      deliver = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-presence",
      kind: "project-presence",
      debounceMs: 400,
    });
    await flush();

    expect((host as any).onDidChangeProjectPresence).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: 400,
    });
    const presence = { projectId: "p1", state: "background" };
    deliver?.(presence);
    const evt = workerHost.sent.find(
      (m: any) => m.type === "subscription-event" && m.subscriptionId === "s-presence"
    );
    expect(evt.payload).toEqual(presence);
  });
});

describe("PluginDevWorkerMainBridge coalesced subscriptions and readFiles", () => {
  it("passes an absent debounceMs through as undefined so the host default applies", async () => {
    const { host, workerHost } = makeBridge({ capabilities: ["agent:read"] });
    (host as any).onDidChangeAgentState = vi.fn(async () => vi.fn());
    for (const [id, kind] of [
      ["s-w", "worktrees"],
      ["s-a", "active-worktree"],
      ["s-g", "agent-state"],
    ]) {
      workerHost.emit("worker-message", { type: "subscribe", subscriptionId: id, kind });
    }
    await flush();
    expect(host.onDidChangeWorktrees).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: undefined,
    });
    expect(host.onDidChangeActiveWorktree).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: undefined,
    });
    expect((host as any).onDidChangeAgentState).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: undefined,
    });
  });

  it("forwards an explicit debounceMs: 0 opt-out", async () => {
    const { host, workerHost } = makeBridge();
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-w0",
      kind: "worktrees",
      debounceMs: 0,
    });
    await flush();
    expect(host.onDidChangeWorktrees).toHaveBeenCalledWith(expect.any(Function), {
      debounceMs: 0,
    });
  });

  it("pushes the worktree list together with its change set", async () => {
    const { host, workerHost } = makeBridge();
    let deliver: ((list: unknown[], change: unknown) => void) | undefined;
    host.onDidChangeWorktrees.mockImplementation((cb: any) => {
      deliver = cb;
      return vi.fn();
    });
    workerHost.emit("worker-message", {
      type: "subscribe",
      subscriptionId: "s-d",
      kind: "worktrees",
    });
    await flush();
    const change = { added: ["w1"], removed: [], changed: [] };
    deliver?.([{ id: "w1" }], change);
    const evt = workerHost.sent.find(
      (m: any) => m.type === "subscription-event" && m.subscriptionId === "s-d"
    );
    expect(evt.payload).toEqual({ snapshots: [{ id: "w1" }], change });
  });

  it("relays fs.readFiles with the call's signal and the worker's options", async () => {
    const { host, workerHost } = makeBridge();
    const result = [{ path: "/repo/a", ok: true, content: "a" }];
    (host.fs as any).readFiles = vi.fn(async () => result);
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "rf1",
      method: "fs.readFiles",
      params: { paths: ["/repo/a"], encoding: "bytes" },
    });
    await flush();
    expect((host.fs as any).readFiles).toHaveBeenCalledWith(
      ["/repo/a"],
      expect.objectContaining({ encoding: "bytes", signal: expect.anything() })
    );
    const res = workerHost.sent.find((m: any) => m.type === "host-result" && m.requestId === "rf1");
    expect(res).toMatchObject({ ok: true, result });
  });
});

describe("PluginDevWorkerMainBridge push rejections", () => {
  function makeConnected() {
    const pair = makeBridge();
    const wire: any[] = [];
    const proxy = new PluginDevWorkerHostProxy(
      "acme.demo",
      (msg) => {
        // What the real port does: structured clone, then main's schema gate.
        const cloned = structuredClone(msg);
        wire.push(cloned);
        const parsed = parseWorkerToHostMessage(cloned);
        if (!parsed.ok) throw new Error(`schema rejected: ${parsed.issues}`);
        pair.workerHost.emit("worker-message", parsed.message);
      },
      {
        instanceId: "acme.demo",
        manifestId: "acme.demo",
        origin: "global",
        projectId: null,
        projectRoot: null,
      }
    );
    return { ...pair, proxy, wire };
  }

  it("reports a push the worker refused before the port, without its payload", async () => {
    const { host, proxy, onPushRejected, wire } = makeConnected();
    const huge = { blob: "x".repeat(PLUGIN_PUSH_MAX_PAYLOAD_BYTES) };
    expect(() => proxy.host.broadcastToRenderer("tick", huge)).toThrow(/PLUGIN_PAYLOAD_TOO_LARGE/);
    await expect(proxy.host.postToPanel("tick", huge, "panel-a")).rejects.toThrow(
      /PLUGIN_PAYLOAD_TOO_LARGE/
    );
    await flush();
    expect(onPushRejected).toHaveBeenCalledTimes(2);
    expect(host.broadcastToRenderer).not.toHaveBeenCalled();
    expect(wire.every((m) => JSON.stringify(m).length < 1_000)).toBe(true);
  });

  it("reports a push structured clone refuses at the port", async () => {
    const { proxy, onPushRejected } = makeConnected();
    await expect(proxy.host.postToPanel("tick", { run: () => 1 }, "panel-a")).rejects.toThrow();
    await flush();
    expect(onPushRejected).toHaveBeenCalledTimes(1);
  });

  it("does not report an accepted push", async () => {
    const { host, proxy, onPushRejected } = makeConnected();
    await proxy.host.broadcastToRenderer("tick", { a: 1 });
    await flush();
    expect(host.broadcastToRenderer).toHaveBeenCalledWith("tick", { a: 1 });
    expect(onPushRejected).not.toHaveBeenCalled();
  });
});

describe("PluginDevWorkerMainBridge invocation scope", () => {
  afterEach(() => _resetPluginFrontendRoutingForTesting());

  function fakeEndpoint(id: string, projectId: string): ClientEndpoint {
    return {
      endpointId: id,
      clientId: `client-${id}`,
      projectId,
      kind: "remote-view",
      handle: -1,
      send: vi.fn(),
      request: vi.fn(),
      onClose: () => ({ dispose: () => {} }),
      isClosed: () => false,
    };
  }

  it("answers each worker host call for the invocation that made it, even interleaved", async () => {
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
    const { host, workerHost } = makeBridge({ capabilities: [] });
    workerHost.emit("worker-message", {
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "go", hasSchema: false },
    });
    await flush();
    const wrapper = (host.registerHandler as any).mock.calls[0][1] as (...a: any[]) => unknown;
    const seen: Record<string, string | null> = {};
    (host.showConfirm as any).mockImplementation(async (options: { title: string }) => {
      seen[options.title] = getPluginInvokeOrigin("acme.demo")?.endpoint.endpointId ?? null;
      return true;
    });

    const a = fakeEndpoint("a", "project-a");
    const b = fakeEndpoint("b", "project-b");
    void runInPluginInvocation("acme.demo", a, () => wrapper({}, {}));
    void runInPluginInvocation("acme.demo", b, () => wrapper({}, {}));
    await flush();
    const invokes = workerHost.sent.filter((m) => m.type === "invoke");
    expect(invokes).toHaveLength(2);
    const [invokeA, invokeB] = invokes;

    // B's handler asks first, then A's: each answer belongs to its own caller.
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c1",
      method: "showConfirm",
      params: { options: { title: "from-b" } },
      invocationId: invokeB.requestId,
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c2",
      method: "showConfirm",
      params: { options: { title: "from-a" } },
      invocationId: invokeA.requestId,
    });
    // Background work of the worker carries no invocation.
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c3",
      method: "showConfirm",
      params: { options: { title: "background" } },
    });
    await flush();
    expect(seen).toEqual({ "from-b": "b", "from-a": "a", background: null });

    // Once A's invocation settles, a late call naming it belongs to nobody.
    workerHost.emit("worker-message", {
      type: "invoke-result",
      requestId: invokeA.requestId,
      ok: true,
      result: null,
    });
    workerHost.emit("worker-message", {
      type: "host-call",
      requestId: "c4",
      method: "showConfirm",
      params: { options: { title: "late-a" } },
      invocationId: invokeA.requestId,
    });
    await flush();
    expect(seen["late-a"]).toBeNull();
  });
});
