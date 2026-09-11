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
}

const hosts: FakeHost[] = [];
/** When true, the next engines never reach `host:ready`. */
let failReady = false;
/** Workspaces whose assistant panel their renderer last reported open. */
const panelOpen = new Set<string>();

vi.mock("../AssistantHostProcess.js", () => ({
  AssistantHostProcess: class {
    private readonly record: FakeHost;
    constructor(opts: FakeHost) {
      this.record = { descriptor: opts.descriptor, onEvent: opts.onEvent };
      hosts.push(this.record);
    }
    start() {}
    waitForReady() {
      return failReady ? Promise.reject(new Error("engine never became ready")) : Promise.resolve();
    }
    getReadyEvent() {
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
    dispose() {}
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
  webContents: { fromId: () => ({ isDestroyed: () => false, send: () => {} }) },
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

const VIEW = { projectId: "p1", cwd: "/tmp/p1", webContentsId: 7, windowId: 1 };

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
    failReady = false;
    panelOpen.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-resume-lifecycle-"));
    store = new NativeAssistantResumeStore(path.join(tmpDir, "resume.json"));
    __resetNativeAssistantResumeStoreForTests(store);
  });

  afterEach(async () => {
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
    const discarding = service.discardResume("p1", 0);
    await restarting;
    await discarding;

    expect(hosts[2]!.descriptor.resumeSessionId).toBe(hosts[0]!.descriptor.sessionId);
    expect(recorded(0)).toBeNull();
    expect(recorded(1)).toBe(hosts[1]!.descriptor.sessionId);

    // The engine that was running when it was discarded is still somebody's conversation
    // (another window can be watching it), so using it records it again.
    speak(hosts[2]!);
    expect(recorded(0)).toBe(hosts[0]!.descriptor.sessionId);
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
});
