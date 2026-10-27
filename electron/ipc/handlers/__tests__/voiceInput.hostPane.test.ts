// A pane in a view of a host's project lives on the host, so its dictation
// context is read there (#14782): the Shell asks through the remote service
// and reads nothing about the pane itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const shared = vi.hoisted(() => ({
  provider: "deepgram" as "openai" | "deepgram",
  startCalls: [] as Array<{ keyterms?: string[] }>,
  providerSessionId: null as string | null,
  listeners: [] as Array<(event: Record<string, unknown>) => void>,
  correctCalls: [] as Array<{
    request: Record<string, unknown>;
    settings: Record<string, unknown>;
  }>,
  rewriteCalls: [] as Array<Record<string, unknown>>,
  warmCalls: [] as Array<Record<string, unknown>>,
  detected: [] as Array<{ description: string }>,
  projects: new Map<number, string>(),
}));

vi.mock("../../../services/VoiceTranscriptionService.js", () => ({
  VoiceTranscriptionService: function VoiceTranscriptionService(this: Record<string, unknown>) {
    this.onEvent = (cb: (event: Record<string, unknown>) => void) => {
      shared.listeners.push(cb);
      return () => {
        shared.listeners = shared.listeners.filter((listener) => listener !== cb);
      };
    };
    this.keytermsNeededToConnect = (settings: { transcriptionProvider?: string }) =>
      settings.transcriptionProvider === "deepgram";
    this.start = (settings: { keyterms?: string[] }, sessionId: string) => {
      shared.providerSessionId = sessionId;
      shared.startCalls.push(settings);
      return Promise.resolve({ ok: true });
    };
    this.sendAudioChunk = () => {};
    this.stopGracefully = () => Promise.resolve();
    this.stop = () => {};
    this.destroy = () => {};
    this.commitParagraphBoundary = () => {};
    this.getSessionStats = () => null;
  },
}));

vi.mock("../../../services/VoiceCorrectionService.js", () => ({
  VoiceCorrectionService: function VoiceCorrectionService(this: Record<string, unknown>) {
    this.setSessionSignal = () => {};
    this.correct = (request: Record<string, unknown>, settings: Record<string, unknown>) => {
      shared.correctCalls.push({ request, settings });
      return Promise.resolve({ action: "no_change", confirmedText: request.rawText });
    };
    this.rewrite = (_request: unknown, settings: Record<string, unknown>) => {
      shared.rewriteCalls.push(settings);
      return Promise.resolve({ status: "rewritten", text: "done" });
    };
    this.detectFileLinkTokens = () => Promise.resolve(shared.detected);
    this.warm = (settings: Record<string, unknown>) => {
      shared.warmCalls.push(settings);
      return Promise.resolve();
    };
    this.preconnect = () => {};
  },
}));

// A host's project ids mean nothing here; every read below would be the
// wrong machine's.
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: vi.fn(() => null),
    getProjectSummaries: vi.fn(() => []),
  },
}));

vi.mock("../../../services/FileSearchService.js", () => ({
  fileSearchService: {
    searchNaturalLanguage: vi.fn(() => {
      throw new Error("searched this machine's files for a host's pane");
    }),
  },
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "voiceInput"
        ? {
            enabled: true,
            openaiApiKey: "sk-test",
            correctionEnabled: true,
            correctionModel: "gpt-6-luna",
            dictionary: [{ term: "Wispr", heardAs: [], source: "manual", addedAt: 1 }],
            correctionCustomInstructions: "",
            language: "en",
            paragraphingStrategy: "spoken-command",
            resolveFileLinks: true,
            transcriptionProvider: shared.provider,
            deepgramApiKey: "dg-test",
          }
        : undefined
    ),
    set: vi.fn(),
  },
}));

vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: vi.fn((id: number) => shared.projects.get(id) ?? null),
  getAllAppWebContents: vi.fn(() => []),
}));

import { registerVoiceInputHandlers } from "../voiceInput.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import { CHANNELS } from "../../channels.js";
import { registerRemoteService } from "../../../remote/runtime.js";
import type { HostPaneContextReader } from "../../../services/voice/hostPaneContext.js";
import type {
  PaneCorrectionContext,
  PaneStartContext,
} from "../../../services/voice/paneContext.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { getBuiltinSlashCommands } from "../../../../shared/types/slashCommands.js";
import {
  buildVoiceCommandVocabulary,
  voiceCommandKeyterms,
} from "../../../../shared/utils/voiceAgentCommands.js";
import { toHostScopedKey } from "../../../../shared/types/remoteHosts.js";

