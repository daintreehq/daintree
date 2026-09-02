import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * One project, several Daintree Assistant sessions (#12108).
 *
 * The engine takes an exclusive `owner.lock` on a project's state, which is why the
 * host used to be keyed by project alone: a second start found the running engine and
 * JOINED it, so two tabs drew one conversation and switching between them changed
 * nothing on screen.
 *
 * A lane is `(projectId, slot)`, and the lever that makes lanes possible is the engine's
 * own state namespace — it moves the per-project directory (and with it the lease) while
 * leaving the state root, so every lane is the same signed-in account with its own
 * conversation. These tests hold both halves: sibling lanes run side by side with
 * distinct namespaces, and a same-lane restart still displaces exactly as it always did.
 */

interface FakeHost {
  sessionId: string;
  disposed: boolean;
  env: Record<string, string>;
  descriptor: { projectId: string };
}
const hosts: FakeHost[] = [];

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost;
    constructor(opts: {
      descriptor: { sessionId: string; projectId: string };
      env: Record<string, string>;
    }) {
      this.record = {
        sessionId: opts.descriptor.sessionId,
        disposed: false,
        env: opts.env,
        descriptor: { projectId: opts.descriptor.projectId },
      };
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      return Promise.resolve();
    }
    getReadyEvent() {
      return { type: "host:ready", sessionId: this.record.sessionId, seq: 1, autoApprove: false };
    }
    getTranscript() {
      return { events: [], prompts: [], truncated: false };
    }
    recordPrompt() {}
    hasExited() {
      return this.record.disposed;
    }
    send() {
      return true;
    }
    getPid() {
      return 4321;
    }
    takePreReadyEvents() {
      return [];
    }
    dispose() {
      this.record.disposed = true;
    }
    waitForExit() {
      return Promise.resolve();
    }
  },
}));

vi.mock("../resolveAssistantBinary.js", () => ({
  ASSISTANT_BIN_ENV: "DAINTREE_ASSISTANT_BIN",
  resolveAssistantBinary: () =>
    Promise.resolve({ path: "/nonexistent/daintree-assistant", source: "repo" }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/daintree-lanes-test", isPackaged: false },
  webContents: {
    fromId: () => ({ isDestroyed: () => false, send: () => {} }),
  },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

/** Every lane the provisioner was asked for, so the bearer's lane can be asserted. */
const provisionedSlots: Array<number | undefined> = [];

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: (input: { slot?: number }) => {
      provisionedSlots.push(input.slot);
      return Promise.resolve({
        sessionId: `help_${provisionedSlots.length}`,
        sessionPath: "/tmp/daintree-lanes-test/help",
        token: "tok",
        tier: "action",
        mcpUrl: "http://127.0.0.1:1/mcp",
        windowId: 1,
      });
    },
    markEngineSession: () => true,
    getDebugLoggingPreference: () => false,
    getDebugLogging: () => false,
    getBypassPermissions: () => false,
    revokeSession: () => Promise.resolve(),
  },
}));

const REAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

const { AssistantHostService } = await import("../AssistantHostService.js");

const PROJECT = "p1";
const CWD = "/tmp/project";
const NAMESPACE = "DAINTREE_ASSISTANT_STATE_NAMESPACE";

beforeEach(() => {
  hosts.length = 0;
  provisionedSlots.length = 0;
});

