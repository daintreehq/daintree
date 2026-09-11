import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

/**
 * Which conversation a native lane continues (#12365).
 *
 * The engine keeps a conversation in its own database and continues it when handed its
 * id back, so an engine that went down with its view — evicted, crashed, its window
 * closed — has lost nothing but the host's knowledge of that id. These are the rules for
 * keeping it: which id, when it is written, what forgets it, and what never may.
 */

interface FakeHost {
  descriptor: { sessionId: string; resumeSessionId?: string };
  onEvent: (event: Record<string, unknown>) => void;
  disposed: boolean;
}

const hosts: FakeHost[] = [];
/** When true, the next engines never reach `host:ready`. */
let failReady = false;
/** An event each new engine emits after it is up but before the host has its ready frame. */
let preReadyEvent: ((sessionId: string) => Record<string, unknown>) | null = null;
/** Workspaces whose assistant panel their renderer last reported open. */
const panelOpen = new Set<string>();
const delivered: Array<{ webContentsId: number; channel: string; payload: unknown }> = [];

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost;
    private isReady = false;
    constructor(opts: Pick<FakeHost, "descriptor" | "onEvent">) {
      this.record = { descriptor: opts.descriptor, onEvent: opts.onEvent, disposed: false };
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      if (failReady) return Promise.reject(new Error("engine never became ready"));
      if (preReadyEvent) this.record.onEvent(preReadyEvent(this.record.descriptor.sessionId));
      this.isReady = true;
      return Promise.resolve();
    }
    getReadyEvent() {
      if (!this.isReady) return null;
      // The engine's own echo (internal/host/host.go): `resumedSessionId` is present
      // exactly when the descriptor carried a `resumeSessionId`.
      const { sessionId, resumeSessionId } = this.record.descriptor;
      return {
        type: "host:ready",
        sessionId,
        seq: 1,
        protocolVersion: 4,
        autoApprove: false,
        ...(resumeSessionId ? { resumedSessionId: resumeSessionId } : {}),
      };
    }
    getPid() {
      return null;
    }
    takePreReadyEvents() {
      return [];
    }
    hasExited() {
      return false;
    }
    getTranscript() {
      return { events: [], prompts: [], truncated: false };
    }
    send() {
      return true;
    }
    recordPrompt() {}
    dispose() {
      this.record.disposed = true;
    }
    waitForExit() {
      return Promise.resolve();
    }
  },
}));

const REAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
});

vi.mock("../resolveAssistantBinary.js", () => ({
  ASSISTANT_BIN_ENV: "DAINTREE_ASSISTANT_BIN",
  resolveAssistantBinary: () =>
    Promise.resolve({ path: "/nonexistent/daintree-assistant", source: "repo" }),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/nonexistent-userdata", isPackaged: false },
  webContents: {
    fromId: (webContentsId: number) => ({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        delivered.push({ webContentsId, channel, payload });
      },
    }),
  },
}));

vi.mock("../../../ipc/handlers/helpAssistant.js", () => ({
  getHelpAssistantSettings: () => ({ tier: "action" }),
}));

vi.mock("../../HelpSessionService.js", () => ({
  helpSessionService: {
    provisionSession: () => Promise.resolve(null),
    markEngineSession: () => true,
    getDebugLoggingPreference: () => false,
    getDebugLogging: () => false,
    getBypassPermissions: () => false,
    revokeSession: () => Promise.resolve(),
    isPanelOpen: (projectId: string) => panelOpen.has(projectId),
  },
}));

const { AssistantHostService } = await import("../AssistantHostService.js");
const { NativeAssistantResumeStore, __resetNativeAssistantResumeStoreForTests } = await import(
  "../NativeAssistantResumeStore.js"
);
const { assistantSlotKey } = await import("../../../../shared/config/assistantSlots.js");
const { CHANNELS } = await import("../../../ipc/channels.js");

const VIEW = { projectId: "p1", cwd: "/tmp/p1", webContentsId: 7, windowId: 1 };
const OTHER_WINDOW = { ...VIEW, webContentsId: 8, windowId: 2 };
const FOREIGN_VIEW = { ...VIEW, webContentsId: 9, windowId: 3, recordable: false };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The engine opens a turn — the moment a lane has a conversation worth continuing. */
function speak(host: FakeHost): void {
  host.onEvent({
    type: "turn:start",
    sessionId: host.descriptor.sessionId,
    seq: 2,
    turnId: "t1",
    role: "assistant",
    startedAt: 1,
  });
}

