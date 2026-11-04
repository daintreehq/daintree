import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnedDecision } from "@daintreehq/decisions-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));
// An enrolled Host's record (#16022), the store's `decisionsHost`.
const savedHost = vi.hoisted(() => ({ value: undefined as unknown }));
const loads = vi.hoisted(() => ({
  constructed: 0,
  failNextConstruct: false,
  failNextOpen: false,
  // While set, closing a store waits for it, holding the service's transitions.
  closing: null as Promise<void> | null,
  // While set, opening a store waits for it, holding a start partway.
  opening: null as Promise<void> | null,
}));
const broadcast = vi.hoisted(() => vi.fn());
// The relay check's network: Chromium's, which tests answer by hand.
const netFetch = vi.hoisted(() => vi.fn<(url: string, init: RequestInit) => Promise<Response>>());

vi.mock("electron", () => ({ net: { fetch: netFetch }, app: {}, safeStorage: {} }));

// The key file each service uses, in a directory of the test's own.
const keyFile = vi.hoisted(() => ({ path: "" }));
// Claim and restore are relayIdentity's; here only how the entry runs them.
const setupRuns = vi.hoisted(() => ({ claim: vi.fn(), restore: vi.fn() }));
vi.mock("../relayIdentity.js", () => ({
  claimDecisionsRelay: setupRuns.claim,
  restoreDecisionsIdentity: setupRuns.restore,
}));

// The guided deploy's channel is relayDeployHost's (#16199); here only what it reports.
const deployHosts = vi.hoisted(() => ({
  events: [] as Array<import("../relayDeployHost.js").RelayDeployHostEvents>,
}));
vi.mock("../relayDeployHost.js", () => ({
  openRelayDeployHost: async (events: import("../relayDeployHost.js").RelayDeployHostEvents) => {
    deployHosts.events.push(events);
    return { channelPath: `/tmp/deploy-${deployHosts.events.length}/host.sock`, dispose: () => {} };
  },
}));

// The #16000 launch and prompt wait are viewless's; here only what delivery hands them (#16019).
const viewless = vi.hoisted(() => ({ resume: vi.fn(), wait: vi.fn() }));
vi.mock("../../viewless/index.js", () => ({
  resumeAgentSessionAsPaneLive: viewless.resume,
  waitForAgentAtPromptLive: viewless.wait,
}));

// Building an archive and the relay's delete are their own modules'; here only how the entry runs them.
const dataRuns = vi.hoisted(() => ({ buildArchive: vi.fn(), deleteRelay: vi.fn() }));
vi.mock("../dataExport.js", () => ({ buildDecisionsArchive: dataRuns.buildArchive }));
vi.mock("../relayData.js", () => ({ deleteDecisionsRelayData: dataRuns.deleteRelay }));
// Atomic writes pass through, held while `writeHeld` is set so a test can act mid-write.
const writes = vi.hoisted(() => ({ held: null as null | Promise<void>, writing: false }));
// Every kit write, so a test can tell one was never started rather than not yet finished.
const kitWrites = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientAtomicWriteFile: async (
      ...args: Parameters<typeof actual.resilientAtomicWriteFile>
    ) => {
      kitWrites.calls.push(String(args[0]));
      writes.writing = true;
      await writes.held;
      try {
        return await actual.resilientAtomicWriteFile(...args);
      } finally {
        writes.writing = false;
      }
    },
  };
});
// The stored rows, in memory: `failErase` makes the next erase fail, once.
const storedRows = vi.hoisted(() => ({ count: 0, failErase: false }));
// Making and checking a kit are recoveryKit's; here only how the entry runs them.
const kitRuns = vi.hoisted(() => ({ make: vi.fn(), check: vi.fn() }));
vi.mock("../recoveryKit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../recoveryKit.js")>()),
  makeRecoveryKit: kitRuns.make,
  checkRecoveryKit: kitRuns.check,
}));

vi.mock("../../../ipc/utils.js", () => ({ broadcastToProjectRenderers: broadcast }));

// The Decisions bearers `/mcp/decisions` reads, as the pane config service
// holds them, and a control-surface bearer it must never take.
const paneTokens = vi.hoisted(
  () => new Map<string, { paneId: string; principal: string; workspaceId: string }>()
);
const controlTokens = vi.hoisted(() => new Map<string, { paneId: string; principal: string }>());
vi.mock("../../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    getDecisionsBearerForToken: (token: string) => paneTokens.get(token) ?? null,
    getDecisionsPrincipal: (paneId: string) => {
      for (const record of paneTokens.values()) {
        if (record.paneId === paneId) return record.principal;
      }
      return null;
    },
    isValidPaneToken: (token: string) => controlTokens.has(token),
    getPaneIdForToken: (token: string) => controlTokens.get(token)?.paneId ?? null,
    getOwnershipPrincipalForToken: (token: string) => controlTokens.get(token)?.principal ?? null,
    getPaneWorkspaceBindingForToken: () => null,
    getOrchestratorPane: (paneId: string) => {
      for (const record of controlTokens.values()) {
        if (record.paneId === paneId) return { principalId: record.principal, tier: "core" };
      }
      return null;
    },
  },
}));

// The MCP listener and terminal host the route is opened over. `loaded` is
// whether something already loaded the MCP server's module.
const mcpRefs = vi.hoisted(() => ({
  ptyClient: { name: "pty client" },
  loaded: true,
  holdListener: vi.fn(async () => ({ port: 4100, release: async () => {} })),
  lazyHoldListener: vi.fn(async () => ({ port: 4200, release: async () => {} })),
}));
vi.mock("../../../window/serviceRefs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/serviceRefs.js")>()),
  getPtyClient: () => mcpRefs.ptyClient,
  getMcpServerServiceRef: () => (mcpRefs.loaded ? { holdListener: mcpRefs.holdListener } : null),
}));
vi.mock("../../McpServerService.js", () => ({
  mcpServerService: { holdListener: mcpRefs.lazyHoldListener },
}));

// What each opened route was handed.
const openedRoutes = vi.hoisted(
  () =>
    [] as Array<{
      sources: import("../mcpRoute.js").DecisionsMcpRouteSources;
      after: Promise<void> | undefined;
      letGo: () => void;
    }>
);
vi.mock("../mcpRoute.js", () => ({
  openDecisionsMcpRoute: (
    _source: unknown,
    sources: import("../mcpRoute.js").DecisionsMcpRouteSources,
    after?: Promise<void>
  ) => {
    let letGo!: () => void;
    const closed = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let isClosed = false;
    openedRoutes.push({ sources, after, letGo });
    return {
      listenerPort: async () => (isClosed ? null : 4100),
      close: () => {
        isClosed = true;
        return closed;
      },
    };
  },
}));

/**
 * Each setup check the entry makes: what it was handed, and a way to end it
 * as the real one would. The checking itself is setupCheck.ts's own suite's.
 */
const setupChecks = vi.hoisted(() => ({
  /** While set, a cancel ends its run only once this settles, as a slow cleanup would. */
  holdCancel: null as Promise<void> | null,
  made: [] as Array<{
    deps: import("../setupCheck.js").SetupCheckDeps;
    report: (run: import("../../../../shared/types/decisions.js").DecisionsSetupCheckRun) => void;
    finish: (state: "passed" | "failed", failedStep?: string) => void;
    cancelled: number;
  }>,
}));
vi.mock("../setupCheck.js", () => {
  type Run = import("../../../../shared/types/decisions.js").DecisionsSetupCheckRun;
  class SetupCheck {
    readonly runId: string;
    private run: Run;
    private failed: string | null = null;
    private ended: (run: Run) => void = () => {};
    private readonly ending: Promise<Run>;
    private started = false;
    constructor(
      private readonly deps: import("../setupCheck.js").SetupCheckDeps,
      private readonly onChange: (run: Run) => void
    ) {
      this.runId = `run-${setupChecks.made.length + 1}`;
      this.run = {
        runId: this.runId,
        revision: deps.nextRevision(),
        state: "running",
        startedAt: 1,
        steps: {} as Run["steps"],
        diagnostic: null,
      };
      this.ending = new Promise((resolve) => {
        this.ended = resolve;
      });
      const entry = {
        deps,
        cancelled: 0,
        report: (run: Run) => onChange(run),
        finish: (state: "passed" | "failed", failedStep?: string) => {
          this.failed = failedStep ?? null;
          this.end(state);
        },
      };
      setupChecks.made.push(entry);
    }
    snapshot(): Run {
      return { ...this.run };
    }
    failedStep(): string | null {
      return this.failed;
    }
    start(): Promise<Run> {
      if (!this.started) {
        this.started = true;
        this.onChange(this.snapshot());
      }
      return this.ending;
    }
    cancel(): Promise<Run> {
      const entry = setupChecks.made.find((made) => made.deps === this.deps);
      if (entry) entry.cancelled += 1;
      const hold = setupChecks.holdCancel;
      if (hold) void hold.then(() => this.end("cancelled"));
      else this.end("cancelled");
      return this.ending;
    }
    private end(state: Run["state"]): void {
      if (this.run.state !== "running") return;
      const revision = this.deps.nextRevision();
      // Each run ends at a time of its own, so one record can't pass for another's.
      this.run = { ...this.run, state, finishedAt: 1_000 + revision, revision };
      this.onChange(this.snapshot());
      this.ended(this.snapshot());
    }
  }
  return { SetupCheck };
});

// This machine's own windows, which the status push goes to.
const statusView = vi.hoisted(() => ({ send: vi.fn(), isDestroyed: () => false }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: () => [statusView],
}));

/**
 * Each relay connection the service makes, which here never touches a network:
 * its options (to report a status or a revocation as the real one would) and
 * how often it was started and stopped.
 */
/** The revocation hook the entry hands each service it makes. */
const entryHooks = vi.hoisted(() => ({
  onRelayRevoked: null as
    | ((
        relay: import("../relayConnection.js").RelayBinding,
        role?: import("../DecisionsService.js").DecisionsRole
      ) => void)
    | null,
  delivery: null as import("../DecisionsService.js").DecisionsServiceOptions["delivery"] | null,
}));

const connections = vi.hoisted(
  () =>
    [] as Array<{
      options: import("../relayConnection.js").RelayConnectionOptions;
      started: number;
      stopped: number;
      keyFileAtStop?: boolean;
    }>
);

// Holds back the kit's folder check while set, so a test can quit in the middle of it.
const statGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  started: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    if (statGate.hold) {
      statGate.started += 1;
      await statGate.hold;
    }
    return actual.stat(...args);
  };
  return { ...actual, stat, default: { ...actual, stat } };
});

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "decisions" ? saved.value : key === "decisionsHost" ? savedHost.value : undefined
    ),
    set: vi.fn((key: string, value: unknown) => {
      if (key === "decisions") saved.value = value;
      if (key === "decisionsHost") savedHost.value = value;
    }),
  },
}));

// The key file holds a plain identity here, not a sealed one: only a Host's
// conditional removal (#16022) reads it, and it reads it as written.
vi.mock("../keyStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../keyStore.js")>();
  const { readFileSync: read, rmSync: remove } = await import("node:fs");
  class ReadableKeyStore extends actual.SealedKeyStore {
    override async clearIf(
      removable: Parameters<InstanceType<typeof actual.SealedKeyStore>["clearIf"]>[0]
    ): Promise<boolean> {
      let text: string;
      try {
        text = read(this.filePath, "utf8");
      } catch {
        return false;
      }
      const current = JSON.parse(text) as Parameters<typeof removable>[0];
      if (!removable(current)) return false;
      remove(this.filePath);
      return true;
    }
  }
  return { ...actual, SealedKeyStore: ReadableKeyStore };
});

/** A key file holding a Host identity for `deviceId`, as the readable store above reads it. */
function heldKeys(deviceId: string): string {
  return JSON.stringify({ role: "desktop-host", config: { deviceId } });
}

// Counts constructions; `failNextConstruct` fails the next one, once.
vi.mock("../DecisionsService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../DecisionsService.js")>();
  class CountedDecisionsService extends actual.DecisionsService {
    constructor(options: ConstructorParameters<typeof actual.DecisionsService>[0] = {}) {
      if (loads.failNextConstruct) {
        loads.failNextConstruct = false;
        throw new Error("construct failed");
      }
      // A store that holds nothing, so starting never reaches the app database;
      // `failNextOpen` makes the next open fail, once.
      const onRelayRevoked = options.onRelayRevoked;
      entryHooks.onRelayRevoked = onRelayRevoked
        ? (relay, role = "owner") => onRelayRevoked(relay, role)
        : null;
      entryHooks.delivery = options.delivery ?? null;
      super({
        ...options,
        keyFilePath: () => keyFile.path,
        openRows: async () => ({
          erase: () => {
            if (storedRows.failErase) {
              storedRows.failErase = false;
              throw new Error("database is locked");
            }
            storedRows.count = 0;
          },
          exist: () => storedRows.count > 0,
        }),
        connect: (connectionOptions) => {
          const made: (typeof connections)[number] = {
            options: connectionOptions,
            started: 0,
            stopped: 0,
          };
          connections.push(made);
          return {
            start: () => {
              made.started += 1;
            },
            stop: () => {
              made.stopped += 1;
              made.keyFileAtStop = existsSync(keyFile.path);
            },
          };
        },
        openStore: async () => {
          await loads.opening;
          if (loads.failNextOpen) {
            loads.failNextOpen = false;
            throw new Error("store unavailable");
          }
          return {
            close: () => loads.closing ?? Promise.resolve(),
            onCommit: () => () => {},
            listQuestions: async () => [],
          } as never;
        },
      });
      loads.constructed += 1;
    }
  }
  return { ...actual, DecisionsService: CountedDecisionsService };
});

import { store } from "../../../store.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { outstandingRows, row } from "./questionRows.js";
import { defaultDecisionsSettings } from "../decisionsSettings.js";
import { RelayCheckCancelledError } from "../relayCheck.js";
import { setDecisionsHostsPort } from "../../../window/serviceRefs.js";
import { noteRelayRemovalLaunch } from "../../pty/relayRemovalLaunches.js";
import type { DecisionsHostLink, DecisionsHostsPort } from "../../../types/decisionsHosts.js";

/** An entry status: what it observed, and the revision it was read at. */
function withRevision<T extends object>(status: T): T & { revision: number } {
  return { ...status, revision: expect.any(Number) as unknown as number };
}

/** What the status pushes to this machine's windows carried, in order. */
function pushedStatuses(): Array<Record<string, unknown>> {
  return statusView.send.mock.calls
    .filter(
      ([channel, event]) =>
        channel === CHANNELS.EVENTS_PUSH &&
        (event as { name: string }).name === "decisions:status-changed"
    )
    .map(([, event]) => (event as { payload: Record<string, unknown> }).payload);
}