const HOST = "studio-03";
const PROJECT = "proj-1";
const TERMINAL = "term-1";

const COMMAND_TARGET = {
  agentId: "claude" as const,
  agentName: "Claude",
  isAssistant: false,
  vocabulary: buildVoiceCommandVocabulary(
    getBuiltinSlashCommands("claude"),
    getAgentConfig("claude")!.completionSources!
  ),
};

const START: PaneStartContext = {
  projectName: "Daintree",
  vocabulary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
  names: { hosts: [], projects: [], worktrees: ["feature-voice-hosts"] },
  keyterms: {
    repoNames: ["@daintree/plugin-kit"],
    branchName: "feature/dictation-remote",
    terminalTerms: ["hostPaneOf"],
  },
  commandTarget: COMMAND_TARGET,
};

const CORRECTION: PaneCorrectionContext = {
  project: { name: "Daintree", path: "/home/greg/daintree" },
  vocabulary: START.vocabulary,
  commandTarget: COMMAND_TARGET,
  terminalOutput: "$ npm test\n✓ hostPaneOf reads the view key",
};

type Sent = { channel: string; payload: unknown };
let nextSenderId = 900;
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

let nextSession = 1;
function start(
  sender: FakeSender,
  terminalId: string | undefined = TERMINAL,
  sessionId = `session-${nextSession++}`
) {
  return getHandler(CHANNELS.VOICE_INPUT_START)(
    { sender },
    sessionId,
    terminalId ? { terminalId } : undefined
  );
}

function stop(sender: FakeSender, sessionId: string) {
  return getHandler(CHANNELS.VOICE_INPUT_STOP)({ sender }, sessionId);
}

function emitComplete(text: string) {
  const event = { type: "complete", text, sessionId: shared.providerSessionId, endOfSpeech: true };
  for (const listener of [...shared.listeners]) listener(event);
}

function completions(sender: FakeSender) {
  return sender.sent
    .filter((m) => m.channel === CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE)
    .map((m) => m.payload as { text: string; commandText?: string });
}