describe("parallel assistant lanes (#12108)", () => {
  it("runs a second lane beside the first instead of joining it", async () => {
    const service = new AssistantHostService();
    const lane0 = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 0,
      windowId: 1,
      webContentsId: 10,
    });
    const lane1 = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 1,
      windowId: 1,
      webContentsId: 10,
    });

    // The bug this whole change is about: one engine, one session id, two tabs showing
    // the same conversation.
    expect(lane1.sessionId).not.toBe(lane0.sessionId);
    expect(hosts).toHaveLength(2);
    expect(hosts.every((h) => !h.disposed)).toBe(true);
  });

  it("gives each lane its own state namespace, and leaves the default lane's alone", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, slot: 0, windowId: 1, webContentsId: 10 });
    await service.start({ projectId: PROJECT, cwd: CWD, slot: 2, windowId: 1, webContentsId: 10 });

    // Unpackaged, so both carry the dev namespace — and the lane suffix is what keeps
    // their `owner.lock` files apart. Slot 0's spelling is unchanged, which is what
    // stops an upgrade moving an existing conversation.
    expect(hosts[0]?.env[NAMESPACE]).toBe("dev");
    expect(hosts[1]?.env[NAMESPACE]).toBe("dev-s2");
  });

  it("provisions a bearer per lane, so a sibling's control plane survives", async () => {
    const service = new AssistantHostService();
    await service.start({ projectId: PROJECT, cwd: CWD, slot: 0, windowId: 1, webContentsId: 10 });
    await service.start({ projectId: PROJECT, cwd: CWD, slot: 1, windowId: 1, webContentsId: 10 });

    // `displacePriorSessions` is keyed on `(projectId, slot)`, so passing the lane is
    // the whole of what stops lane 1's provision revoking lane 0's bearer.
    expect(provisionedSlots).toEqual([0, 1]);
  });

  it("still displaces within one lane", async () => {
    const service = new AssistantHostService();
    const first = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 1,
      windowId: 1,
      webContentsId: 10,
    });
    // A surface re-running its start effect for the SAME lane must replace its own
    // engine — two engines on one lane would fight over one lease.
    hosts[0]!.disposed = true;
    const second = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 1,
      windowId: 1,
      webContentsId: 10,
    });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(hosts).toHaveLength(2);
  });

  it("joins a lane that is already running rather than starting a rival", async () => {
    const service = new AssistantHostService();
    const first = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 1,
      windowId: 1,
      webContentsId: 10,
    });
    // A second window showing the same lane. Lanes did not change this: surfaces still
    // share one engine per lane.
    const joined = await service.start({
      projectId: PROJECT,
      cwd: CWD,
      slot: 1,
      windowId: 2,
      webContentsId: 11,
    });
    expect(joined.sessionId).toBe(first.sessionId);
    expect(joined.attachmentId).not.toBe(first.attachmentId);
    expect(hosts).toHaveLength(1);
  });

  it("treats an out-of-range slot as the default lane rather than minting a namespace", async () => {
    const service = new AssistantHostService();
    // Reachable by direct IPC. A slot outside the ceiling would otherwise create a state
    // directory outside the set the engine's GC knows how to collect.
    await service.start({ projectId: PROJECT, cwd: CWD, slot: 9, windowId: 1, webContentsId: 10 });
    expect(hosts[0]?.env[NAMESPACE]).toBe("dev");
    expect(provisionedSlots).toEqual([0]);
  });

  it("serializes an out-of-range slot against the lane it resolves to", async () => {
    const service = new AssistantHostService();
    // Both of these mean lane 0. Keyed on the RAW slot they queued separately, so both
    // passed the empty-lane check and both spawned — and the loser stayed in the session
    // map only, an engine holding lane 0's lease that no later start could displace.
    const [viaBadSlot, viaDefault] = await Promise.all([
      service.start({ projectId: PROJECT, cwd: CWD, slot: 9, windowId: 1, webContentsId: 10 }),
      service.start({ projectId: PROJECT, cwd: CWD, slot: 0, windowId: 1, webContentsId: 10 }),
    ]);
    expect(hosts).toHaveLength(1);
    expect(viaDefault.sessionId).toBe(viaBadSlot.sessionId);
  });

  it("keeps one lane's timer endpoint from answering for another", async () => {
    const service = new AssistantHostService();
    service.timers.rememberEndpoint(PROJECT, 0, { socketPath: "/tmp/a.sock", stateDir: "/a" });
    service.timers.rememberEndpoint(PROJECT, 1, { socketPath: "/tmp/b.sock", stateDir: "/b" });
    expect(service.timers.endpointFor(PROJECT, 0)?.socketPath).toBe("/tmp/a.sock");
    expect(service.timers.endpointFor(PROJECT, 1)?.socketPath).toBe("/tmp/b.sock");
    // Keyed by project alone, whichever lane booted last would answer for all of them.
    expect(service.timers.endpointFor(PROJECT)?.socketPath).toBe("/tmp/a.sock");
  });
});