/** What the renderer recognises: an AppError by name, and its code. */
const CANCELLED = { name: "AppError", code: "CANCELLED" };
import {
  _resetDecisionsForTesting,
  applyOwnerState,
  checkRelay,
  claimDeployedRelay,
  claimRelay,
  decisionsHostRuntimeFor,
  decisionsLaunchPort,
  deleteLocalData,
  deleteRelayData,
  disconnectRelay,
  exportData,
  prepareRelayDeploy,
  exportRecoveryKit,
  getDecisionsPaneState,
  getDecisionsPolicy,
  cancelSetupCheck,
  cancelDecisionsModelEvaluation,
  clearDecisionsModelHistory,
  getDecisionsModel,
  getDecisionsService,
  getDecisionsStatus,
  listHosts,
  getSetupCheck,
  noteHostIdentity,
  onDecisionsHostRuntimeChanged,
  peekDecisionsService,
  restoreIdentity,
  setAutoEnrollHosts,
  setDecisionsEnabled,
  setDecisionsModel,
  setDecisionsModelThreshold,
  setDecisionsProxyAllowlisted,
  setDecisionsDefaultQuestionExpiry,
  setDecisionsAgentAskHuman,
  startDecisionsModelEvaluation,
  startRelayRemoval,
  startDecisionsIfEnabled,
  startSetupCheck,
  stopDecisions,
  verifyRecoveryKit,
} from "../index.js";

const RELAY = {
  relayOrigin: "https://relay.example.com",
  installationId: "inst_12345678",
  deviceId: "dev_12345678",
  hostId: "host_12345678",
};