function throwingLocalReads() {
  const refuse = (name: string) =>
    vi.fn((..._args: unknown[]): unknown => {
      throw new Error(`read this machine's ${name} for a host's pane`);
    });
  return {
    ptyClient: {
      hasTerminal: refuse("terminals"),
      getTerminalProjectId: refuse("terminal owners"),
      getTerminalAsync: refuse("terminal records"),
      getTerminalSnapshot: refuse("terminal output"),
    },
    worktreeService: { getAllStatesForProjectAsync: refuse("worktrees") },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("voiceInput — dictating into a host's pane", () => {
  function expectNoLocalReads() {
    for (const read of Object.values(local.ptyClient)) expect(read).not.toHaveBeenCalled();
    expect(local.worktreeService.getAllStatesForProjectAsync).not.toHaveBeenCalled();
    expect(projectStore.getProjectById).not.toHaveBeenCalled();
    expect(fileSearchService.searchNaturalLanguage).not.toHaveBeenCalled();
  }

  let cleanup: () => void;
  let unregister: () => void;
  let reader: { [K in keyof HostPaneContextReader]: ReturnType<typeof vi.fn> };
  let local: ReturnType<typeof throwingLocalReads>;
  let view: FakeSender;

  beforeEach(() => {
    vi.clearAllMocks();
    shared.provider = "deepgram";
    shared.startCalls = [];
    shared.providerSessionId = null;
    shared.listeners = [];
    shared.correctCalls = [];
    shared.rewriteCalls = [];
    shared.warmCalls = [];
    shared.detected = [];
    shared.projects.clear();
    view = makeSender();
    shared.projects.set(view.id, toHostScopedKey(HOST, PROJECT));
    reader = {
      readStart: vi.fn(async () => START),
      readCorrection: vi.fn(async () => CORRECTION),
      findFileCandidates: vi.fn(async () => [["electron/ipc/handlers/voiceInputHandler.ts"]]),
      readProject: vi.fn(async () => CORRECTION.project),
    };
    unregister = registerRemoteService(
      "voicePaneHosts",
      reader as unknown as HostPaneContextReader
    );
    local = throwingLocalReads();
    cleanup = registerVoiceInputHandlers(
      local as unknown as Parameters<typeof registerVoiceInputHandlers>[0]
    );
  });

  afterEach(() => {
    cleanup();
    unregister();
    vi.useRealTimers();
  });

  it("biases the transcription with the pane's context, read from its host", async () => {
    await expect(start(view)).resolves.toEqual({ status: "started" });

    expect(reader.readStart).toHaveBeenCalledWith(
      HOST,
      { projectId: PROJECT, terminalId: TERMINAL },
      expect.objectContaining({ timeoutMs: 500 })
    );
    const keyterms = shared.startCalls[0]?.keyterms ?? [];
    // The host's vocabulary, project, repository, worktree, command, branch
    // and terminal tiers, beside this machine's own dictionary.
    for (const term of [
      "Zustand",
      "Wispr",
      "Daintree",
      "plugin",
      "feature-voice-hosts",
      ...voiceCommandKeyterms(COMMAND_TARGET.vocabulary, 1),
      "dictation",
      "remote",
      "hostPaneOf",
    ]) {
      expect(keyterms).toContain(term);
    }
    expectNoLocalReads();
  });

  it("writes a spoken command as the host's agent takes it", async () => {
    await start(view);
    emitComplete("Slash review the last commit.");
    expect(completions(view)).toEqual([
      expect.objectContaining({ commandText: "/review the last commit." }),
    ]);
  });

  it("cleans up with the pane's project, vocabulary, commands and output from the host", async () => {
    await start(view);
    const result = await getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
      { sender: view },
      { rawText: "fix the zoo stand store", terminalId: TERMINAL }
    );
    expect(result).toMatchObject({ action: "no_change" });
    expect(reader.readCorrection).toHaveBeenCalledWith(
      HOST,
      { projectId: PROJECT, terminalId: TERMINAL },
      expect.objectContaining({ timeoutMs: 1500 })
    );
    const [{ request, settings }] = shared.correctCalls;
    expect(request.terminalOutput).toBe(CORRECTION.terminalOutput);
    expect(settings).toMatchObject({
      projectName: "Daintree",
      projectPath: "/home/greg/daintree",
      commandTarget: COMMAND_TARGET,
      knownNames: ["feature-voice-hosts"],
    });
    expect(settings.customDictionary).toEqual(expect.arrayContaining(["Zustand", "Wispr"]));
    expectNoLocalReads();
  });

  it("cleans up a stopped dictation with what its host gave at the start and the stop", async () => {
    await start(view, TERMINAL, "prepared");
    await stop(view, "prepared");
    const result = await getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
      { sender: view },
      { rawText: "fix the zoo stand store", terminalId: TERMINAL, sessionId: "prepared" }
    );
    expect(result).toMatchObject({ action: "no_change" });
    expect(reader.readProject).toHaveBeenCalledWith(HOST, PROJECT, expect.anything());
    // Read once, as the stop landed, and not again for the passage.
    expect(reader.readCorrection).toHaveBeenCalledTimes(1);
    expect(reader.readCorrection).toHaveBeenCalledWith(
      HOST,
      { projectId: PROJECT, terminalId: TERMINAL },
      expect.objectContaining({ timeoutMs: 1500 })
    );
    const [{ request, settings }] = shared.correctCalls;
    expect(request.terminalOutput).toBe(CORRECTION.terminalOutput);
    expect(settings).toMatchObject({
      projectName: "Daintree",
      projectPath: "/home/greg/daintree",
      commandTarget: COMMAND_TARGET,
      knownNames: ["feature-voice-hosts"],
    });
    expect(settings.customDictionary).toEqual(expect.arrayContaining(["Zustand", "Wispr"]));
    // The prompt warmed while it ran is the one the passage sends.
    expect(shared.warmCalls[0]).toEqual(settings);
    expectNoLocalReads();
  });

  it("drops a prepared dictation's commands once the host's agent has gone by the stop", async () => {
    reader.readCorrection.mockResolvedValueOnce({ ...CORRECTION, commandTarget: null });
    await start(view, TERMINAL, "agent-gone");
    await stop(view, "agent-gone");
    await getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
      { sender: view },
      { rawText: "compact it", terminalId: TERMINAL, sessionId: "agent-gone" }
    );
    expect(shared.correctCalls[0]?.settings.commandTarget).toBeUndefined();
    expectNoLocalReads();
  });

  it("keeps a prepared dictation's start commands when the host doesn't answer at the stop", async () => {
    reader.readCorrection.mockResolvedValueOnce(null);
    await start(view, TERMINAL, "stop-unanswered");
    await stop(view, "stop-unanswered");
    await getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
      { sender: view },
      { rawText: "compact it", terminalId: TERMINAL, sessionId: "stop-unanswered" }
    );
    const [{ request, settings }] = shared.correctCalls;
    expect(settings.commandTarget).toEqual(COMMAND_TARGET);
    expect(request.terminalOutput).toBeUndefined();
    expectNoLocalReads();
  });

  it("resolves a spoken reference among the host's files, chosen here", async () => {
    shared.provider = "openai";
    shared.detected = [{ description: "voice input handler" }];
    await start(view);
    emitComplete("Look at the link to file voice input handler.");
    await vi.waitFor(() =>
      expect(
        view.sent.find((m) => m.channel === CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED)?.payload
      ).toMatchObject({
        references: [
          {
            description: "voice input handler",
            path: "electron/ipc/handlers/voiceInputHandler.ts",
          },
        ],
      })
    );
    expect(reader.findFileCandidates).toHaveBeenCalledWith(
      HOST,
      { projectId: PROJECT, terminalId: TERMINAL },
      ["voice input handler"],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expectNoLocalReads();
  });

  it("names the host's project to a spoken rewrite", async () => {
    await getHandler(CHANNELS.VOICE_INPUT_REWRITE)(
      { sender: view },
      { selectedText: "old words", instruction: "make it shorter" }
    );
    expect(reader.readProject).toHaveBeenCalledWith(HOST, PROJECT, expect.anything());
    expect(shared.rewriteCalls[0]).toMatchObject({
      projectName: "Daintree",
      projectPath: "/home/greg/daintree",
    });
    expectNoLocalReads();
  });

  it("starts without the pane's context when reading the host throws outright", async () => {
    reader.readStart.mockImplementationOnce(() => {
      throw new Error("reader broke");
    });
    await expect(start(view)).resolves.toEqual({ status: "started" });
    expect(shared.startCalls[0]?.keyterms).toEqual(["Wispr"]);
  });

  it("starts on time without the pane's context when the host doesn't answer", async () => {
    const late = deferred<PaneStartContext | null>();
    reader.readStart.mockReturnValueOnce(late.promise);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = start(view);
    // The wait starts once the host is asked, after the service has loaded.
    while (reader.readStart.mock.calls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(shared.startCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started).resolves.toEqual({ status: "started" });
    expect(shared.startCalls[0]?.keyterms).toEqual(["Wispr"]);

    // An answer after the wait changes nothing about the session.
    late.resolve(START);
    await vi.advanceTimersByTimeAsync(0);
    emitComplete("Slash review the last commit.");
    expect(completions(view)[0]?.commandText).toBeUndefined();
  });

  it("cleans up within its budget without the pane's context when the host doesn't answer", async () => {
    reader.readCorrection.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const corrected = getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
      { sender: view },
      { rawText: "fix the store", terminalId: TERMINAL }
    );
    await vi.advanceTimersByTimeAsync(1500);
    await expect(corrected).resolves.toMatchObject({ action: "no_change" });
    const [{ request, settings }] = shared.correctCalls;
    expect(request.terminalOutput).toBeUndefined();
    expect(settings.commandTarget).toBeUndefined();
    expect(settings.projectName).toBeUndefined();
  });

  it("asks the view's host nothing for a dictation outside the view, read ahead or not", async () => {
    await expect(
      getHandler(CHANNELS.VOICE_INPUT_START)({ sender: view }, "outside", { outsideView: true })
    ).resolves.toEqual({ status: "started" });
    await stop(view, "outside");

    for (const sessionId of ["outside", undefined]) {
      shared.correctCalls = [];
      await getHandler(CHANNELS.VOICE_INPUT_CORRECT)(
        { sender: view },
        { rawText: "fix it", outsideView: true, ...(sessionId ? { sessionId } : {}) }
      );
      const [{ request, settings }] = shared.correctCalls;
      expect(request.terminalOutput).toBeUndefined();
      expect(settings.customDictionary).toEqual(["Wispr"]);
      expect(settings.knownNames).toEqual([]);
      expect(settings.projectName).toBeUndefined();
      expect(settings.projectPath).toBeUndefined();
      expect(settings.commandTarget).toBeUndefined();
      if (sessionId) expect(shared.warmCalls[0]).toEqual(settings);
    }
    expect(shared.startCalls[0]?.keyterms).toEqual(["Wispr"]);
    expect(reader.readStart).not.toHaveBeenCalled();
    expect(reader.readCorrection).not.toHaveBeenCalled();
    expect(reader.readProject).not.toHaveBeenCalled();
    expectNoLocalReads();
  });

  it("never asks a host about a pane on this machine", async () => {
    const localView = makeSender();
    shared.projects.set(localView.id, "local-project");
    local.ptyClient.hasTerminal.mockReturnValue(false);
    await start(localView);
    expect(reader.readStart).not.toHaveBeenCalled();
  });
});
