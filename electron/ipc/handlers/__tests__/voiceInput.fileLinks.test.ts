import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spoken file references (#14616): a transcript that says an explicit command
// is tagged, its references resolve in the dictated terminal's worktree, a
// stop waits for the final utterance's to settle, and a miss sends nothing.

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "granted") },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

type ServiceEvent = { type: string; sessionId?: string; [key: string]: unknown };
type Detected = Array<{ description: string }>;

const shared = vi.hoisted(() => ({
  listeners: new Set<(e: ServiceEvent) => void>(),
  providerSessionId: null as string | null,
  drain: null as null | Promise<void>,
  projects: new Map<number, string>(),
  projectPaths: new Map<string, string>(),
  currentProject: null as null | { name: string; path: string },
  detect: vi.fn<(text: string, settings: unknown, signal?: AbortSignal) => Promise<Detected>>(),
  resolve:
    vi.fn<
      (payload: {
        cwd: string;
        description: string;
        signal?: AbortSignal;
      }) => Promise<string | null>
    >(),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = function (cb: (e: ServiceEvent) => void) {
      shared.listeners.add(cb);
      return () => shared.listeners.delete(cb);
    };
    this.start = function (_settings: unknown, sessionId: string) {
      shared.providerSessionId = sessionId;
      return Promise.resolve({ ok: true });
    };
    this.sendAudioChunk = function () {};
    this.stopGracefully = function () {
      return shared.drain ?? Promise.resolve();
    };
    this.stop = function () {};
    this.destroy = function () {};
    this.commitParagraphBoundary = function () {};
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.setSessionSignal = function () {};
    this.detectFileLinkTokens = shared.detect;
  },
}));

vi.mock("../../../services/VoiceFileLinkResolver.js", () => ({
  voiceFileLinkResolver: { resolve: shared.resolve },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => shared.currentProject),
    getCurrentProjectId: vi.fn(() => null),
    getProjectById: vi.fn((id: string) => {
      const path = shared.projectPaths.get(id);
      return path ? { id, name: id, path } : null;
    }),
  },
}));

vi.mock("../../../services/voiceContextKeyterms.js", () => ({
  assembleKeyterms: vi.fn(() => Promise.resolve([])),
  formatKeytermPrompt: vi.fn(() => ""),
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "voiceInput"
        ? {
            enabled: true,
            openaiApiKey: "sk-test",
            correctionEnabled: true,
            resolveFileLinks: true,
            paragraphingStrategy: "spoken-command",
            language: "en",
          }
        : undefined
    ),
    set: vi.fn(),
  },
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return {
    ...actual,
    getProjectForWebContents: vi.fn((id: number) => shared.projects.get(id) ?? null),
  };
});

import { registerVoiceInputHandlers } from "../voiceInput.js";
import { CHANNELS } from "../../channels.js";

type Sent = { channel: string; payload: unknown };
type FileReferencesPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string }>;
};

let nextSenderId = 500;
function makeSender() {
  const sender = {
    id: nextSenderId++,
    sent: [] as Sent[],
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn((channel: string, payload: unknown) => {
      sender.sent.push({ channel, payload });
    }),
  };
  return sender;
}
type FakeSender = ReturnType<typeof makeSender>;

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function start(sender: FakeSender, sessionId: string, terminalId?: string) {
  return getHandler(CHANNELS.VOICE_INPUT_START)(
    { sender },
    sessionId,
    terminalId ? { terminalId } : undefined
  );
}

function stop(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_STOP)({ sender }, sessionId);
}