describe("Decisions entry", () => {
  beforeAll(() => {
    keyFile.path = join(mkdtempSync(join(tmpdir(), "decisions-entry-")), "keys.bin");
  });

  afterAll(() => {
    rmSync(join(keyFile.path, ".."), { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(keyFile.path, { force: true });
    setupRuns.claim.mockReset();
    setupRuns.restore.mockReset();
    dataRuns.buildArchive.mockReset();
    dataRuns.deleteRelay.mockReset();
    storedRows.count = 0;
    storedRows.failErase = false;
    writes.held = null;
    rmSync(`${keyFile.path}.erasing`, { force: true });
    kitRuns.make.mockReset();
    kitRuns.check.mockReset();
    kitWrites.calls.length = 0;
    statGate.hold = null;
    statGate.started = 0;
    saved.value = undefined;
    savedHost.value = undefined;
    loads.failNextConstruct = false;
    loads.failNextOpen = false;
    loads.closing = null;
    loads.opening = null;
    vi.mocked(store.set).mockClear();
    broadcast.mockClear();
    netFetch.mockReset();
    statusView.send.mockClear();
    connections.length = 0;
    openedRoutes.length = 0;
    paneTokens.clear();
    controlTokens.clear();
    mcpRefs.loaded = true;
    // The last test's check is cancelled by the reset, before its record goes.
    setupChecks.holdCancel = null;
    _resetDecisionsForTesting();
    setupChecks.made.length = 0;
  });

  it("reads no pane state, and makes no service, before Decisions runs", () => {
    saved.value = { enabled: true };

    expect(getDecisionsPaneState("pane-a")).toBeNull();
    expect(peekDecisionsService()).toBeNull();
  });

  it("pushes each pane's state to its own project's views, and reads it back", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();

    peekDecisionsService()!.observeQuestions([
      row(1),
      row(2, { origin: { pane_id: "pane-b", project_id: "project-2" } }),
    ]);

    const a = getDecisionsPaneState("pane-a");
    const b = getDecisionsPaneState("pane-b");
    expect(a?.openQuestions.map((q) => q.alias)).toEqual([1]);
    expect(b?.openQuestions.map((q) => q.alias)).toEqual([2]);
    expect(broadcast.mock.calls).toEqual([
      ["project-1", CHANNELS.EVENTS_PUSH, { name: "terminal:decision-state", payload: a }],
      ["project-2", CHANNELS.EVENTS_PUSH, { name: "terminal:decision-state", payload: b }],
    ]);
  });

  it("clears a pane's views once when turned off, then reads and pushes nothing", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    const service = peekDecisionsService()!;
    service.observeQuestions(outstandingRows());
    broadcast.mockClear();

    await setDecisionsEnabled(false);
    service.observeQuestions([row(4)]);

    expect(broadcast).toHaveBeenCalledExactlyOnceWith("project-1", CHANNELS.EVENTS_PUSH, {
      name: "terminal:decision-state",
      payload: {
        terminalId: "pane-a",
        openQuestions: [],
        waitingAnswers: [],
        needsAttention: [],
        revision: expect.any(Number),
      },
    });
    expect(getDecisionsPaneState("pane-a")).toBeNull();
  });

  it("pushes nothing at quit", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    peekDecisionsService()!.observeQuestions([row(1)]);
    broadcast.mockClear();

    await stopDecisions();

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("makes no service at boot while the setting is off", async () => {
    saved.value = { enabled: false };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
  });

  it("makes no service at boot when the sanitiser turns a damaged record off", async () => {
    saved.value = { enabled: true, relayOrigin: "ftp://relay.example.com" };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
  });

  it("starts the service at boot when the setting is on", async () => {
    saved.value = { enabled: true, ...RELAY };

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()?.getStatus()).toEqual({ state: "not-connected" });
    expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBe(RELAY.relayOrigin);
  });

  it("reads on as not connected before the boot task has made the service", async () => {
    saved.value = { enabled: true };

    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));
    expect(peekDecisionsService()).toBeNull();
  });

  it("shares one service between concurrent callers", async () => {
    const [a, b] = await Promise.all([getDecisionsService(), getDecisionsService()]);
    expect(a).toBe(b);
  });

  it("retries a service that failed to be made", async () => {
    loads.failNextConstruct = true;
    await expect(getDecisionsService()).rejects.toThrow("construct failed");

    const made = await getDecisionsService();
    expect(made).toBe(peekDecisionsService());
    expect(made.getStatus()).toEqual({ state: "off" });
  });

  it("turns on at runtime, keeping every other field of the setting", async () => {
    saved.value = { enabled: false, ...RELAY, proxyAllowlisted: true };

    const status = await setDecisionsEnabled(true);

    expect(status).toEqual(
      withRevision({ state: "not-connected", relayOrigin: RELAY.relayOrigin })
    );
    expect(saved.value).toMatchObject({ enabled: true, ...RELAY, proxyAllowlisted: true });
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("records the first consent, and keeps its time when consent comes again", async () => {
    saved.value = { enabled: false };
    vi.spyOn(Date, "now").mockReturnValueOnce(1_761_955_200_000);

    const first = await setDecisionsEnabled(true, { consent: true });
    await setDecisionsEnabled(false);
    const again = await setDecisionsEnabled(true, { consent: true });

    expect(first).toEqual(withRevision({ state: "not-connected", consentedAt: 1_761_955_200_000 }));
    expect(again.consentedAt).toBe(1_761_955_200_000);
    expect(saved.value).toMatchObject({ enabled: true, consentedAt: 1_761_955_200_000 });
  });

  it("leaves consent unrecorded when a switch comes without it", async () => {
    saved.value = { enabled: false };

    const status = await setDecisionsEnabled(true);

    expect(status.consentedAt).toBeUndefined();
    expect(saved.value).toMatchObject({ consentedAt: null });
  });

  it("reports the saved consent with the switch off", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };

    expect(await getDecisionsStatus()).toEqual(
      withRevision({ state: "off", consentedAt: 1_761_955_200_000 })
    );
  });

  it("turns off at runtime, stopping the service and saving off", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();

    const status = await setDecisionsEnabled(false);

    expect(status).toEqual(withRevision({ state: "off" }));
    expect(saved.value).toMatchObject({ enabled: false });
    expect(peekDecisionsService()?.getStatus().state).toBe("off");
  });

  it("turning off when it was never on makes no service", async () => {
    saved.value = { enabled: false };
    const constructedBefore = loads.constructed;

    await setDecisionsEnabled(false);

    expect(peekDecisionsService()).toBeNull();
    expect(loads.constructed).toBe(constructedBefore);
  });

  it("turning on over a damaged relay record starts afresh without it", async () => {
    saved.value = { enabled: false, relayOrigin: "http://relay.example.com", hostId: RELAY.hostId };

    const status = await setDecisionsEnabled(true);

    expect(status).toEqual(withRevision({ state: "not-connected" }));
    expect(saved.value).toMatchObject({ enabled: true, relayOrigin: null, hostId: RELAY.hostId });
  });

  it("finishes rapid toggles on the last one asked", async () => {
    saved.value = { enabled: false };

    const results = await Promise.all([
      setDecisionsEnabled(true),
      setDecisionsEnabled(false),
      setDecisionsEnabled(true),
    ]);

    expect(results.map((s) => s.state)).toEqual(["not-connected", "off", "not-connected"]);
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
    expect(saved.value).toMatchObject({ enabled: true });
  });

  it("stops for good at quit, without writing the setting off", async () => {
    saved.value = { enabled: true };
    await startDecisionsIfEnabled();
    vi.mocked(store.set).mockClear();

    await stopDecisions();
    await startDecisionsIfEnabled();

    expect(peekDecisionsService()?.getStatus().state).toBe("off");
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "off" }));
    expect(store.set).not.toHaveBeenCalled();
  });

  it("waits at quit for a service still being made, and leaves it stopped for good", async () => {
    saved.value = { enabled: true };
    const on = { ...defaultDecisionsSettings(), enabled: true };

    // A boot start that got the service before quit began, racing the stop.
    const making = getDecisionsService();
    const booted = making.then((service) => service.start(on));
    const stopping = stopDecisions();
    await Promise.all([booted, stopping]);

    const service = await making;
    expect(service.getStatus().state).toBe("off");
    await service.start(on);
    expect(service.getStatus().state).toBe("off");
  });

  it("saves a switch turned on during quit, but starts nothing", async () => {
    saved.value = { enabled: false };
    await stopDecisions();

    const status = await setDecisionsEnabled(true);

    expect(saved.value).toMatchObject({ enabled: true });
    expect(status).toEqual(withRevision({ state: "off" }));
    expect(peekDecisionsService()).toBeNull();
  });

  it("starts nothing at boot after quit, even with the setting on and no service made yet", async () => {
    saved.value = { enabled: true };
    const constructedBefore = loads.constructed;
    await stopDecisions();

    await startDecisionsIfEnabled();

    expect(peekDecisionsService()).toBeNull();
    expect(loads.constructed).toBe(constructedBefore);
  });

  it("makes no new service once quit has run", async () => {
    await stopDecisions();

    await expect(getDecisionsService()).rejects.toThrow("Decisions has stopped for this run");
    expect(peekDecisionsService()).toBeNull();
  });

  it("recovers from a runtime switch that failed, so the next one runs", async () => {
    saved.value = { enabled: false };
    loads.failNextConstruct = true;

    await expect(setDecisionsEnabled(true)).rejects.toThrow("construct failed");
    const status = await setDecisionsEnabled(true);

    expect(status).toEqual(withRevision({ state: "not-connected" }));
    expect(peekDecisionsService()?.getStatus().state).toBe("not-connected");
  });

  it("keeps the switch on when the store can't open, and the next turn-on opens it", async () => {
    saved.value = { enabled: false };
    loads.failNextOpen = true;

    await expect(setDecisionsEnabled(true)).rejects.toThrow("store unavailable");
    expect((saved.value as { enabled: boolean }).enabled).toBe(true);
    expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));
    expect(peekDecisionsService()?.getStore()).toBeNull();

    await setDecisionsEnabled(true);
    expect(peekDecisionsService()?.getStore()).not.toBeNull();
  });

  describe("decision model (#16027)", () => {
    const modelDir = () => join(keyFile.path, "..");
    const historyFile = () => join(modelDir(), "model-history.sqlite");

    function learned(n: number): LearnedDecision {
      return {
        questionId: `q-past-${String(n).padStart(4, "0")}`,
        question: `Rebase or merge develop for change ${n}?`,
        options: [
          { id: "rebase", label: "Rebase" },
          { id: "merge", label: "Merge" },
        ],
        kind: "choice",
        requirement: "proxy-ok",
        projectId: "project-1",
        createdAt: new Date(Date.UTC(2026, 9, 1, 9, n * 10)).toISOString(),
        chosenAt: new Date(Date.UTC(2026, 9, 1, 9, n * 10 + 5)).toISOString(),
        selectedOptionIds: ["rebase"],
        text: "",
        revision: 1,
        correction: false,
      };
    }

    beforeEach(() => {
      for (const name of readdirSync(modelDir())) {
        if (name.startsWith("model-")) rmSync(join(modelDir(), name), { force: true });
      }
    });

    afterEach(async () => {
      // Closes the model's history before the next test removes its files.
      await peekDecisionsService()?.stop();
    });

    it("turns learning on only with its own agreement, kept from the first time", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();

      // Decisions' own consent doesn't stand for the model's.
      await expect(setDecisionsModel({ learning: true, adapter: "claude" })).rejects.toMatchObject({
        name: "AppError",
        code: "PERMISSION",
      });
      expect((saved.value as { modelLearning?: boolean }).modelLearning).not.toBe(true);
      expect(existsSync(historyFile())).toBe(false);

      const on = await setDecisionsModel({ learning: true, adapter: "claude", consent: true });
      expect(on).toMatchObject({
        learning: true,
        adapter: "claude",
        history: { state: "open", count: 0 },
        evaluation: null,
        answeringFrom: null,
      });
      const consentedAt = on.consentedAt!;
      expect(consentedAt).toBeGreaterThan(0);
      expect(saved.value).toMatchObject({ consentedAt: 5, modelConsentedAt: consentedAt });

      const off = await setDecisionsModel({ learning: false, adapter: "claude" });
      expect(off).toMatchObject({ learning: false, history: { state: "closed", stored: true } });
      // Turning on again asks nothing more, and keeps the first agreement's time.
      const again = await setDecisionsModel({ learning: true, adapter: null });
      expect(again).toMatchObject({ learning: true, adapter: null, consentedAt });
    });

    it("refuses every change while Decisions is off, and reads it through the setting alone", async () => {
      saved.value = { enabled: false };
      const constructed = loads.constructed;
      await expect(
        setDecisionsModel({ learning: true, adapter: null, consent: true })
      ).rejects.toMatchObject(CANCELLED);
      await expect(clearDecisionsModelHistory()).rejects.toMatchObject(CANCELLED);
      await expect(startDecisionsModelEvaluation()).rejects.toMatchObject(CANCELLED);
      expect(store.set).not.toHaveBeenCalled();
      expect(loads.constructed).toBe(constructed);
    });

    it("refuses to evaluate without a CLI chosen, or to arm from a report it doesn't hold", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      await expect(startDecisionsModelEvaluation()).rejects.toMatchObject({ code: "PERMISSION" });

      await setDecisionsModel({ learning: true, adapter: null, consent: true });
      await expect(startDecisionsModelEvaluation()).rejects.toMatchObject({
        code: "PERMISSION",
        message: expect.stringMatching(/Choose an agent CLI/),
      });
      await expect(
        setDecisionsModelThreshold({ threshold: 0.8, evaluatedAt: 1_761_955_200_000 })
      ).rejects.toMatchObject({ code: "STALE_GENERATION" });
      // A cancel naming no run changes nothing.
      expect(cancelDecisionsModelEvaluation({ runId: "no-such-run" })).toMatchObject({
        running: null,
      });
    });

    it("counts what it learns, clears it with learning off, and tells every window each time", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      await setDecisionsModel({ learning: true, adapter: null, consent: true });
      const revision = getDecisionsModel().revision;
      const pushes = pushedStatuses().length;

      peekDecisionsService()!.getDecisionModel()!.learner.learn(learned(1));
      expect(getDecisionsModel()).toMatchObject({ history: { state: "open", count: 1 } });
      expect(getDecisionsModel().revision).toBeGreaterThan(revision);
      await vi.waitFor(() => expect(pushedStatuses().length).toBeGreaterThan(pushes));

      await setDecisionsModel({ learning: false, adapter: null });
      expect(getDecisionsModel().history).toEqual({ state: "closed", stored: true });

      const cleared = await clearDecisionsModelHistory();
      expect(cleared).toMatchObject({
        learning: false,
        history: { state: "closed", stored: false },
      });
      expect(readdirSync(modelDir()).filter((name) => name.startsWith("model-"))).toEqual([]);
      // Learning stays off, and its agreement stays.
      expect(saved.value).toMatchObject({ modelLearning: false });
      expect(cleared.consentedAt).toBeGreaterThan(0);
    });
  });

  describe("policy", () => {
    it("reads the trusted gates and the proxy allowlist as saved", () => {
      saved.value = { enabled: true, proxyAllowlisted: true };
      const policy = getDecisionsPolicy();
      expect(policy.proxyAllowlisted).toBe(true);
      expect(policy.gates.map((gate) => gate.id)).toContain("design-review/final");
      expect(policy.defaultQuestionExpiryMs).toBeGreaterThan(0);
    });

    it("saves the proxy allowlist, keeping every other field, and the running policy follows it", async () => {
      saved.value = { enabled: true, ...RELAY, consentedAt: 5 };
      await startDecisionsIfEnabled();
      const running = peekDecisionsService()!.getPolicy()!;
      expect(running.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");

      const policy = await setDecisionsProxyAllowlisted(true);

      expect(policy.proxyAllowlisted).toBe(true);
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        ...RELAY,
        consentedAt: 5,
        proxyAllowlisted: true,
      });
      expect(peekDecisionsService()!.getPolicy()).toBe(running);
      expect(running.resolve({ requested: "proxy-ok" }).requirement).toBe("proxy-ok");
      expect(connections).toHaveLength(1);
      expect(connections[0]!.stopped).toBe(0);

      expect((await setDecisionsProxyAllowlisted(false)).proxyAllowlisted).toBe(false);
      expect(running.resolve({ requested: "proxy-ok" }).requirement).toBe("human-required");
    });

    it("moves the revision with each save, and tells every window to read it again", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      const before = getDecisionsPolicy().revision;
      const pushedAfter = async (revision: number) =>
        vi.waitFor(() =>
          expect(pushedStatuses().at(-1)?.revision as number).toBeGreaterThan(revision)
        );

      let status = (await getDecisionsStatus()).revision ?? 0;
      const saved1 = await setDecisionsProxyAllowlisted(true);
      expect(saved1.revision).toBeGreaterThan(before);
      expect(getDecisionsPolicy()).toEqual(saved1);
      await pushedAfter(status);

      status = (await getDecisionsStatus()).revision ?? 0;
      const saved2 = await setDecisionsProxyAllowlisted(false);
      expect(saved2.revision).toBeGreaterThan(saved1.revision);
      await pushedAfter(status);
    });

    it("waits for a switch-on under way, so the starting lifetime can't keep the old allowlist", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      const service = peekDecisionsService()!;
      // A stop still closing the store holds the service, so the switch-on
      // below waits there with the settings it read.
      let closed!: () => void;
      loads.closing = new Promise<void>((resolve) => (closed = resolve));
      const stopping = service.stop();
      const enabling = setDecisionsEnabled(true);
      await vi.waitFor(() => expect(store.set).toHaveBeenCalledTimes(1));

      let allowed = false;
      const allowing = setDecisionsProxyAllowlisted(true).then((policy) => {
        allowed = true;
        return policy;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Queued behind the switch-on: nothing saved, nothing answered yet.
      expect(allowed).toBe(false);
      expect(saved.value).toMatchObject({ proxyAllowlisted: false });

      closed();
      await Promise.all([stopping, enabling, allowing]);
      expect(saved.value).toMatchObject({ enabled: true, proxyAllowlisted: true });
      const running = service.getPolicy()!;
      expect(running.resolve({ requested: "proxy-ok" }).requirement).toBe("proxy-ok");
    });

    it("saves the default expiry, never included, and the running policy asks the next question with it", async () => {
      saved.value = { enabled: true, ...RELAY, consentedAt: 5 };
      await startDecisionsIfEnabled();
      const running = peekDecisionsService()!.getPolicy()!;

      const never = await setDecisionsDefaultQuestionExpiry(null);
      expect(never).toMatchObject({ defaultQuestionExpiryMs: null, maxQuestionExpiryMs: null });
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        ...RELAY,
        consentedAt: 5,
        defaultQuestionExpiryMs: null,
      });
      expect(getDecisionsPolicy()).toEqual(never);
      expect(peekDecisionsService()!.getPolicy()).toBe(running);
      expect(running.defaultQuestionExpiryMs).toBeNull();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.stopped).toBe(0);

      const hour = await setDecisionsDefaultQuestionExpiry(60 * 60_000);
      expect(hour.defaultQuestionExpiryMs).toBe(60 * 60_000);
      expect(hour.revision).toBeGreaterThan(never.revision);
      expect(running.defaultQuestionExpiryMs).toBe(60 * 60_000);
    });

    it("refuses an expiry Settings doesn't offer, saving nothing and leaving the policy as it was", async () => {
      saved.value = { enabled: true, ...RELAY, consentedAt: 5 };
      await startDecisionsIfEnabled();
      const running = peekDecisionsService()!.getPolicy()!;
      const before = getDecisionsPolicy();
      vi.mocked(store.set).mockClear();

      for (const ms of [0, 59_999, 2 * 60 * 60_000, 400 * 24 * 60 * 60_000]) {
        await expect(setDecisionsDefaultQuestionExpiry(ms)).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
      expect(store.set).not.toHaveBeenCalled();
      expect(getDecisionsPolicy()).toEqual(before);
      expect(running.defaultQuestionExpiryMs).toBe(before.defaultQuestionExpiryMs);
    });

    it("keeps both fields when the expiry and the allowlist are saved at once", async () => {
      saved.value = { enabled: true, ...RELAY, consentedAt: 5 };
      await startDecisionsIfEnabled();
      const running = peekDecisionsService()!.getPolicy()!;

      const [allowed, expiry] = await Promise.all([
        setDecisionsProxyAllowlisted(true),
        setDecisionsDefaultQuestionExpiry(null),
      ]);
      expect(allowed.proxyAllowlisted).toBe(true);
      // The later save is applied over the earlier one, so its answer holds both.
      expect(expiry).toMatchObject({ proxyAllowlisted: true, defaultQuestionExpiryMs: null });
      expect(saved.value).toMatchObject({ proxyAllowlisted: true, defaultQuestionExpiryMs: null });
      expect(running.defaultQuestionExpiryMs).toBeNull();
      expect(running.resolve({ requested: "proxy-ok" }).requirement).toBe("proxy-ok");
    });

    it("refuses either policy change after quit, though the switch still reads on", async () => {
      saved.value = { enabled: true, ...RELAY, consentedAt: 5 };
      await startDecisionsIfEnabled();
      await stopDecisions();
      vi.mocked(store.set).mockClear();

      await expect(setDecisionsDefaultQuestionExpiry(null)).rejects.toMatchObject(CANCELLED);
      await expect(setDecisionsProxyAllowlisted(true)).rejects.toMatchObject(CANCELLED);
      expect(store.set).not.toHaveBeenCalled();
    });

    it("refuses to change the allowlist while off, and saves nothing", async () => {
      saved.value = { enabled: false };
      await expect(setDecisionsProxyAllowlisted(true)).rejects.toMatchObject(CANCELLED);
      await expect(setDecisionsDefaultQuestionExpiry(null)).rejects.toMatchObject(CANCELLED);
      await expect(
        setDecisionsAgentAskHuman({ agentId: "claude", enabled: true })
      ).rejects.toMatchObject(CANCELLED);
      expect(store.set).not.toHaveBeenCalled();
      expect(peekDecisionsService()).toBeNull();
    });

    describe("agents switched on for ask_human (#16223)", () => {
      it("reads none switched on until the person switches one on", () => {
        saved.value = { enabled: true };
        expect(getDecisionsPolicy().askHumanAgents).toEqual([]);
      });

      it("switches one agent at a time over the setting as saved, keeping every other field", async () => {
        saved.value = { enabled: true, ...RELAY, consentedAt: 5, askHumanAgents: ["codex"] };
        await startDecisionsIfEnabled();
        const before = getDecisionsPolicy().revision;

        const on = await setDecisionsAgentAskHuman({ agentId: "claude", enabled: true });
        expect(on.askHumanAgents).toEqual(["codex", "claude"]);
        expect(on.revision).toBeGreaterThan(before);
        expect(saved.value).toEqual({
          ...defaultDecisionsSettings(),
          enabled: true,
          ...RELAY,
          consentedAt: 5,
          askHumanAgents: ["codex", "claude"],
        });
        expect(getDecisionsPolicy()).toEqual(on);

        const off = await setDecisionsAgentAskHuman({ agentId: "codex", enabled: false });
        expect(off.askHumanAgents).toEqual(["claude"]);
        expect(off.revision).toBeGreaterThan(on.revision);
        // Launches read it; the running relay connection is left alone.
        expect(connections).toHaveLength(1);
        expect(connections[0]!.stopped).toBe(0);
      });

      it("keeps both changes when two windows switch different agents at once", async () => {
        saved.value = { enabled: true };
        await startDecisionsIfEnabled();

        const [claude, codex] = await Promise.all([
          setDecisionsAgentAskHuman({ agentId: "claude", enabled: true }),
          setDecisionsAgentAskHuman({ agentId: "codex", enabled: true }),
        ]);
        expect(claude.askHumanAgents).toEqual(["claude"]);
        expect(codex.askHumanAgents).toEqual(["claude", "codex"]);
        expect(saved.value).toMatchObject({ askHumanAgents: ["claude", "codex"] });
      });

      it("saves nothing for a switch already where it was asked to be", async () => {
        saved.value = { enabled: true, askHumanAgents: ["claude"] };
        await startDecisionsIfEnabled();
        const before = getDecisionsPolicy();
        vi.mocked(store.set).mockClear();

        await expect(
          setDecisionsAgentAskHuman({ agentId: "claude", enabled: true })
        ).resolves.toEqual(before);
        await expect(
          setDecisionsAgentAskHuman({ agentId: "codex", enabled: false })
        ).resolves.toEqual(before);
        expect(store.set).not.toHaveBeenCalled();
      });

      it("tells every window to read the policy again when an agent is switched", async () => {
        saved.value = { enabled: true };
        await startDecisionsIfEnabled();
        const status = (await getDecisionsStatus()).revision ?? 0;

        await setDecisionsAgentAskHuman({ agentId: "claude", enabled: true });

        await vi.waitFor(() =>
          expect(pushedStatuses().at(-1)?.revision as number).toBeGreaterThan(status)
        );
      });

      it("refuses an id no agent could have, or one more agent past the cap, saving nothing", async () => {
        const full = Array.from({ length: 256 }, (_, i) => `agent-${i}`);
        saved.value = { enabled: true, askHumanAgents: full };
        await startDecisionsIfEnabled();
        vi.mocked(store.set).mockClear();

        for (const agentId of ["", "a b", "../claude", "x".repeat(129)]) {
          await expect(
            setDecisionsAgentAskHuman({ agentId, enabled: true }),
            agentId
          ).rejects.toMatchObject({ code: "VALIDATION" });
        }
        await expect(
          setDecisionsAgentAskHuman({ agentId: "claude", enabled: true })
        ).rejects.toMatchObject({ code: "VALIDATION" });
        expect(store.set).not.toHaveBeenCalled();
        // Switching one off still works at the cap.
        await expect(
          setDecisionsAgentAskHuman({ agentId: "agent-0", enabled: false })
        ).resolves.toMatchObject({ askHumanAgents: full.slice(1) });
      });

      it("refuses after quit, though the switch still reads on", async () => {
        saved.value = { enabled: true };
        await startDecisionsIfEnabled();
        await stopDecisions();
        vi.mocked(store.set).mockClear();

        await expect(
          setDecisionsAgentAskHuman({ agentId: "claude", enabled: true })
        ).rejects.toMatchObject(CANCELLED);
        expect(store.set).not.toHaveBeenCalled();
      });
    });
  });

  describe("relay check", () => {
    /** A fetch that never answers until its request is aborted. */
    function hangingFetch() {
      netFetch.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      );
    }

    it("refuses while Decisions is off, sending nothing", async () => {
      for (const value of [undefined, { enabled: false }]) {
        saved.value = value;

        await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject(CANCELLED);
      }
      expect(netFetch).not.toHaveBeenCalled();
    });

    it("checks through Chromium's network without making a service or writing the setting", async () => {
      saved.value = { enabled: true };
      netFetch.mockImplementation(async (url) =>
        url.endsWith("/health")
          ? Response.json({ ok: true })
          : new Response("not found", { status: 404 })
      );

      await expect(checkRelay("relay.example.com/some/path")).resolves.toMatchObject({
        result: "not-a-relay",
        origin: "https://relay.example.com",
        endpoint: "info",
        status: 404,
      });
      expect(netFetch.mock.calls.map(([url]) => url)).toEqual([
        "https://relay.example.com/health",
        "https://relay.example.com/api/v1/info",
      ]);
      expect(peekDecisionsService()).toBeNull();
      expect(store.set).not.toHaveBeenCalled();
    });

    it("is cancelled by turning off, which doesn't wait for it", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      hangingFetch();

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await setDecisionsEnabled(false);

      await expect(check).rejects.toBeInstanceOf(RelayCheckCancelledError);
      await expect(check).rejects.toMatchObject(CANCELLED);
    });

    it("is cancelled by quit", async () => {
      saved.value = { enabled: true };
      hangingFetch();

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await stopDecisions();

      await expect(check).rejects.toBeInstanceOf(RelayCheckCancelledError);
      await expect(check).rejects.toMatchObject(CANCELLED);
      await expect(checkRelay("https://relay.example.com")).rejects.toBeInstanceOf(
        RelayCheckCancelledError
      );
      expect(netFetch).toHaveBeenCalledTimes(1);
    });

    it("isn't cancelled by turning on again", async () => {
      saved.value = { enabled: true, consentedAt: 1 };
      let answer!: (response: Response) => void;
      netFetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      netFetch.mockImplementation(async () => new Response("gone", { status: 410 }));

      const check = checkRelay("https://relay.example.com");
      await vi.waitFor(() => expect(netFetch).toHaveBeenCalled());
      await setDecisionsEnabled(true);
      answer(Response.json({ ok: true }));

      await expect(check).resolves.toMatchObject({ result: "not-a-relay", status: 410 });
    });
  });

  describe("relay setup", () => {
    const SECRET = "claim-secret-0123456789abcdef";
    const CLAIMED = {
      relayOrigin: "https://relay.example.com",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    };
    const REFUSED = {
      result: "refused",
      origin: "https://relay.example.com",
      reason: "wrong-secret",
      kept: false,
    } as const;

    it("tells connected Hosts of the owner identity a claim records, at once (#16022)", async () => {
      const announceOwnerState = vi.fn(
        () => (saved.value as { deviceId?: string | null }).deviceId ?? null
      );
      const withdraw = setDecisionsHostsPort({
        hosts: () => [],
        linkFor: () => null,
        onLinkOpened: () => () => {},
        onHostsChanged: () => () => {},
        runtimeOf: () => null,
        announceOwnerState,
      });
      try {
        saved.value = { enabled: true, consentedAt: 5 };
        await startDecisionsIfEnabled();
        setupRuns.claim.mockResolvedValue({ identity: CLAIMED });

        await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

        // Announced with the identity already saved, so the Hosts hear which owner speaks.
        expect(announceOwnerState.mock.results.map((result) => result.value)).toEqual([
          CLAIMED.deviceId,
        ]);
      } finally {
        withdraw();
      }
    });

    it("records a claimed relay's origin and ids with a host id minted for this computer", async () => {
      saved.value = { enabled: true, consentedAt: 5, proxyAllowlisted: true };
      await startDecisionsIfEnabled();
      const service = peekDecisionsService()!;
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      writeFileSync(keyFile.path, "sealed");

      const result = await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      expect(result).toEqual({
        result: "saved",
        status: withRevision({
          state: "not-connected",
          relayOrigin: CLAIMED.relayOrigin,
          consentedAt: 5,
          keysStored: true,
        }),
      });
      expect(setupRuns.claim).toHaveBeenCalledExactlyOnceWith(
        { url: "relay.example.com", claimSecret: SECRET },
        { keys: service.getKeyStore(), signal: expect.any(AbortSignal) }
      );
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
        relayOrigin: CLAIMED.relayOrigin,
        installationId: CLAIMED.installationId,
        deviceId: CLAIMED.deviceId,
        hostId: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      });
      expect(JSON.stringify(saved.value)).not.toContain(SECRET);
      expect(service.getSettings()?.relayOrigin).toBe(CLAIMED.relayOrigin);
    });

    it("records a claimed relay as unverified until a recovery kit is", async () => {
      saved.value = { enabled: true, ...RELAY, recoveryKit: { verifiedAt: 9, ...RELAY } };
      await disconnectRelay();
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED, kitVerified: false });

      const result = await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      expect(result).toMatchObject({ result: "saved" });
      expect(result).not.toHaveProperty("status.recoveryKitVerifiedAt");
      expect(saved.value).toMatchObject({ relayOrigin: CLAIMED.relayOrigin, recoveryKit: null });
    });

    it("records a restore as verified when its kit holds the identity kept here", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      setupRuns.restore.mockResolvedValue({ identity: CLAIMED, kitVerified: true });

      const result = await restoreIdentity({
        url: "https://relay.example.com",
        kit: "{}",
        passphrase: "correct horse battery staple",
      });

      const verifiedAt = (saved.value as { recoveryKit: { verifiedAt: number } }).recoveryKit
        .verifiedAt;
      expect(saved.value).toMatchObject({
        recoveryKit: {
          verifiedAt: expect.any(Number),
          relayOrigin: CLAIMED.relayOrigin,
          installationId: CLAIMED.installationId,
          deviceId: CLAIMED.deviceId,
        },
      });
      expect(result).toMatchObject({ status: { recoveryKitVerifiedAt: verifiedAt } });
    });

    it("records a restored identity the same way", async () => {
      saved.value = { enabled: true };
      setupRuns.restore.mockResolvedValue({ identity: CLAIMED, kitVerified: false });

      const result = await restoreIdentity({
        url: "https://relay.example.com",
        kit: "{}",
        passphrase: "correct horse battery staple",
      });

      expect(result).toMatchObject({
        result: "saved",
        status: { relayOrigin: CLAIMED.relayOrigin },
      });
      expect(saved.value).toMatchObject({
        relayOrigin: CLAIMED.relayOrigin,
        installationId: CLAIMED.installationId,
        deviceId: CLAIMED.deviceId,
      });
      expect(JSON.stringify(saved.value)).not.toContain("correct horse");
    });

    it("reports what stopped a claim and leaves the setting as it was", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      vi.mocked(store.set).mockClear();
      setupRuns.claim.mockResolvedValue({ failure: REFUSED });

      await expect(claimRelay({ url: "relay.example.com", claimSecret: SECRET })).resolves.toEqual(
        REFUSED
      );
      expect(store.set).not.toHaveBeenCalled();
    });

    it("refuses while off without making a service", async () => {
      saved.value = { enabled: false };

      await expect(
        claimRelay({ url: "relay.example.com", claimSecret: SECRET })
      ).rejects.toMatchObject(CANCELLED);
      await expect(disconnectRelay()).rejects.toMatchObject(CANCELLED);
      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(peekDecisionsService()).toBeNull();
    });

    it("refuses to claim or restore over a relay already set up", async () => {
      saved.value = { enabled: true, ...RELAY };

      await expect(claimRelay({ url: "relay.example.com", claimSecret: SECRET })).resolves.toEqual({
        result: "conflict",
        origin: RELAY.relayOrigin,
        unfinished: false,
      });
      await expect(
        restoreIdentity({ url: "relay.example.com", kit: "{}", passphrase: "correct horse" })
      ).resolves.toEqual({ result: "conflict", origin: RELAY.relayOrigin, unfinished: false });
      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(setupRuns.restore).not.toHaveBeenCalled();
    });

    it("disconnects by removing the key file and the relay's ids, keeping the switch and consent", async () => {
      saved.value = {
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
        ...RELAY,
        recoveryKit: { verifiedAt: 9, ...RELAY },
      };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");

      const status = await disconnectRelay();

      expect(existsSync(keyFile.path)).toBe(false);
      expect(status).toEqual(withRevision({ state: "not-connected", consentedAt: 5 }));
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
      });
      expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBeNull();
    });

    it("reports keys stored on this computer from the file alone", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      expect(await getDecisionsStatus()).toEqual(withRevision({ state: "not-connected" }));

      writeFileSync(keyFile.path, "sealed");

      expect(await getDecisionsStatus()).toEqual(
        withRevision({ state: "not-connected", keysStored: true })
      );
    });

    it("turns off only once a claim in flight has settled, keeping what it recorded", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      let finish!: (outcome: unknown) => void;
      setupRuns.claim.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

      const claim = claimRelay({ url: "relay.example.com", claimSecret: SECRET });
      await vi.waitFor(() => expect(setupRuns.claim).toHaveBeenCalled());
      let off = false;
      const turningOff = setDecisionsEnabled(false).then(() => (off = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(off).toBe(false);

      finish({ identity: CLAIMED });
      await claim;
      await turningOff;

      expect(saved.value).toMatchObject({ enabled: false, relayOrigin: CLAIMED.relayOrigin });
    });

    it("aborts a claim's requests at quit", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      let signal!: AbortSignal;
      setupRuns.claim.mockImplementation(
        (_payload: unknown, options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            signal = options.signal;
            signal.addEventListener("abort", () => resolve({ failure: REFUSED }));
          })
      );

      const claim = claimRelay({ url: "relay.example.com", claimSecret: SECRET });
      await vi.waitFor(() => expect(setupRuns.claim).toHaveBeenCalled());
      await stopDecisions();

      expect(signal.aborted).toBe(true);
      await expect(claim).resolves.toEqual(REFUSED);
    });
  });
  describe("guided deploy claim (#16200)", () => {
    const CLAIMED = {
      relayOrigin: "https://relay.example.com",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    };
    const SECRET = "claim-secret-0123456789abcdef";
    const COMPLETED = {
      status: "completed",
      url: "https://relay.example.com",
      claimSecret: SECRET,
      claimState: "unclaimed",
    } as const;
    const voice = () => ({}) as never;

    beforeEach(() => {
      deployHosts.events = [];
    });

    it("claims a completed deploy's relay with no renderer, and says so on the status", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      const { id } = await prepareRelayDeploy(voice);

      deployHosts.events[0]!.onResult(COMPLETED);
      await vi.waitFor(async () =>
        expect((await getDecisionsStatus()).relayDeploy?.claim).toEqual({
          state: "claimed",
          origin: CLAIMED.relayOrigin,
        })
      );

      expect(setupRuns.claim).toHaveBeenCalledExactlyOnceWith(
        { url: COMPLETED.url, claimSecret: SECRET },
        expect.anything()
      );
      expect(saved.value).toMatchObject({ relayOrigin: CLAIMED.relayOrigin });
      const status = await getDecisionsStatus();
      expect(status.relayDeploy).toMatchObject({ id, state: "completed" });
      expect(status.relayDeploy).not.toHaveProperty("holdsClaimSecret");
      const pushed = pushedStatuses();
      expect(pushed.map((push) => (push.relayDeploy as { claim?: unknown })?.claim)).toContainEqual(
        {
          state: "claiming",
        }
      );
      expect(JSON.stringify(pushed)).not.toContain(SECRET);
      expect(JSON.stringify(saved.value)).not.toContain(SECRET);
      await expect(claimDeployedRelay({ deployId: id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("sends nothing for a deploy dropped by a switch change queued ahead of its claim", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      await prepareRelayDeploy(voice);

      deployHosts.events[0]!.onResult(COMPLETED);
      const off = setDecisionsEnabled(false);
      const on = setDecisionsEnabled(true);
      await Promise.all([off, on]);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(saved.value).not.toHaveProperty("relayOrigin", CLAIMED.relayOrigin);
      expect((await getDecisionsStatus()).relayDeploy).toBeUndefined();
    });

    it("leaves Connection as it was for a cancelled deploy", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      await prepareRelayDeploy(voice);

      deployHosts.events[0]!.onResult({ ...COMPLETED, status: "cancelled", error: "Stopped" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(setupRuns.claim).not.toHaveBeenCalled();
      expect(saved.value).not.toHaveProperty("relayOrigin", CLAIMED.relayOrigin);
      expect((await getDecisionsStatus()).relayDeploy).toMatchObject({
        state: "cancelled",
        holdsClaimSecret: true,
        error: "Stopped",
      });
    });

    it("finishes a claim that didn't save with the same secret, answering the status after it", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      setupRuns.claim.mockResolvedValueOnce({
        failure: {
          result: "unreachable",
          origin: CLAIMED.relayOrigin,
          reason: "timeout",
          kept: true,
        },
      });
      const { id } = await prepareRelayDeploy(voice);

      deployHosts.events[0]!.onResult(COMPLETED);
      await vi.waitFor(async () =>
        expect((await getDecisionsStatus()).relayDeploy).toMatchObject({
          holdsClaimSecret: true,
          claim: {
            state: "failed",
            failure: {
              result: "unreachable",
              origin: CLAIMED.relayOrigin,
              reason: "timeout",
              kept: true,
            },
          },
        })
      );
      expect(saved.value).not.toHaveProperty("relayOrigin", CLAIMED.relayOrigin);

      setupRuns.claim.mockResolvedValueOnce({ identity: CLAIMED });
      const result = await claimDeployedRelay({ deployId: id });

      expect(setupRuns.claim.mock.calls[1]![0]).toEqual({
        url: COMPLETED.url,
        claimSecret: SECRET,
      });
      expect(result).toMatchObject({
        result: "saved",
        status: {
          relayOrigin: CLAIMED.relayOrigin,
          relayDeploy: { claim: { state: "claimed", origin: CLAIMED.relayOrigin } },
        },
      });
    });
  });
  describe("relay connection", () => {
    const CLAIMED = {
      relayOrigin: "https://relay.example.com",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Daintree",
    };
    const SECRET = "claim-secret-0123456789abcdef";

    it("opens /mcp/decisions over the live Decisions bearers, this machine's host id and the MCP listener", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      connections[0]!.options.onQuestionsReady!({
        identity: () => null,
        live: () => null,
        store: {} as never,
        policy: {} as never,
      });
      expect(openedRoutes).toHaveLength(1);
      const { sources } = openedRoutes[0]!;

      paneTokens.set("decisions-token", {
        paneId: "pane-1",
        principal: "principal-1",
        workspaceId: "p1",
      });
      controlTokens.set("control-token", { paneId: "pane-2", principal: "principal-2" });
      expect(sources.bearerFor("decisions-token")).toEqual({
        paneId: "pane-1",
        principal: "principal-1",
        workspaceId: "p1",
      });
      // A control-surface bearer opens the control surface, never this route (#16012).
      expect(sources.bearerFor("control-token")).toBeNull();
      expect(sources.bearerFor("api-key")).toBeNull();
      expect(sources.principalFor("pane-1")).toBe("principal-1");
      expect(sources.principalFor("pane-2")).toBeNull();
      expect(sources.principalFor("pane-unknown")).toBeNull();
      // Delivery checks an answer's run against the same principal (#16012).
      expect(entryHooks.delivery?.principalFor("pane-1")).toBe("principal-1");
      expect(entryHooks.delivery?.principalFor("pane-2")).toBeNull();
      expect(sources.hostId()).toBe(RELAY.hostId);
      expect(sources.getPtyClient()).toBe(mcpRefs.ptyClient);

      const route = { path: "/mcp/decisions", handle: async () => {} };
      await sources.holdListener("decisions", route);
      expect(mcpRefs.holdListener).toHaveBeenCalledWith("decisions", route);

      // A replacement takes the listener only once this route has let go of it.
      connections[0]!.options.onQuestionsReady!({
        identity: () => null,
        live: () => null,
        store: {} as never,
        policy: {} as never,
      });
      let replaced = false;
      void openedRoutes[1]!.after!.then(() => {
        replaced = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replaced).toBe(false);
      openedRoutes[0]!.letGo();
      await vi.waitFor(() => expect(replaced).toBe(true));

      openedRoutes[1]!.letGo();
      await stopDecisions();
      expect(sources.hostId()).toBeNull();
    });

    it("loads the MCP server's module for the route's hold when nothing else has", async () => {
      mcpRefs.loaded = false;
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      connections[0]!.options.onQuestionsReady!({
        identity: () => null,
        live: () => null,
        store: {} as never,
        policy: {} as never,
      });
      const route = { path: "/mcp/decisions", handle: async () => {} };
      await expect(
        openedRoutes[0]!.sources.holdListener("decisions", route)
      ).resolves.toMatchObject({ port: 4200 });
      expect(mcpRefs.lazyHoldListener).toHaveBeenCalledWith("decisions", route);
      openedRoutes[0]!.letGo();
      await stopDecisions();
    });

    it("gives delivery the #16000 launch and prompt wait to resume a gone run's session with", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const resume = connections[0]!.options.delivery?.resume;
      expect(resume).toBeDefined();

      const request = {
        projectId: "project-1",
        worktreeId: "wt-1",
        agentId: "codex",
        sessionId: "session-1",
        cwd: "/repo/wt-1",
        signal: new AbortController().signal,
      };
      const launched = {
        status: "existing",
        projectId: "project-1",
        worktreeId: "wt-1",
        terminalId: "t-1",
      };
      viewless.resume.mockResolvedValueOnce(launched);
      await expect(resume!.resumeSession(request)).resolves.toBe(launched);
      expect(viewless.resume).toHaveBeenCalledWith(request);
      viewless.resume.mockRejectedValueOnce(new Error("no deps"));
      await expect(resume!.resumeSession(request)).rejects.toThrow("no deps");

      const waitOptions = { timeoutMs: 5_000, signal: request.signal, promptOnly: true as const };
      const waited = { terminalId: "t-1", outcome: "timeout" };
      viewless.wait.mockResolvedValueOnce(waited);
      await expect(resume!.waitForPrompt("t-1", waitOptions)).resolves.toBe(waited);
      expect(viewless.wait).toHaveBeenCalledWith("t-1", waitOptions);

      const dir = mkdtempSync(join(tmpdir(), "decisions-resume-"));
      const file = join(dir, "not-a-folder");
      writeFileSync(file, "");
      await expect(resume!.isDirectory(dir)).resolves.toBe(true);
      await expect(resume!.isDirectory(file)).resolves.toBe(false);
      rmSync(dir, { recursive: true, force: true });
      await expect(resume!.isDirectory(join(tmpdir(), "decisions-no-such-dir"))).rejects.toThrow();
      await stopDecisions();
    });

    it("connects at boot once a relay is set up, and not before", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(0);
      await stopDecisions();
      _resetDecisionsForTesting();

      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.started).toBe(1);
      expect(connections[0]!.options.relay).toEqual({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: RELAY.deviceId,
      });
    });

    it("tells this machine's windows when the connection says the devices changed, until quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;
      // The connection shares the lifetime's key rotations with revoke and rotate.
      expect(connection!.options.rotations).toBe(peekDecisionsService()?.getKeyRotations());
      const devicesPushes = () =>
        statusView.send.mock.calls.filter(
          ([channel, event]) =>
            channel === CHANNELS.EVENTS_PUSH &&
            (event as { name: string }).name === "decisions:devices-changed"
        );

      connection!.options.onDevicesChanged?.();
      expect(devicesPushes()).toEqual([
        [CHANNELS.EVENTS_PUSH, { name: "decisions:devices-changed", payload: null }],
      ]);

      await stopDecisions();
      connection!.options.onDevicesChanged?.();
      expect(devicesPushes()).toHaveLength(1);
    });

    it("pushes what the connection observes to this machine's windows, newest revision last", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      const seen: Array<Record<string, unknown>> = [];
      for (const next of [
        { state: "connecting" as const },
        { state: "reconnecting" as const, nextAttemptAt: 9_000 },
        { state: "connected" as const },
      ]) {
        connection!.options.onStatus(next);
        await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe(next.state));
        seen.push(pushedStatuses().at(-1)!);
      }

      expect(seen[1]).toMatchObject({
        state: "reconnecting",
        nextAttemptAt: 9_000,
        relayOrigin: RELAY.relayOrigin,
      });
      const revisions = pushedStatuses().map((status) => status.revision as number);
      expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
      expect(revisions.at(-1)).toBeGreaterThan(revisions[0]!);
      // A read now is as new as the last push, never older.
      expect((await getDecisionsStatus()).revision).toBe(revisions.at(-1));
    });

    it("records a revocation against the identity, and connects with it no more", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      connection!.options.onStatus({ state: "revoked" });
      connection!.options.onRevoked();

      expect(saved.value).toMatchObject({ ...RELAY, revokedAt: expect.any(Number) });
      expect((await getDecisionsStatus()).state).toBe("revoked");

      await setDecisionsEnabled(false);
      const status = await setDecisionsEnabled(true);
      expect(status.state).toBe("revoked");
      expect(connections).toHaveLength(1);
    });

    it("records a revocation only against the identity the setting now holds", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();

      entryHooks.onRelayRevoked!({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: "dev_87654321",
      });
      expect((saved.value as { revokedAt?: unknown }).revokedAt ?? null).toBeNull();
      expect(connections[0]!.stopped).toBe(0);

      entryHooks.onRelayRevoked!({
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: RELAY.deviceId,
      });
      expect(saved.value).toMatchObject({ revokedAt: expect.any(Number) });
      expect(connections[0]!.stopped).toBe(1);
    });

    it("stops the connection before it removes the keys it runs on", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");

      await disconnectRelay();

      expect(connections[0]!.stopped).toBe(1);
      expect(connections[0]!.keyFileAtStop).toBe(true);
      expect(existsSync(keyFile.path)).toBe(false);
      expect(connections).toHaveLength(1);
    });

    it("connects again after a revoked identity is disconnected and a relay claimed", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY, revokedAt: 99 };
      await startDecisionsIfEnabled();
      expect((await getDecisionsStatus()).state).toBe("revoked");
      expect(connections).toHaveLength(0);

      writeFileSync(keyFile.path, "sealed");
      await disconnectRelay();
      setupRuns.claim.mockResolvedValue({ identity: CLAIMED });
      await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      expect(saved.value).toMatchObject({ revokedAt: null, deviceId: CLAIMED.deviceId });
      expect(connections).toHaveLength(1);
      expect(connections[0]!.started).toBe(1);
    });

    it("pushes the status after a setup that failed, since it may have kept keys", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      await vi.waitFor(() => expect(pushedStatuses().length).toBeGreaterThan(0));
      const before = pushedStatuses().at(-1)!.revision as number;
      setupRuns.claim.mockImplementation(async () => {
        writeFileSync(keyFile.path, "staged");
        return {
          failure: {
            result: "unreachable",
            origin: CLAIMED.relayOrigin,
            reason: "timeout",
            kept: true,
          },
        };
      });

      await claimRelay({ url: "relay.example.com", claimSecret: SECRET });

      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.keysStored).toBe(true));
      expect(pushedStatuses().at(-1)!.revision as number).toBeGreaterThan(before);
    });

    it("keeps pushes in order when changes overlap, the last carrying the newest status", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      const [connection] = connections;

      connection!.options.onStatus({ state: "connecting" });
      connection!.options.onStatus({ state: "reconnecting", nextAttemptAt: 9_000 });
      connection!.options.onStatus({ state: "connected" });

      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("connected"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const revisions = pushedStatuses().map((status) => status.revision as number);
      expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
      expect(pushedStatuses().at(-1)).toMatchObject({ state: "connected" });
      expect((await getDecisionsStatus()).revision).toBe(revisions.at(-1));
    });

    it("stops the connection when turned off, and pushes nothing at quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      await setDecisionsEnabled(false);
      expect(connections[0]!.stopped).toBe(1);
      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("off"));

      await setDecisionsEnabled(true);
      expect(connections).toHaveLength(2);
      await vi.waitFor(() => expect(pushedStatuses().at(-1)?.state).toBe("not-connected"));
      connections[1]!.options.onStatus({ state: "connecting" });
      statusView.send.mockClear();

      await stopDecisions();
      connections[1]!.options.onStatus({ state: "connected" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pushedStatuses()).toEqual([]);
      expect(connections[1]!.stopped).toBe(1);
    });
  });

  describe("data (#16025)", () => {
    const PASSPHRASE = "a long export passphrase";
    const ARCHIVE = {
      fileName: "decisions-export-2026-11-01.dxz.json",
      text: '{"v":1,"kdf":"PBKDF2-SHA256"}',
      questions: 2,
      auditEvents: 5,
    };

    function exportTarget(): string {
      return join(keyFile.path, "..", ARCHIVE.fileName);
    }

    it("exports the archive to the file picked, readable by its owner alone", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });
      const chooser = vi.fn(async () => exportTarget());

      await expect(exportData({ passphrase: PASSPHRASE }, chooser)).resolves.toEqual({
        result: "saved",
        path: exportTarget(),
        questions: 2,
        auditEvents: 5,
      });

      expect(chooser).toHaveBeenCalledWith(ARCHIVE.fileName);
      expect(dataRuns.buildArchive).toHaveBeenCalledWith(
        expect.objectContaining({ passphrase: PASSPHRASE })
      );
      expect(readFileSync(exportTarget(), "utf8")).toBe(ARCHIVE.text);
      if (process.platform !== "win32") expect(statSync(exportTarget()).mode & 0o777).toBe(0o600);
      rmSync(exportTarget(), { force: true });
    });

    it("writes nothing when no file is picked, or Decisions turned off while the dialog was open", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).resolves.toEqual({
        result: "cancelled",
      });
      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await setDecisionsEnabled(false);
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      expect(existsSync(exportTarget())).toBe(false);
    });

    it("drops an archive whose store closed while the dialog was open, even with Decisions on again", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });

      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await setDecisionsEnabled(false);
          await setDecisionsEnabled(true);
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      await expect(
        exportData({ passphrase: PASSPHRASE }, async () => {
          await deleteLocalData();
          return exportTarget();
        })
      ).resolves.toEqual({ result: "cancelled" });
      expect(existsSync(exportTarget())).toBe(false);
    });

    it("holds a local deletion asked for mid-write until the archive is written", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      storedRows.count = 3;
      dataRuns.buildArchive.mockResolvedValue({ archive: ARCHIVE });
      let release!: () => void;
      writes.held = new Promise<void>((resolve) => (release = resolve));

      const exporting = exportData({ passphrase: PASSPHRASE }, async () => exportTarget());
      await vi.waitFor(() => expect(writes.writing).toBe(true));
      const deleting = deleteLocalData();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(storedRows.count).toBe(3);

      release();
      await expect(exporting).resolves.toMatchObject({ result: "saved" });
      await expect(deleting).resolves.toMatchObject({ result: "deleted" });
      expect(storedRows.count).toBe(0);
      rmSync(exportTarget(), { force: true });
    });

    it("hands back what stopped the archive being built, opening no dialog", async () => {
      saved.value = { enabled: true };
      await startDecisionsIfEnabled();
      dataRuns.buildArchive.mockResolvedValue({ failure: { result: "no-identity" } });
      const chooser = vi.fn(async () => exportTarget());

      await expect(exportData({ passphrase: PASSPHRASE }, chooser)).resolves.toEqual({
        result: "no-identity",
      });
      expect(chooser).not.toHaveBeenCalled();
    });

    it("says the history isn't open when the lifetime has no store", async () => {
      saved.value = { enabled: true };
      loads.failNextOpen = true;
      await expect(startDecisionsIfEnabled()).rejects.toThrow("store unavailable");

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).resolves.toEqual({
        result: "store-unavailable",
      });
      expect(dataRuns.buildArchive).not.toHaveBeenCalled();
    });

    it("refuses a passphrase shorter than the archive's encryption takes", async () => {
      saved.value = { enabled: true };

      await expect(
        exportData({ passphrase: "short" }, async () => exportTarget())
      ).rejects.toMatchObject({ code: "VALIDATION" });
      expect(dataRuns.buildArchive).not.toHaveBeenCalled();
    });

    it("refuses to export or delete while off, making no service", async () => {
      saved.value = { enabled: false, ...RELAY };

      await expect(exportData({ passphrase: PASSPHRASE }, async () => null)).rejects.toMatchObject(
        CANCELLED
      );
      await expect(deleteRelayData({ origin: RELAY.relayOrigin })).rejects.toMatchObject(CANCELLED);
      await expect(deleteLocalData()).rejects.toMatchObject(CANCELLED);
      expect(peekDecisionsService()).toBeNull();
    });

    it("deletes the relay's data for the relay confirmed, with the setting as it reads now", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.deleteRelay.mockResolvedValue({ result: "deleted", origin: RELAY.relayOrigin });

      await expect(deleteRelayData({ origin: RELAY.relayOrigin })).resolves.toEqual({
        result: "deleted",
        origin: RELAY.relayOrigin,
      });
      expect(dataRuns.deleteRelay).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: RELAY.relayOrigin,
          settings: expect.objectContaining({ relayOrigin: RELAY.relayOrigin }),
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("aborts a relay deletion's request at quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startDecisionsIfEnabled();
      dataRuns.deleteRelay.mockImplementation(
        (options: { signal: AbortSignal }) =>
          new Promise((resolve) => {
            options.signal.addEventListener("abort", () =>
              resolve({ result: "unconfirmed", origin: RELAY.relayOrigin, reason: "network" })
            );
          })
      );

      const deleting = deleteRelayData({ origin: RELAY.relayOrigin });
      await vi.waitFor(() => expect(dataRuns.deleteRelay).toHaveBeenCalled());
      await stopDecisions();

      await expect(deleting).resolves.toMatchObject({ result: "unconfirmed" });
    });

    it("deletes this computer's rows, keys and relay record, keeping the switch and consent", async () => {
      saved.value = { enabled: true, consentedAt: 5, proxyAllowlisted: true, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;

      await expect(deleteLocalData()).resolves.toEqual({
        result: "deleted",
        status: withRevision({ state: "not-connected", consentedAt: 5 }),
      });

      expect(storedRows.count).toBe(0);
      expect(existsSync(keyFile.path)).toBe(false);
      expect(saved.value).toEqual({
        ...defaultDecisionsSettings(),
        enabled: true,
        consentedAt: 5,
        proxyAllowlisted: true,
      });
      expect(peekDecisionsService()?.getSettings()?.relayOrigin).toBeNull();
      expect(peekDecisionsService()?.getStore()).not.toBeNull();
      // Every window hears the relay record go, not only the one that asked.
      await vi.waitFor(() =>
        expect(pushedStatuses().at(-1)).toEqual(
          withRevision({ state: "not-connected", consentedAt: 5 })
        )
      );
    });

    it("leaves everything as it was when the rows can't be deleted", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;
      storedRows.failErase = true;

      await expect(deleteLocalData()).resolves.toEqual({ result: "failed", reason: "storage" });

      expect(storedRows.count).toBe(3);
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
      expect(saved.value).toMatchObject({ enabled: true, consentedAt: 5, ...RELAY });
    });
  });

  describe("guided relay removal (#16202)", () => {
    const TERMINAL = "daintree-decisions-remove-00000000-0000-4000-8000-000000000001";
    let pty: EventEmitter & { getTerminalProjectId: () => string };
    let realPty: unknown;

    beforeEach(() => {
      realPty = mcpRefs.ptyClient;
      pty = Object.assign(new EventEmitter(), { getTerminalProjectId: () => "project-a" });
      mcpRefs.ptyClient = pty as unknown as typeof mcpRefs.ptyClient;
    });
    afterEach(() => {
      mcpRefs.ptyClient = realPty as typeof mcpRefs.ptyClient;
    });

    /** The spawn handler sending the removal, and its terminal ending by itself with `exitCode`. */
    function removalExits(exitCode: number) {
      noteRelayRemovalLaunch(TERMINAL);
      pty.emit("spawn-result", TERMINAL, { success: true, id: TERMINAL, spawnedAt: 1_000 });
      pty.emit("incarnation-exit", {
        terminalId: TERMINAL,
        spawnedAt: 1_000,
        exitCode,
        signal: null,
      });
    }

    async function removalOutcome() {
      const status = await getDecisionsStatus();
      return status.relayRemovals?.find((entry) => entry.terminalId === TERMINAL)?.outcome;
    }

    it("forgets the relay and its keys once the removal exits 0, keeping the history", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;

      expect(
        startRelayRemoval({
          terminalId: TERMINAL,
          origin: RELAY.relayOrigin,
          deleteLocalHistory: false,
        })
      ).toMatchObject({ recorded: true, outcome: { state: "running" } });
      removalExits(0);

      await vi.waitFor(async () =>
        expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "forgotten" })
      );
      expect(existsSync(keyFile.path)).toBe(false);
      expect(saved.value).toMatchObject({ enabled: true, consentedAt: 5, relayOrigin: null });
      expect(storedRows.count).toBe(3);
      // Connection is back to its first run: no relay recorded, no keys.
      const status = await getDecisionsStatus();
      expect(status.relayOrigin).toBeUndefined();
      expect(status.keysStored).toBeUndefined();
    });

    it("deletes this computer's Decisions data too when that was chosen", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;

      startRelayRemoval({
        terminalId: TERMINAL,
        origin: RELAY.relayOrigin,
        deleteLocalHistory: true,
      });
      removalExits(0);

      await vi.waitFor(async () =>
        expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "deleted" })
      );
      expect(storedRows.count).toBe(0);
      expect(saved.value).toMatchObject({ relayOrigin: null });
    });

    it("keeps the record, keys and history when the removal doesn't exit 0", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      storedRows.count = 3;

      startRelayRemoval({
        terminalId: TERMINAL,
        origin: RELAY.relayOrigin,
        deleteLocalHistory: true,
      });
      removalExits(1);

      expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 1, local: "kept" });
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
      expect(saved.value).toMatchObject(RELAY);
      expect(storedRows.count).toBe(3);
    });

    it.each([false, true])(
      "changes nothing when another identity is recorded while the forget waits its turn (delete history: %s)",
      async (deleteLocalHistory) => {
        saved.value = { enabled: true, consentedAt: 5, ...RELAY };
        await startDecisionsIfEnabled();
        writeFileSync(keyFile.path, "sealed");
        storedRows.count = 3;
        // An export's write holds the transitions, so the forget queues behind it.
        dataRuns.buildArchive.mockResolvedValue({
          archive: { fileName: "race.json", text: "{}", questions: 0, auditEvents: 0 },
        });
        let release!: () => void;
        writes.held = new Promise<void>((resolve) => (release = resolve));
        const exporting = exportData({ passphrase: "a long export passphrase" }, async () =>
          join(keyFile.path, "..", "race.json")
        );
        await vi.waitFor(() => expect(writes.writing).toBe(true));

        startRelayRemoval({ terminalId: TERMINAL, origin: RELAY.relayOrigin, deleteLocalHistory });
        removalExits(0);
        expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "pending" });

        // The same relay, recorded again under a new device while the forget waits.
        saved.value = { enabled: true, consentedAt: 5, ...RELAY, deviceId: "dev_87654321" };
        release();
        await exporting;

        await vi.waitFor(async () =>
          expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "changed" })
        );
        expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
        expect(storedRows.count).toBe(3);
        expect(saved.value).toMatchObject({ deviceId: "dev_87654321" });
      }
    );

    it("changes nothing when another identity was recorded while the removal ran", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      startRelayRemoval({
        terminalId: TERMINAL,
        origin: RELAY.relayOrigin,
        deleteLocalHistory: false,
      });

      // The same relay, claimed again from this computer under new ids.
      saved.value = { enabled: true, consentedAt: 5, ...RELAY, deviceId: "dev_87654321" };
      removalExits(0);

      await vi.waitFor(async () =>
        expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "changed" })
      );
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
      expect(saved.value).toMatchObject({ deviceId: "dev_87654321" });
    });

    it("forgets nothing here for a relay that isn't the one recorded", async () => {
      saved.value = { enabled: true, consentedAt: 5 };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");

      expect(
        startRelayRemoval({
          terminalId: TERMINAL,
          origin: "https://unclaimed.example.workers.dev",
          deleteLocalHistory: true,
        })
      ).toMatchObject({ recorded: false, deleteLocalHistory: false });
      removalExits(0);

      expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "none" });
      // An unfinished setup's keys are the person's to remove.
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
    });

    it("keeps the record when Decisions was turned off before the removal ended", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      startRelayRemoval({
        terminalId: TERMINAL,
        origin: RELAY.relayOrigin,
        deleteLocalHistory: false,
      });

      await setDecisionsEnabled(false);
      removalExits(0);

      await vi.waitFor(async () =>
        expect(await removalOutcome()).toEqual({ state: "exited", exitCode: 0, local: "off" })
      );
      expect(saved.value).toMatchObject({ enabled: false, ...RELAY });
      expect(readFileSync(keyFile.path, "utf8")).toBe("sealed");
    });

    it("pushes each change to Settings and the pane", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();

      startRelayRemoval({
        terminalId: TERMINAL,
        origin: RELAY.relayOrigin,
        deleteLocalHistory: false,
      });
      removalExits(1);

      await vi.waitFor(() =>
        expect(
          pushedStatuses().map(
            (status) => (status.relayRemovals as { outcome: unknown }[] | undefined)?.[0]?.outcome
          )
        ).toContainEqual({ state: "exited", exitCode: 1, local: "kept" })
      );
    });
  });

  describe("recovery kit", () => {
    const PASSPHRASE = "correct horse battery staple";
    const RECORDED = {
      relayOrigin: RELAY.relayOrigin,
      installationId: RELAY.installationId,
      deviceId: RELAY.deviceId,
    };
    const KIT_TEXT = '{"v":1,"kdf":"PBKDF2-SHA256"}\n';
    let outDir = "";

    beforeAll(() => {
      outDir = mkdtempSync(join(tmpdir(), "decisions-kit-out-"));
    });

    afterAll(() => {
      rmSync(outDir, { recursive: true, force: true });
    });

    async function setUp(extra: Record<string, unknown> = {}) {
      saved.value = { enabled: true, ...RELAY, ...extra };
      await startDecisionsIfEnabled();
      writeFileSync(keyFile.path, "sealed");
      kitRuns.make.mockResolvedValue({ recorded: RECORDED, text: KIT_TEXT });
    }

    function holdDialog() {
      let answer!: (path: string | null) => void;
      const choosePath = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
      return { choosePath, answer: (path: string | null) => answer(path) };
    }

    it("reads setup as unfinished until a kit is verified, without asking the keychain", async () => {
      await setUp();
      expect(await getDecisionsStatus()).not.toHaveProperty("recoveryKitVerifiedAt");

      saved.value = { enabled: true, ...RELAY, recoveryKit: { verifiedAt: 42, ...RECORDED } };
      expect(await getDecisionsStatus()).toMatchObject({ recoveryKitVerifiedAt: 42 });

      // A verification for keys that are gone protects nothing.
      rmSync(keyFile.path);
      expect(await getDecisionsStatus()).not.toHaveProperty("recoveryKitVerifiedAt");
      expect(kitRuns.make).not.toHaveBeenCalled();
      expect(kitRuns.check).not.toHaveBeenCalled();
    });

    it("saves the kit where the person chose, owner-only, without recording a verification", async () => {
      await setUp();
      const target = join(outDir, "kit.json");
      const choosePath = vi.fn(async () => target);
      vi.mocked(store.set).mockClear();

      const result = await exportRecoveryKit({ passphrase: PASSPHRASE }, choosePath);

      expect(result).toEqual({ result: "saved", fileName: "kit.json" });
      expect(choosePath).toHaveBeenCalledExactlyOnceWith(
        "decisions-recovery-kit-relay.example.com.json"
      );
      expect(kitRuns.make).toHaveBeenCalledExactlyOnceWith(
        peekDecisionsService()!.getKeyStore(),
        expect.objectContaining(RECORDED),
        PASSPHRASE
      );
      expect(readFileSync(target, "utf8")).toBe(KIT_TEXT);
      if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(store.set).not.toHaveBeenCalled();
    });

    it("writes nothing when the person cancels the dialog", async () => {
      await setUp();
      const target = join(outDir, "cancelled.json");

      await expect(
        exportRecoveryKit({ passphrase: PASSPHRASE }, async () => null)
      ).resolves.toEqual({ result: "cancelled" });
      expect(kitWrites.calls).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it("passes on what stopped a kit being made, and opens no dialog", async () => {
      await setUp();
      const failure = { result: "no-identity", reason: "keys-mismatch" } as const;
      kitRuns.make.mockResolvedValue({ failure });
      const choosePath = vi.fn();

      await expect(exportRecoveryKit({ passphrase: PASSPHRASE }, choosePath)).resolves.toEqual(
        failure
      );
      expect(choosePath).not.toHaveBeenCalled();
    });

    it("refuses to write the kit beside the sealed keys", async () => {
      await setUp();
      const beside = join(keyFile.path, "..", "kit.json");

      await expect(
        exportRecoveryKit({ passphrase: PASSPHRASE }, async () => beside)
      ).rejects.toMatchObject({ name: "AppError", code: "INVALID_PATH" });
      expect(existsSync(beside)).toBe(false);
    });

    it("never holds the switch's transitions while the dialog is open", async () => {
      await setUp();
      const dialog = holdDialog();

      const saving = exportRecoveryKit({ passphrase: PASSPHRASE }, dialog.choosePath);
      await vi.waitFor(() => expect(dialog.choosePath).toHaveBeenCalled());
      // A claim, a check or the switch would queue behind anything held here.
      await expect(getDecisionsStatus()).resolves.toMatchObject({ state: "not-connected" });
      await setDecisionsEnabled(true);

      dialog.answer(join(outDir, "held.json"));
      await expect(saving).resolves.toEqual({ result: "saved", fileName: "held.json" });
    });

    it.each([
      ["turning off", () => setDecisionsEnabled(false)],
      ["disconnecting", () => disconnectRelay()],
      ["deleting local data", () => deleteLocalData()],
      ["quitting", () => stopDecisions()],
    ])(
      "is cancelled by %s while the dialog is open, and writes nothing after",
      async (_name, act) => {
        await setUp();
        const dialog = holdDialog();
        const target = join(outDir, `after-${_name}.json`);

        const saving = exportRecoveryKit({ passphrase: PASSPHRASE }, dialog.choosePath);
        const cancelled = expect(saving).rejects.toMatchObject(CANCELLED);
        await vi.waitFor(() => expect(dialog.choosePath).toHaveBeenCalled());
        await act();

        await cancelled;
        dialog.answer(target);
        // Anything the answer could set off would queue behind the transitions.
        await startDecisionsIfEnabled();
        expect(kitWrites.calls).toEqual([]);
        expect(existsSync(target)).toBe(false);
      }
    );

    it.each([
      ["turning off", () => setDecisionsEnabled(false)],
      ["disconnecting", () => disconnectRelay()],
      ["deleting local data", () => deleteLocalData()],
      ["quitting", () => stopDecisions()],
    ])("opens no dialog when %s while the kit is being made", async (_name, act) => {
      await setUp();
      let made!: (value: unknown) => void;
      kitRuns.make.mockReturnValue(new Promise((resolve) => (made = resolve)));
      const choosePath = vi.fn(async () => join(outDir, "never.json"));

      const saving = exportRecoveryKit({ passphrase: PASSPHRASE }, choosePath);
      const cancelled = expect(saving).rejects.toMatchObject(CANCELLED);
      await vi.waitFor(() => expect(kitRuns.make).toHaveBeenCalled());
      const acted = act();
      made({ recorded: RECORDED, text: KIT_TEXT });
      await cancelled;
      await acted;

      expect(choosePath).not.toHaveBeenCalled();
    });

    it("writes nothing when quit lands while the kit's folder is being checked", async () => {
      await setUp();
      const target = join(outDir, "during-quit.json");
      let release!: () => void;
      statGate.hold = new Promise((resolve) => (release = resolve));

      const saving = exportRecoveryKit({ passphrase: PASSPHRASE }, async () => target);
      const cancelled = expect(saving).rejects.toMatchObject(CANCELLED);
      await vi.waitFor(() => expect(statGate.started).toBeGreaterThan(0));
      await stopDecisions();
      release();
      await cancelled;

      expect(kitWrites.calls).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it("lets go of the passphrase once the kit is locked, before the dialog opens", async () => {
      await setUp();
      const dialog = holdDialog();
      const payload = { passphrase: PASSPHRASE };

      const saving = exportRecoveryKit(payload, dialog.choosePath);
      await vi.waitFor(() => expect(dialog.choosePath).toHaveBeenCalled());

      expect(kitRuns.make).toHaveBeenCalledWith(expect.anything(), expect.anything(), PASSPHRASE);
      expect(payload.passphrase).toBe("");
      dialog.answer(null);
      await expect(saving).resolves.toEqual({ result: "cancelled" });
    });

    it("writes nothing when another identity was set up while the dialog was open", async () => {
      await setUp();
      const dialog = holdDialog();
      const target = join(outDir, "moved.json");

      const saving = exportRecoveryKit({ passphrase: PASSPHRASE }, dialog.choosePath);
      await vi.waitFor(() => expect(dialog.choosePath).toHaveBeenCalled());
      saved.value = { ...(saved.value as object), deviceId: "dev_another_one" };
      dialog.answer(target);

      await expect(saving).rejects.toMatchObject(CANCELLED);
      expect(kitWrites.calls).toEqual([]);
      expect(existsSync(target)).toBe(false);
    });

    it("records a verified kit for the identity it checked, finishing setup", async () => {
      await setUp({ consentedAt: 5 });
      kitRuns.check.mockResolvedValue({ verified: RECORDED });

      const result = await verifyRecoveryKit({ kit: KIT_TEXT, passphrase: PASSPHRASE });

      expect(kitRuns.check).toHaveBeenCalledExactlyOnceWith(
        peekDecisionsService()!.getKeyStore(),
        expect.objectContaining(RECORDED),
        KIT_TEXT,
        PASSPHRASE
      );
      const record = (saved.value as { recoveryKit: { verifiedAt: number } }).recoveryKit;
      expect(record).toEqual({ verifiedAt: expect.any(Number), ...RECORDED });
      expect(result).toEqual({
        result: "verified",
        status: {
          state: "not-connected",
          relayOrigin: RELAY.relayOrigin,
          consentedAt: 5,
          keysStored: true,
          recoveryKitVerifiedAt: record.verifiedAt,
          revision: expect.any(Number),
        },
      });
      expect(peekDecisionsService()!.getSettings()?.recoveryKit).toEqual(record);
      // Every window's Settings learns setup is finished, not just the one that asked.
      await vi.waitFor(() =>
        expect(pushedStatuses().at(-1)).toMatchObject({ recoveryKitVerifiedAt: record.verifiedAt })
      );
      expect(JSON.stringify(saved.value)).not.toContain(PASSPHRASE);
    });

    it("keeps an earlier verification when a later kit is refused", async () => {
      const earlier = { verifiedAt: 42, ...RECORDED };
      await setUp({ recoveryKit: earlier });
      const refused = { result: "kit-refused", reason: "missing-epochs" } as const;
      kitRuns.check.mockResolvedValue({ failure: refused });
      vi.mocked(store.set).mockClear();

      await expect(verifyRecoveryKit({ kit: KIT_TEXT, passphrase: PASSPHRASE })).resolves.toEqual(
        refused
      );
      expect(store.set).not.toHaveBeenCalled();
      expect(saved.value).toMatchObject({ recoveryKit: earlier });
    });

    it("refuses to save or verify while off, making no service", async () => {
      saved.value = { enabled: false, ...RELAY };

      await expect(
        exportRecoveryKit({ passphrase: PASSPHRASE }, async () => join(outDir, "off.json"))
      ).rejects.toMatchObject(CANCELLED);
      await expect(
        verifyRecoveryKit({ kit: KIT_TEXT, passphrase: PASSPHRASE })
      ).rejects.toMatchObject(CANCELLED);
      expect(peekDecisionsService()).toBeNull();
      expect(kitRuns.make).not.toHaveBeenCalled();
      expect(kitRuns.check).not.toHaveBeenCalled();
    });
  });

  describe("launch port (#16012)", () => {
    const SOURCE = {
      identity: () => null,
      live: () => null,
      store: {} as never,
      policy: {} as never,
    };

    it("is null while off, and makes no service", async () => {
      saved.value = { enabled: false, ...RELAY };
      await expect(decisionsLaunchPort()).resolves.toBeNull();
      expect(peekDecisionsService()).toBeNull();
    });

    it("starts the lifetime boot hasn't, and hands over the route's port once it opens", async () => {
      saved.value = { enabled: true, ...RELAY };
      const port = decisionsLaunchPort();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      connections[0]!.options.onQuestionsReady!(SOURCE);

      await expect(port).resolves.toBe(4100);
      // Boot's own start later carries on the same lifetime.
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(1);
      await expect(decisionsLaunchPort()).resolves.toBe(4100);
      openedRoutes[0]!.letGo();
      await stopDecisions();
    });

    it("hands the port to every launch that came in while the lifetime was starting", async () => {
      saved.value = { enabled: true, ...RELAY };
      let open!: () => void;
      loads.opening = new Promise<void>((resolve) => {
        open = resolve;
      });
      const first = decisionsLaunchPort();
      // The start has its settings but no store or connection yet.
      await vi.waitFor(() =>
        expect(peekDecisionsService()?.getSettings()).toMatchObject({ enabled: true })
      );
      const second = decisionsLaunchPort();
      expect(connections).toHaveLength(0);

      open();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      connections[0]!.options.onQuestionsReady!(SOURCE);
      await expect(Promise.all([first, second])).resolves.toEqual([4100, 4100]);
      openedRoutes[0]!.letGo();
      await stopDecisions();
    });

    it("goes ahead without the route when the lifetime is still starting at the deadline", async () => {
      saved.value = { enabled: true, ...RELAY };
      let open!: () => void;
      loads.opening = new Promise<void>((resolve) => {
        open = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let settled = false;
      try {
        const port = decisionsLaunchPort();
        void port.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(port).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
      open();
      await stopDecisions();
    });

    it("is null at once with no relay set up, and after quitting", async () => {
      saved.value = { enabled: true };
      await expect(decisionsLaunchPort()).resolves.toBeNull();
      expect(connections).toHaveLength(0);

      saved.value = { enabled: true, ...RELAY };
      await stopDecisions();
      await expect(decisionsLaunchPort()).resolves.toBeNull();
    });

    it("goes ahead without the route once the wait is up", async () => {
      saved.value = { enabled: true, ...RELAY };
      // A connection still loading its identity: a keychain prompt, say.
      await startDecisionsIfEnabled();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        let settled = false;
        const port = decisionsLaunchPort();
        void port.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(port).resolves.toBeNull();
        expect(connections).toHaveLength(1);
        expect(openedRoutes).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
      await stopDecisions();
    });
  });

  describe("enrolled Remote Host (#16022)", () => {
    const OWNER = { installationId: RELAY.installationId, ownerDeviceId: "dev_owner_0001" };
    const HOST_RECORD = {
      relayOrigin: RELAY.relayOrigin,
      installationId: RELAY.installationId,
      deviceId: "dev_host_00001",
      ownerDeviceId: OWNER.ownerDeviceId,
      hostId: "host_on_studio",
      ownerOffAt: null,
      revokedAt: null,
      credentialsRemovedAt: null,
    };
    const BINDING = {
      relayOrigin: HOST_RECORD.relayOrigin,
      installationId: HOST_RECORD.installationId,
      deviceId: HOST_RECORD.deviceId,
    };
    const SOURCE = {
      identity: () => null,
      live: () => null,
      store: {} as never,
      policy: {} as never,
    };

    it("runs as the enrolled Host its record names, with this computer's switch off", async () => {
      savedHost.value = HOST_RECORD;
      await startDecisionsIfEnabled();

      const service = peekDecisionsService()!;
      expect(service.getRole()).toBe("host");
      expect(connections).toHaveLength(1);
      expect(connections[0]!.options).toMatchObject({ relay: BINDING, role: "desktop-host" });
      // Its panes' questions carry the Host's own id, and their answers are typed against it.
      connections[0]!.options.onQuestionsReady!(SOURCE);
      expect(openedRoutes[0]!.sources.hostId()).toBe(HOST_RECORD.hostId);
      expect(connections[0]!.options.delivery!.hostId()).toBe(HOST_RECORD.hostId);
      // The switch here is still this computer's own, and off.
      expect((await getDecisionsStatus()).state).toBe("off");
      expect(saved.value).toBeUndefined();
      openedRoutes[0]!.letGo();
      await stopDecisions();
    });

    it("hands agents launched on the Host the route's port", async () => {
      savedHost.value = HOST_RECORD;
      const port = decisionsLaunchPort();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      connections[0]!.options.onQuestionsReady!(SOURCE);

      await expect(port).resolves.toBe(4100);
      openedRoutes[0]!.letGo();
      await stopDecisions();
    });

    it("starts nothing for a Host its owner turned off, and makes no service on a machine never enrolled", async () => {
      await startDecisionsIfEnabled();
      await expect(decisionsLaunchPort()).resolves.toBeNull();
      expect(peekDecisionsService()).toBeNull();

      savedHost.value = { ...HOST_RECORD, ownerOffAt: 100 };
      await startDecisionsIfEnabled();
      await expect(decisionsLaunchPort()).resolves.toBeNull();
      expect(connections).toHaveLength(0);
      expect(decisionsHostRuntimeFor(OWNER)).toEqual({
        state: "owner-off",
        deviceId: HOST_RECORD.deviceId,
        since: 100,
      });
    });

    it("is turned off and on by its owner's Shell alone, keeping its keys while off", async () => {
      savedHost.value = HOST_RECORD;
      writeFileSync(keyFile.path, "sealed");
      await startDecisionsIfEnabled();

      // Another owner's Shell isn't heard, and hears nothing of this Host.
      await expect(
        applyOwnerState({ ...OWNER, ownerDeviceId: "dev_other_0001", enabled: false })
      ).resolves.toEqual({ state: "not-enrolled" });
      expect(connections[0]!.stopped).toBe(0);

      await expect(applyOwnerState({ ...OWNER, enabled: false })).resolves.toEqual({
        state: "owner-off",
        deviceId: HOST_RECORD.deviceId,
        since: expect.any(Number),
      });
      expect(connections[0]!.stopped).toBe(1);
      expect(peekDecisionsService()!.getRole()).toBeNull();
      expect(savedHost.value).toMatchObject({ ownerOffAt: expect.any(Number) });
      expect(existsSync(keyFile.path)).toBe(true);
      // Off stays off across a restart.
      await startDecisionsIfEnabled();
      expect(connections).toHaveLength(1);

      connections.length = 0;
      await expect(applyOwnerState({ ...OWNER, enabled: true })).resolves.toMatchObject({
        state: "running",
        deviceId: HOST_RECORD.deviceId,
      });
      expect(savedHost.value).toMatchObject({ ownerOffAt: null });
      expect(connections).toHaveLength(1);
      expect(connections[0]!.started).toBe(1);
      await stopDecisions();
    });

    it("stops when the relay revokes it, removes its keys and stored questions, and says why", async () => {
      savedHost.value = HOST_RECORD;
      writeFileSync(keyFile.path, heldKeys(HOST_RECORD.deviceId));
      storedRows.count = 3;
      await startDecisionsIfEnabled();
      const changes = vi.fn();
      onDecisionsHostRuntimeChanged(changes);

      entryHooks.onRelayRevoked!(BINDING, "host");

      await vi.waitFor(() =>
        expect(decisionsHostRuntimeFor(OWNER)).toEqual({
          state: "revoked",
          deviceId: HOST_RECORD.deviceId,
          since: expect.any(Number),
          credentialsRemoved: true,
        })
      );
      expect(existsSync(keyFile.path)).toBe(false);
      expect(storedRows.count).toBe(0);
      expect(peekDecisionsService()!.getRole()).toBeNull();
      expect(changes).toHaveBeenCalled();
      // The owner's own setting is never written for it.
      expect(saved.value).toBeUndefined();
      // Revoked stays stopped: neither a restart nor its owner starts it again.
      connections.length = 0;
      await startDecisionsIfEnabled();
      await applyOwnerState({ ...OWNER, enabled: true });
      expect(connections).toHaveLength(0);
    });

    it("never removes keys an enrollment saved for another device while the revocation waited", async () => {
      savedHost.value = HOST_RECORD;
      await startDecisionsIfEnabled();
      // The owner enrolled this Host again: the key file holds the new device's keys.
      writeFileSync(keyFile.path, heldKeys("dev_host_00002"));

      entryHooks.onRelayRevoked!(BINDING, "host");

      await vi.waitFor(() =>
        expect(savedHost.value).toMatchObject({ credentialsRemovedAt: expect.any(Number) })
      );
      expect(readFileSync(keyFile.path, "utf8")).toBe(heldKeys("dev_host_00002"));
    });

    it("finishes removing a revoked Host's keys at the next start when it couldn't before", async () => {
      savedHost.value = { ...HOST_RECORD, revokedAt: 50 };
      writeFileSync(keyFile.path, heldKeys(HOST_RECORD.deviceId));
      storedRows.count = 1;
      storedRows.failErase = true;

      // The rows can't be deleted this time: nothing is recorded as removed.
      await startDecisionsIfEnabled();
      expect(storedRows.count).toBe(1);
      expect(savedHost.value).toMatchObject({ revokedAt: 50, credentialsRemovedAt: null });
      expect(peekDecisionsService()!.getRole()).toBeNull();

      await startDecisionsIfEnabled();

      expect(existsSync(keyFile.path)).toBe(false);
      expect(storedRows.count).toBe(0);
      expect(savedHost.value).toMatchObject({
        revokedAt: 50,
        credentialsRemovedAt: expect.any(Number),
      });
      // Nothing connected on the way.
      expect(connections).toHaveLength(0);
    });

    it("starts a Host taken up while its owner's Shell said Decisions is off as off", async () => {
      await noteHostIdentity(
        {
          relayOrigin: HOST_RECORD.relayOrigin,
          installationId: HOST_RECORD.installationId,
          deviceId: HOST_RECORD.deviceId,
          ownerDeviceId: OWNER.ownerDeviceId,
        },
        { ownerEnabled: false }
      );

      expect(savedHost.value).toMatchObject({ ownerOffAt: expect.any(Number) });
      expect(connections).toHaveLength(0);
    });

    it("leaves the record naming the old device while that device's questions can't be removed", async () => {
      savedHost.value = HOST_RECORD;
      storedRows.count = 2;
      storedRows.failErase = true;
      const held = {
        relayOrigin: HOST_RECORD.relayOrigin,
        installationId: HOST_RECORD.installationId,
        deviceId: "dev_host_00002",
        ownerDeviceId: OWNER.ownerDeviceId,
      };

      await noteHostIdentity(held);
      expect(savedHost.value).toMatchObject({ deviceId: HOST_RECORD.deviceId });
      expect(storedRows.count).toBe(2);

      // The next read of the key file tries again.
      await noteHostIdentity(held);
      expect(savedHost.value).toMatchObject({ deviceId: "dev_host_00002" });
      expect(storedRows.count).toBe(0);
      await stopDecisions();
    });

    it("takes up an identity it holds, and drops a replaced device's questions but keeps its host id", async () => {
      const held = {
        relayOrigin: HOST_RECORD.relayOrigin,
        installationId: HOST_RECORD.installationId,
        deviceId: HOST_RECORD.deviceId,
        ownerDeviceId: OWNER.ownerDeviceId,
      };
      await noteHostIdentity(held);
      const first = savedHost.value as typeof HOST_RECORD;
      expect(first).toMatchObject({ ...held, ownerOffAt: null, revokedAt: null });
      expect(first.hostId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(connections).toHaveLength(1);

      // The same device again, as each status read finds it, changes nothing.
      await applyOwnerState({ ...OWNER, enabled: false });
      await noteHostIdentity(held);
      expect(savedHost.value).toMatchObject({ ownerOffAt: expect.any(Number) });

      storedRows.count = 2;
      await noteHostIdentity({ ...held, deviceId: "dev_host_00002" });
      expect(storedRows.count).toBe(0);
      expect(savedHost.value).toMatchObject({
        deviceId: "dev_host_00002",
        hostId: first.hostId,
        ownerOffAt: null,
      });
      expect(connections.at(-1)!.options.relay.deviceId).toBe("dev_host_00002");
      await stopDecisions();
    });

    it("gives way to this computer's own switch, and comes back when it is off again", async () => {
      savedHost.value = HOST_RECORD;
      await startDecisionsIfEnabled();
      expect(peekDecisionsService()!.getRole()).toBe("host");

      saved.value = { consentedAt: 5 };
      await setDecisionsEnabled(true);
      expect(peekDecisionsService()!.getRole()).toBe("owner");
      expect(connections[0]!.stopped).toBe(1);

      await setDecisionsEnabled(false);
      expect(peekDecisionsService()!.getRole()).toBe("host");
      expect(connections.at(-1)!.options.role).toBe("desktop-host");
      await stopDecisions();
    });

    it("tells connected Hosts whenever this computer's switch changes", async () => {
      // What the setting said as each announcement went out.
      const announceOwnerState = vi.fn(() => (saved.value as { enabled?: boolean }).enabled);
      const withdraw = setDecisionsHostsPort({
        hosts: () => [],
        linkFor: () => null,
        onLinkOpened: () => () => {},
        onHostsChanged: () => () => {},
        runtimeOf: () => null,
        announceOwnerState,
      });
      try {
        saved.value = { consentedAt: 5, ...RELAY };
        await setDecisionsEnabled(true);
        await setDecisionsEnabled(false);
        expect(announceOwnerState.mock.results.map((result) => result.value)).toEqual([
          true,
          false,
        ]);
      } finally {
        withdraw();
      }
    });
  });

  describe("Remote Hosts (#16021)", () => {
    /** A Host from before enrollment, so a run ends at its first step. */
    function olderHostLink() {
      const status = vi.fn(async () => ({ ok: false as const, failure: "needs-update" as const }));
      const link: DecisionsHostLink = {
        isOpen: true,
        onClose: () => () => {},
        hold: () => () => {},
        status,
        request: vi.fn(),
        accept: vi.fn(),
      };
      return { link, status };
    }

    function publishPort(links: Map<string, DecisionsHostLink>) {
      const opened = new Set<(hostId: string, link: DecisionsHostLink) => void>();
      const port: DecisionsHostsPort = {
        hosts: () => [...links.keys()].map((hostId) => ({ hostId, name: hostId })),
        linkFor: (hostId) => links.get(hostId) ?? null,
        onLinkOpened: (listener) => {
          opened.add(listener);
          return () => opened.delete(listener);
        },
        onHostsChanged: () => () => {},
        runtimeOf: () => null,
        announceOwnerState: vi.fn(),
      };
      const withdraw = setDecisionsHostsPort(port);
      return {
        withdraw,
        open(hostId: string, link: DecisionsHostLink) {
          links.set(hostId, link);
          for (const listener of opened) listener(hostId, link);
        },
      };
    }

    it("asks a connected Host only once Decisions connects, and nothing once it is off", async () => {
      const links = new Map<string, DecisionsHostLink>();
      const studio = olderHostLink();
      links.set("studio", studio.link);
      const port = publishPort(links);
      try {
        saved.value = { enabled: true, consentedAt: 5, ...RELAY };
        await startDecisionsIfEnabled();
        const [connection] = connections;
        connection!.options.onStatus({ state: "connecting" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(studio.status).not.toHaveBeenCalled();

        connection!.options.onStatus({ state: "connected" });
        await vi.waitFor(() => expect(studio.status).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () =>
          expect(await listHosts()).toMatchObject({
            result: "listed",
            autoEnroll: true,
            hosts: [{ hostId: "studio", enrollment: { state: "needs-update" }, canEnroll: false }],
          })
        );

        await setDecisionsEnabled(false);
        const lab = olderHostLink();
        port.open("lab", lab.link);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(lab.status).not.toHaveBeenCalled();
      } finally {
        port.withdraw();
      }
    });

    it("saves automatic enrollment's switch with everything else as it was", async () => {
      saved.value = { enabled: true, consentedAt: 5, ...RELAY };
      await startDecisionsIfEnabled();

      await expect(setAutoEnrollHosts(false)).resolves.toMatchObject({
        result: "listed",
        autoEnroll: false,
      });
      expect(saved.value).toMatchObject({
        enabled: true,
        consentedAt: 5,
        ...RELAY,
        autoEnrollHosts: false,
      });
      await expect(listHosts()).resolves.toMatchObject({ autoEnroll: false });

      await setDecisionsEnabled(false);
      await expect(setAutoEnrollHosts(true)).rejects.toMatchObject(CANCELLED);
    });
  });

  describe("setup check (#16024)", () => {
    /** What the setup check pushes to this machine's windows carried, in order. */
    function pushedRuns(): Array<{ runId: string; state: string; revision: number }> {
      return statusView.send.mock.calls
        .filter(
          ([channel, event]) =>
            channel === CHANNELS.EVENTS_PUSH &&
            (event as { name: string }).name === "decisions:setup-check-changed"
        )
        .map(
          ([, event]) =>
            (event as { payload: { runId: string; state: string; revision: number } }).payload
        );
    }

    async function settle(): Promise<void> {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }

    it("runs nothing without a relay set up, and refuses while off", async () => {
      saved.value = { enabled: true };
      await expect(startSetupCheck()).resolves.toEqual({ result: "not-set-up" });
      expect(setupChecks.made).toHaveLength(0);

      saved.value = { enabled: false, ...RELAY };
      _resetDecisionsForTesting();
      await expect(startSetupCheck()).rejects.toMatchObject(CANCELLED);
      expect(setupChecks.made).toHaveLength(0);
    });

    it("refuses a relay that revoked this computer", async () => {
      saved.value = { enabled: true, ...RELAY, revokedAt: 1_761_955_300_000 };
      await expect(startSetupCheck()).resolves.toEqual({ result: "revoked" });
      expect(setupChecks.made).toHaveLength(0);
    });

    it("runs one at a time against the identity set up here, pushing each change to this machine's windows", async () => {
      saved.value = { enabled: true, ...RELAY };

      const first = await startSetupCheck();
      const again = await startSetupCheck();

      expect(first).toMatchObject({ result: "started", run: { runId: "run-1", state: "running" } });
      // Asked again, it answers the run already going, which the asker didn't start.
      expect(again).toMatchObject({ result: "running", run: { runId: "run-1" } });
      expect(setupChecks.made).toHaveLength(1);
      const check = setupChecks.made[0]!;
      expect(check.deps.relay).toEqual(RELAY);
      expect(getSetupCheck()).toMatchObject({ runId: "run-1", state: "running" });

      // What it reports reaches this machine's windows as it is.
      const progress = { ...first, run: { ...(first as { run: object }).run, revision: 99 } };
      check.report(progress.run as never);
      expect(pushedRuns().map((run) => run.revision)).toContain(99);
    });

    it("hands the check the running lifetime's connection, status and store", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      const service = peekDecisionsService()!;
      const refresh = vi.spyOn(service, "refreshConnection").mockReturnValue(true);
      const source = vi.spyOn(service, "getQuestionSource").mockReturnValue(null);
      const deps = setupChecks.made[0]!.deps;

      expect(deps.refreshConnection()).toBe(true);
      expect(deps.questionSource()).toBeNull();
      expect(deps.status()).toEqual(service.getStatus());
      expect(refresh).toHaveBeenCalledOnce();
      expect(source).toHaveBeenCalledOnce();
    });

    it("makes one check for two starts that both wait on the service starting", async () => {
      saved.value = { enabled: true, ...RELAY };
      let open!: () => void;
      loads.opening = new Promise<void>((resolve) => {
        open = resolve;
      });

      const first = startSetupCheck();
      const second = startSetupCheck();
      await settle();
      open();
      const results = await Promise.all([first, second]);

      expect(setupChecks.made).toHaveLength(1);
      expect(results.map((result) => result.result).sort()).toEqual(["running", "started"]);
    });

    it("makes no check for a start still waiting on the service when Decisions is turned off", async () => {
      saved.value = { enabled: true, ...RELAY };
      let open!: () => void;
      loads.opening = new Promise<void>((resolve) => {
        open = resolve;
      });

      const start = startSetupCheck();
      await settle();
      const off = setDecisionsEnabled(false);
      open();

      await expect(start).rejects.toMatchObject(CANCELLED);
      await off;
      expect(setupChecks.made).toHaveLength(0);
    });

    it("records a check that ran to the end against its identity, which the status then shows", async () => {
      saved.value = { enabled: true, ...RELAY };
      writeFileSync(keyFile.path, "sealed");
      await startSetupCheck();
      const updateSettings = vi.spyOn(peekDecisionsService()!, "updateSettings");

      setupChecks.made[0]!.finish("failed", "question");
      await settle();

      // Written to the store alone: the service's settings never take it.
      expect(updateSettings).not.toHaveBeenCalled();

      const recorded = (saved.value as { setupCheck: { checkedAt: number } }).setupCheck;
      expect(recorded).toEqual({
        checkedAt: expect.any(Number),
        relayOrigin: RELAY.relayOrigin,
        installationId: RELAY.installationId,
        deviceId: RELAY.deviceId,
        failedStep: "question",
      });
      expect(getSetupCheck()).toMatchObject({ runId: "run-1", state: "failed" });
      expect(recorded.checkedAt).toBe(getSetupCheck()!.finishedAt);
      await expect(getDecisionsStatus()).resolves.toMatchObject({
        setupCheck: { checkedAt: recorded.checkedAt, failedStep: "question" },
      });
      // A status push queued before it may still be reading the key file.
      await vi.waitFor(() =>
        expect(pushedStatuses().at(-1)).toMatchObject({
          setupCheck: { checkedAt: recorded.checkedAt, failedStep: "question" },
        })
      );
      // A check of keys known to be gone protects nothing, so the status doesn't show it.
      rmSync(keyFile.path, { force: true });
      expect((await getDecisionsStatus()).setupCheck).toBeUndefined();
      writeFileSync(keyFile.path, "sealed");

      // Another run starts, passes, and replaces it.
      await startSetupCheck();
      setupChecks.made[1]!.finish("passed");
      await settle();
      expect((saved.value as { setupCheck: { failedStep: unknown } }).setupCheck.failedStep).toBe(
        null
      );
    });

    it("records nothing for a cancelled check, and keeps the result before it", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      setupChecks.made[0]!.finish("passed");
      await settle();
      const recorded = (saved.value as { setupCheck: unknown }).setupCheck;
      const second = await startSetupCheck();
      vi.mocked(store.set).mockClear();

      await expect(
        cancelSetupCheck({ runId: (second as { run: { runId: string } }).run.runId })
      ).resolves.toMatchObject({ runId: "run-2", state: "cancelled" });
      await settle();

      expect(store.set).not.toHaveBeenCalled();
      expect((saved.value as { setupCheck: unknown }).setupCheck).toEqual(recorded);
      expect(getSetupCheck()).toMatchObject({ runId: "run-2", state: "cancelled" });
    });

    it("cancels only the run a cancel names, so a late one can't end a newer run", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();

      await expect(cancelSetupCheck({ runId: "run-0" })).resolves.toMatchObject({
        runId: "run-1",
        state: "running",
      });
      expect(setupChecks.made[0]!.cancelled).toBe(0);
    });

    it("doesn't record a check whose identity changed while it ran", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();

      // Another identity recorded under it, as a new setup would.
      saved.value = { ...(saved.value as object), deviceId: "dev_another_1" };
      setupChecks.made[0]!.finish("passed");
      await settle();

      expect((saved.value as { setupCheck?: unknown }).setupCheck ?? null).toBeNull();
    });

    it("doesn't record a check a disconnect called off, nor show or push it after", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      const check = setupChecks.made[0]!;
      let release!: () => void;
      setupChecks.holdCancel = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The run's end also ends the disconnect's wait on it, so the disconnect
      // is held before it removes the keys and the identity: otherwise its own
      // write would hide a record the run should never have made.
      const service = peekDecisionsService()!;
      const suspend = service.suspendConnection.bind(service);
      let suspending!: () => void;
      const reached = new Promise<void>((resolve) => {
        suspending = resolve;
      });
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      vi.spyOn(service, "suspendConnection").mockImplementationOnce(async () => {
        suspending();
        await resumed;
        return suspend();
      });

      const disconnecting = disconnectRelay();
      try {
        expect(check.cancelled).toBe(1);
        // The run ends as passed before its cancel lands: still not recorded.
        check.finish("passed");
        // Its own handler has run by the time the disconnect gets past the wait.
        await Promise.race([
          reached,
          disconnecting.then(() => {
            throw new Error("The disconnect never suspended the connection");
          }),
        ]);
        // Not even for a moment, while the disconnect is still under way.
        expect(saved.value).toMatchObject(RELAY);
        expect((saved.value as { setupCheck?: unknown }).setupCheck ?? null).toBeNull();
        expect(getSetupCheck()).toBeNull();
      } finally {
        release();
        resume();
        await disconnecting;
      }

      expect((saved.value as { setupCheck: unknown }).setupCheck).toBeNull();
      expect(getSetupCheck()).toBeNull();
      expect(pushedRuns().map((run) => run.state)).toEqual(["running"]);
    });

    it("waits for a running check's cleanup before turning off stops the service, and cancels one at quit", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      const service = peekDecisionsService()!;
      const stop = vi.spyOn(service, "stop");
      const check = setupChecks.made[0]!;
      let release!: () => void;
      setupChecks.holdCancel = new Promise<void>((resolve) => {
        release = resolve;
      });

      const off = setDecisionsEnabled(false);
      await settle();
      expect(check.cancelled).toBe(1);
      // The question is cancelled while the store is still open.
      expect(stop).not.toHaveBeenCalled();
      release();
      await off;

      expect(stop).toHaveBeenCalled();
      expect(getSetupCheck()).toBeNull();

      setupChecks.holdCancel = null;
      saved.value = { enabled: true, ...RELAY };
      _resetDecisionsForTesting();
      await startSetupCheck();
      await stopDecisions();
      expect(setupChecks.made[1]!.cancelled).toBe(1);
    });

    it("admits a start asked for while a disconnect is under way only once it has finished", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      let release!: () => void;
      setupChecks.holdCancel = new Promise<void>((resolve) => {
        release = resolve;
      });

      const disconnecting = disconnectRelay();
      await settle();
      const start = startSetupCheck();
      release();
      await disconnecting;

      await expect(start).resolves.toEqual({ result: "not-set-up" });
      expect(setupChecks.made).toHaveLength(1);
    });

    it("refuses a start asked for while turning off is under way", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();
      let release!: () => void;
      setupChecks.holdCancel = new Promise<void>((resolve) => {
        release = resolve;
      });

      const off = setDecisionsEnabled(false);
      await settle();
      const start = startSetupCheck();
      release();
      await off;

      await expect(start).rejects.toMatchObject(CANCELLED);
      expect(setupChecks.made).toHaveLength(1);
    });

    it("cancels a running check before deleting local data", async () => {
      saved.value = { enabled: true, ...RELAY };
      await startSetupCheck();

      await deleteLocalData();

      expect(setupChecks.made[0]!.cancelled).toBe(1);
      expect(getSetupCheck()).toBeNull();
    });

    it("forgets the setup check's result with the identity it checked", async () => {
      saved.value = {
        enabled: true,
        ...RELAY,
        setupCheck: {
          checkedAt: 2,
          relayOrigin: RELAY.relayOrigin,
          installationId: RELAY.installationId,
          deviceId: RELAY.deviceId,
          failedStep: null,
        },
      };
      writeFileSync(keyFile.path, "sealed");
      await startDecisionsIfEnabled();

      await disconnectRelay();

      expect((saved.value as { setupCheck: unknown }).setupCheck).toBeNull();
    });
  });
});