describe("native assistant resume lifecycle", () => {
  let tmpDir: string;
  let store: InstanceType<typeof NativeAssistantResumeStore>;

  const recorded = (slot = 0) =>
    store.get(assistantSlotKey("p1", slot))?.resumeSessionId ?? null;

  beforeEach(async () => {
    hosts.length = 0;
    delivered.length = 0;
    failReady = false;
    preReadyEvent = null;
    panelOpen.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-resume-lifecycle-"));
    store = new NativeAssistantResumeStore(path.join(tmpDir, "resume.json"));
    __resetNativeAssistantResumeStoreForTests(store);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Writes the service queued are drained before their directory goes.
    await store.flush();
    __resetNativeAssistantResumeStoreForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("continues the conversation a lane first had, however many engines later", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);
    expect(recorded()).toBe(first.sessionId);

    service.stopByWebContents(VIEW.webContentsId);
    await service.start(VIEW);
    expect(hosts[1]!.descriptor.resumeSessionId).toBe(first.sessionId);
    // A new engine, with a wire id of its own…
    expect(hosts[1]!.descriptor.sessionId).not.toBe(first.sessionId);
    speak(hosts[1]!);

    service.stopByWebContents(VIEW.webContentsId);
    await service.start(VIEW);
    // …which is NOT what the third one continues. The conversation is stored under the id
    // it began with; the second engine's own id — what its `host:shutdown` names as the
    // resume handle — holds nothing, and continuing from it opens an empty conversation
    // without an error anywhere.
    expect(hosts[2]!.descriptor.resumeSessionId).toBe(first.sessionId);
  });

  it("leaves nothing to continue for a lane nobody spoke in", async () => {
    const service = new AssistantHostService();
    await service.start(VIEW);
    service.stopByWebContents(VIEW.webContentsId);

    await service.start(VIEW);
    expect(hosts[1]!.descriptor).not.toHaveProperty("resumeSessionId");
    expect(await service.listResumable("p1")).toEqual([]);
  });

  it("waits for the engine to report a turn rather than counting a prompt it may refuse", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);

    service.send(
      { type: "prompt", sessionId: first.sessionId, text: "hello" } as never,
      VIEW.webContentsId
    );
    // Taken by the pipe is not taken by the engine: a prompt refused as busy stores
    // nothing, and a lane restored for it would announce a conversation that never began.
    expect(recorded()).toBeNull();

    speak(hosts[0]!);
    expect(recorded()).toBe(first.sessionId);
  });

  it("records a conversation that began before the host had the engine's ready frame", async () => {
    // A wake can open in the moment between the engine becoming ready and `host:ready`
    // being written. Asked then, the host cannot yet say which id the conversation is
    // stored under — and no later turn may come to ask again before the view is lost.
    preReadyEvent = (sessionId) => ({
      type: "turn:phase",
      sessionId,
      seq: 2,
      phase: "Waking",
      wake: true,
    });
    const service = new AssistantHostService();
    const first = await service.start(VIEW);

    expect(recorded()).toBe(first.sessionId);
  });

  it("keeps the record's age current while the conversation is in use", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const service = new AssistantHostService();
    await service.start(VIEW);
    speak(hosts[0]!);
    const firstAt = store.get(assistantSlotKey("p1", 0))!.capturedAt;

    // An engine up for longer than the store's staleness cutoff would otherwise still
    // carry its first turn's age, and be dropped on the next launch as abandoned.
    vi.setSystemTime(firstAt + DAY_MS + 1);
    speak(hosts[0]!);
    expect(store.get(assistantSlotKey("p1", 0))!.capturedAt).toBe(firstAt + DAY_MS + 1);
  });

  it("keeps the conversation through a start that fails", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);
    service.stopByWebContents(VIEW.webContentsId);

    failReady = true;
    await expect(service.start(VIEW)).rejects.toThrow(/ready/);
    failReady = false;

    await service.start(VIEW);
    expect(hosts[2]!.descriptor.resumeSessionId).toBe(first.sessionId);
  });

  it("declines the conversation on a fresh start, even one that then fails", async () => {
    const service = new AssistantHostService();
    await service.start(VIEW);
    speak(hosts[0]!);
    service.stopByWebContents(VIEW.webContentsId);

    failReady = true;
    await expect(service.start({ ...VIEW, fresh: true })).rejects.toThrow(/ready/);
    expect(hosts[1]!.descriptor).not.toHaveProperty("resumeSessionId");
    // The user asked for a new conversation. A failure to start one must not quietly hand
    // them the old one on the next attempt.
    expect(recorded()).toBeNull();
  });

  it("replaces a running engine on a fresh start rather than joining it", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);
    await service.start(OTHER_WINDOW);
    expect(hosts).toHaveLength(1);
    delivered.length = 0;

    const fresh = await service.start({ ...VIEW, fresh: true });

    // Joining would have handed "+ New session" the very conversation it replaces.
    expect(hosts).toHaveLength(2);
    expect(hosts[0]!.disposed).toBe(true);
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(hosts[1]!.descriptor).not.toHaveProperty("resumeSessionId");
    // The other window is told its session ended, rather than left typing into it.
    expect(delivered).toContainEqual({
      webContentsId: OTHER_WINDOW.webContentsId,
      channel: CHANNELS.ASSISTANT_HOST_EXIT,
      payload: { sessionId: first.sessionId, code: null, signal: null },
    });
  });

  it("discards one lane, and only after a start already on its way", async () => {
    const service = new AssistantHostService();
    await service.start(VIEW);
    speak(hosts[0]!);
    await service.start({ ...VIEW, slot: 1 });
    speak(hosts[1]!);
    service.stopByWebContents(VIEW.webContentsId);

    // Queued behind a start of the same lane. That start continues the conversation and
    // records it again at readiness, so a discard that jumped the queue would either be
    // undone by it or keep it from resuming at all.
    const restarting = service.start(VIEW);
    const discarding = service.discardResume("p1", 0, VIEW.webContentsId);
    await restarting;
    expect(await discarding).toBe(true);

    expect(hosts[2]!.descriptor.resumeSessionId).toBe(hosts[0]!.descriptor.sessionId);
    expect(recorded(0)).toBeNull();
    expect(recorded(1)).toBe(hosts[1]!.descriptor.sessionId);

    // The engine is still up until the asker's own detach lands. A turn arriving in that
    // gap must not bring back what was just discarded.
    speak(hosts[2]!);
    expect(recorded(0)).toBeNull();
  });

  it("starts a new engine rather than joining one whose conversation was discarded", async () => {
    const service = new AssistantHostService();
    await service.start(VIEW);
    speak(hosts[0]!);
    expect(await service.discardResume("p1", 0, VIEW.webContentsId)).toBe(true);

    // Armed again before Stop's own detach landed, while the discarded engine is still up.
    // Joining it would carry on the conversation Stop ended, and never record it again.
    const again = await service.start(VIEW);
    expect(hosts).toHaveLength(2);
    expect(hosts[0]!.disposed).toBe(true);
    expect(hosts[1]!.descriptor).not.toHaveProperty("resumeSessionId");

    speak(hosts[1]!);
    expect(recorded()).toBe(again.sessionId);
  });

  it("refuses to discard a conversation another window is still having", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);
    await service.start(OTHER_WINDOW);

    // Stop in one window ends only that window's attachment; the other is still talking,
    // and would lose the conversation to its next eviction.
    expect(await service.discardResume("p1", 0, VIEW.webContentsId)).toBe(false);
    expect(recorded()).toBe(first.sessionId);
  });

  it("lets a view that is not the workspace neither continue, discard nor overwrite it", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);
    service.stopByWebContents(VIEW.webContentsId);

    await service.start({ ...FOREIGN_VIEW, fresh: true });
    expect(hosts[1]!.descriptor).not.toHaveProperty("resumeSessionId");
    speak(hosts[1]!);

    expect(recorded()).toBe(first.sessionId);
  });

  it("makes a foreign view's engine the lane's conversation once the workspace joins it", async () => {
    const service = new AssistantHostService();
    const foreign = await service.start(FOREIGN_VIEW);
    speak(hosts[0]!);
    expect(recorded()).toBeNull();

    // The workspace's own view is now having this conversation. Left unrecorded, its next
    // eviction would lose it.
    await service.start(VIEW);
    expect(hosts).toHaveLength(1);
    speak(hosts[0]!);
    expect(recorded()).toBe(foreign.sessionId);
  });

  it("remembers whether the panel was open only when the engine went down with its view", async () => {
    const service = new AssistantHostService();
    panelOpen.add("p1");
    await service.start(VIEW);
    speak(hosts[0]!);

    service.stopByWebContents(VIEW.webContentsId);
    expect(await service.listResumable("p1")).toEqual([{ slot: 0, panelWasOpen: true }]);

    // Continuing the conversation is what that note was for; once it has, it is spent.
    const again = await service.start(VIEW);
    expect(await service.listResumable("p1")).toEqual([{ slot: 0, panelWasOpen: false }]);

    // The panel ending its own attachment is not a loss: the view is still there, with
    // nothing to come back to.
    service.detachSession(again.sessionId, VIEW.webContentsId, again.attachmentId);
    expect(await service.listResumable("p1")).toEqual([{ slot: 0, panelWasOpen: false }]);
  });

  it("treats a closed window as a lost view too", async () => {
    const service = new AssistantHostService();
    panelOpen.add("p1");
    await service.start(VIEW);
    speak(hosts[0]!);

    service.stopByWindow(VIEW.windowId);
    expect(await service.listResumable("p1")).toEqual([{ slot: 0, panelWasOpen: true }]);
  });

  it("keeps every lane's conversation through a quit", async () => {
    const service = new AssistantHostService();
    const first = await service.start(VIEW);
    speak(hosts[0]!);

    await service.shutdown(10);
    expect(recorded()).toBe(first.sessionId);
  });

  it("waits at quit for a conversation still on its way to disk", async () => {
    let release!: () => void;
    vi.spyOn(store, "flush").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const service = new AssistantHostService();
    await service.start(VIEW);

    let settled = false;
    const done = service.shutdown(5_000).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await done;
    expect(settled).toBe(true);
  });

  it("does not let a stuck write hold quit past its budget", async () => {
    vi.spyOn(store, "flush").mockReturnValue(new Promise<void>(() => {}));
    const service = new AssistantHostService();
    await service.start(VIEW);

    // Resolves at all: a write that never lands costs one conversation its continuity, not
    // the whole quit.
    await service.shutdown(20);
  });
});