function emitComplete(text: string, sessionId = shared.providerSessionId ?? undefined) {
  for (const listener of [...shared.listeners]) listener({ type: "complete", text, sessionId });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("voiceInput — spoken file references", () => {
  let appSent: Sent[];
  let cleanup: () => void;
  let owner: FakeSender;
  let ptyClient: {
    hasTerminal: ReturnType<typeof vi.fn>;
    getTerminalProjectId: ReturnType<typeof vi.fn>;
    getTerminalAsync: ReturnType<typeof vi.fn>;
  };

  const completes = () =>
    appSent
      .filter((m) => m.channel === CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE)
      .map((m) => m.payload as { text: string; transcriptId?: string });
  const fileReferences = () =>
    appSent
      .filter((m) => m.channel === CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED)
      .map((m) => m.payload as FileReferencesPayload);

  beforeEach(() => {
    vi.clearAllMocks();
    shared.listeners.clear();
    shared.providerSessionId = null;
    shared.drain = null;
    shared.projects.clear();
    shared.projectPaths.clear();
    shared.currentProject = { name: "current", path: "/repo/current" };
    shared.detect.mockReset();
    shared.resolve.mockReset();
    owner = makeSender();
    appSent = [];
    ptyClient = {
      hasTerminal: vi.fn(() => false),
      getTerminalProjectId: vi.fn(() => null),
      getTerminalAsync: vi.fn(async () => null),
    };
    const win = {
      webContents: {
        send: vi.fn((channel: string, payload: unknown) => appSent.push({ channel, payload })),
      },
      isDestroyed: vi.fn(() => false),
    };
    cleanup = registerVoiceInputHandlers({
      mainWindow: win as unknown as Electron.BrowserWindow,
      ptyClient,
    } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
  });

  it("resolves a reference in the final utterance before its stop returns", async () => {
    await start(owner, "a");
    const drain = deferred<void>();
    shared.drain = drain.promise;
    const detection = deferred<Detected>();
    shared.detect.mockReturnValueOnce(detection.promise);
    shared.resolve.mockResolvedValueOnce("src/InputBar.tsx");

    let referencesAtStop: number | null = null;
    const stopping = stop(owner, "a").then(() => {
      referencesAtStop = fileReferences().length;
    });
    // The drain finishes the final utterance after the stop began.
    emitComplete("Fix the padding. Link to the input bar component.");
    drain.resolve();
    await vi.waitFor(() => expect(shared.detect).toHaveBeenCalledOnce());
    expect(referencesAtStop).toBeNull();

    detection.resolve([{ description: "input bar component" }]);
    await stopping;

    const [complete] = completes();
    expect(complete!.transcriptId).toEqual(expect.any(String));
    expect(referencesAtStop).toBe(1);
    expect(fileReferences()).toEqual([
      {
        sessionId: "a",
        transcriptId: complete!.transcriptId,
        references: [{ description: "input bar component", path: "src/InputBar.tsx" }],
      },
    ]);
    expect(owner.sent.map((m) => m.payload)).toContainEqual({ sessionId: "a", reason: "stopped" });
  });

  it("sends nothing for a reference that didn't resolve", async () => {
    await start(owner, "a");
    shared.detect.mockResolvedValueOnce([{ description: "the old API" }]);
    shared.resolve.mockResolvedValueOnce(null);

    emitComplete("Link to the old API.");
    await stop(owner, "a");

    expect(shared.resolve).toHaveBeenCalledOnce();
    expect(fileReferences()).toEqual([]);
  });

  it.each([
    "open a PR",
    "that is open source",
    "keep the file open",
    "at least one test file",
    "at the top of the file",
    "open the settings dialog",
  ])("never tags or detects ordinary speech: %s", async (text) => {
    await start(owner, "a");

    emitComplete(text);
    await stop(owner, "a");

    expect(completes()).toEqual([expect.not.objectContaining({ transcriptId: expect.anything() })]);
    expect(shared.detect).not.toHaveBeenCalled();
  });

  it("drops a description the transcript doesn't contain", async () => {
    await start(owner, "a");
    shared.detect.mockResolvedValueOnce([{ description: "auth service" }]);

    emitComplete("Link to the router.");
    await stop(owner, "a");

    expect(shared.resolve).not.toHaveBeenCalled();
    expect(fileReferences()).toEqual([]);
  });

  it("searches the dictated terminal's worktree", async () => {
    shared.projects.set(owner.id, "project-a");
    shared.projectPaths.set("project-a", "/repo/a");
    ptyClient.hasTerminal.mockReturnValue(true);
    ptyClient.getTerminalProjectId.mockReturnValue("project-a");
    ptyClient.getTerminalAsync.mockResolvedValue({
      id: "term-1",
      worktreeId: "/repo/a-worktrees/feature",
      cwd: "/repo/a-worktrees/feature/packages/app",
    });
    await start(owner, "a", "term-1");
    shared.detect.mockResolvedValueOnce([{ description: "router" }]);
    shared.resolve.mockResolvedValueOnce("src/router.ts");

    emitComplete("Link to the router.");
    await stop(owner, "a");

    expect(ptyClient.getTerminalAsync).toHaveBeenCalledWith("term-1");
    expect(shared.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo/a-worktrees/feature", description: "router" })
    );
    expect(fileReferences()).toHaveLength(1);
  });

  it("falls back to the owning project, not the current one, for a terminal another project owns", async () => {
    shared.projects.set(owner.id, "project-a");
    shared.projectPaths.set("project-a", "/repo/a");
    ptyClient.hasTerminal.mockReturnValue(true);
    ptyClient.getTerminalProjectId.mockReturnValue("project-b");
    await start(owner, "a", "term-1");
    shared.detect.mockResolvedValueOnce([{ description: "router" }]);
    shared.resolve.mockResolvedValueOnce("src/router.ts");

    emitComplete("Link to the router.");
    await stop(owner, "a");

    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalled();
    expect(shared.resolve).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/a" }));
  });

  it("resolves nothing when the owning project is gone", async () => {
    shared.projects.set(owner.id, "project-gone");
    await start(owner, "a");
    shared.detect.mockResolvedValueOnce([{ description: "router" }]);

    emitComplete("Link to the router.");
    await stop(owner, "a");

    expect(shared.resolve).not.toHaveBeenCalled();
    expect(fileReferences()).toEqual([]);
  });

  it("keeps references in spoken order when they resolve out of order", async () => {
    await start(owner, "a");
    shared.detect.mockResolvedValueOnce([{ description: "router" }, { description: "store" }]);
    const router = deferred<string | null>();
    shared.resolve.mockReturnValueOnce(router.promise).mockResolvedValueOnce("src/store.ts");

    emitComplete("Link to the router and link to the store.");
    const stopping = stop(owner, "a");
    await vi.waitFor(() => expect(shared.resolve).toHaveBeenCalledTimes(2));
    router.resolve("src/router.ts");
    await stopping;

    expect(fileReferences()[0]!.references).toEqual([
      { description: "router", path: "src/router.ts" },
      { description: "store", path: "src/store.ts" },
    ]);
  });

  it("stops waiting on a reference once its job deadline passes", async () => {
    vi.useFakeTimers();
    await start(owner, "a");
    // Neither call honours the abort, as a slow local search wouldn't.
    shared.detect.mockReturnValueOnce(new Promise<Detected>(() => {}));

    emitComplete("Link to the router.");
    let stopped = false;
    const stopping = stop(owner, "a").then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_900);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await stopping;

    expect(stopped).toBe(true);
    expect(shared.detect.mock.calls[0]![2]!.aborted).toBe(true);
    expect(fileReferences()).toEqual([]);
  });

  it("abandons an older session's references when a newer start supersedes it", async () => {
    const other = makeSender();
    await start(owner, "a");
    const detection = deferred<Detected>();
    shared.detect.mockReturnValueOnce(detection.promise);
    shared.resolve.mockResolvedValue("src/router.ts");

    emitComplete("Link to the router.");
    await vi.waitFor(() => expect(shared.detect).toHaveBeenCalledOnce());
    await start(other, "b");
    expect(shared.detect.mock.calls[0]![2]!.aborted).toBe(true);
    detection.resolve([{ description: "router" }]);
    await new Promise((r) => setTimeout(r, 0));

    expect(fileReferences()).toEqual([]);
  });
});
