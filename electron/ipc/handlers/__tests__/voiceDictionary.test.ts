import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceDictionaryState, VoiceInputSettings } from "../../../../shared/types/ipc/api.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  systemPreferences: { getMediaAccessStatus: vi.fn(), askForMediaAccess: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getCurrentProject: vi.fn(() => null), getCurrentProjectId: vi.fn(() => null) },
}));

// An in-memory electron-store: dot-path get/set, and a fresh copy per read like conf.
const disk = vi.hoisted(() => {
  const state = { data: {} as Record<string, unknown> };
  const walk = (path: string) => path.split(".");
  return {
    state,
    get(path: string): unknown {
      let node: unknown = state.data;
      for (const part of walk(path)) {
        if (!node || typeof node !== "object") return undefined;
        node = (node as Record<string, unknown>)[part];
      }
      return node === undefined ? undefined : structuredClone(node);
    },
    set(path: string, value: unknown): void {
      const parts = walk(path);
      let node = state.data;
      for (const part of parts.slice(0, -1)) {
        if (!node[part] || typeof node[part] !== "object") node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
      node[parts.at(-1)!] = structuredClone(value);
    },
  };
});

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((path: string) => disk.get(path)),
    set: vi.fn((path: string, value: unknown) => disk.set(path, value)),
  },
}));

import { store } from "../../../store.js";
import { registerVoiceDictionaryHandlers } from "../voiceDictionary.js";
import { VOICE_DICTIONARY_METHOD_CHANNELS } from "../voiceDictionary.preload.js";
import { registerVoiceInputHandlers } from "../voiceInput.js";

const sender = {
  sender: { id: 1, once: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false },
};

function handler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** Call a channel and unwrap the `{ ok, data }` envelope; a refusal throws. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await handler(channel)(sender, ...args)) as {
    ok?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (result && typeof result === "object" && "ok" in result) {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.data as T;
  }
  return result as T;
}

const op = (method: keyof typeof VOICE_DICTIONARY_METHOD_CHANNELS, payload: unknown) =>
  call<VoiceDictionaryState>(VOICE_DICTIONARY_METHOD_CHANNELS[method], payload);
const stored = () => disk.state.data.voiceInput as Record<string, unknown>;
const storedTerms = () =>
  (stored().dictionary as { term: string }[] | undefined)?.map((entry) => entry.term);

const NOW = 1_760_000_000_000;

describe("voiceDictionary operations", () => {
  let cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    disk.state.data = { voiceInput: { enabled: true, dictionary: [], suggestedDictionary: [] } };
    cleanups = [
      registerVoiceDictionaryHandlers(),
      registerVoiceInputHandlers({
        mainWindow: { webContents: { send: vi.fn() }, isDestroyed: () => false },
      } as unknown as Parameters<typeof registerVoiceInputHandlers>[0]),
    ];
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    vi.useRealTimers();
  });

  it("adds a trimmed term once, ignoring case, and returns what main now holds", async () => {
    const first = await op("add", { term: "  Daintree " });
    expect(first.dictionary).toEqual([
      { term: "Daintree", heardAs: [], source: "manual", addedAt: NOW },
    ]);
    expect(storedTerms()).toEqual(["Daintree"]);

    vi.mocked(store.set).mockClear();
    const again = await op("add", { term: "daintree" });
    expect(again.dictionary).toEqual(first.dictionary);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses an over-length term and writes nothing", async () => {
    await expect(op("add", { term: "x".repeat(101) })).rejects.toThrow();
    expect(storedTerms()).toEqual([]);
  });

  it("removes and updates single entries without touching the rest", async () => {
    await op("add", { term: "Daintree" });
    await op("add", { term: "zustand" });
    await op("add", { term: "Vite" });

    await op("update", { term: "ZUSTAND", changes: { term: "Zustand", heardAs: ["zoo stand"] } });
    const after = await op("remove", { term: "vite" });

    expect(after.dictionary.map(({ term, heardAs }) => ({ term, heardAs }))).toEqual([
      { term: "Daintree", heardAs: [] },
      { term: "Zustand", heardAs: ["zoo stand"] },
    ]);
    expect(storedTerms()).toEqual(["Daintree", "Zustand"]);
  });

  it("accepting a suggestion keeps a word learned after the page loaded", async () => {
    disk.state.data.voiceInput = {
      ...stored(),
      suggestedDictionary: [
        { word: "Zustand", utterance: "zoo stand", suggestedAt: 1, frequency: 1 },
      ],
    };
    // The settings page reads the queue, then a send learns another word.
    await call<VoiceInputSettings>("voice-input:get-settings");
    await op("recordSuggestions", { candidates: [{ word: "Tailwind", original: "tail wind" }] });

    const after = await op("acceptSuggestion", { word: "Zustand" });

    expect(after.suggestedDictionary.map((s) => s.word)).toEqual(["Tailwind"]);
    expect(after.dictionary).toEqual([
      { term: "Zustand", heardAs: ["zoo stand"], source: "learned", addedAt: NOW },
    ]);
    expect(stored().suggestedDictionary).toEqual(after.suggestedDictionary);
  });

  it("dismissing drops only that suggestion", async () => {
    await op("recordSuggestions", {
      candidates: [
        { word: "Zustand", original: "zoo stand" },
        { word: "Tailwind", original: "tail wind" },
      ],
    });
    const after = await op("dismissSuggestion", { word: "zustand" });
    expect(after.suggestedDictionary.map((s) => s.word)).toEqual(["Tailwind"]);
  });

  it("learns nothing while learning from corrections is off, or for a word already added", async () => {
    await op("add", { term: "Daintree" });
    const known = await op("recordSuggestions", {
      candidates: [{ word: "daintree", original: "dane tree" }],
    });
    expect(known.suggestedDictionary).toEqual([]);

    disk.state.data.voiceInput = { ...stored(), learnFromCorrections: false };
    const off = await op("recordSuggestions", {
      candidates: [{ word: "Zustand", original: "zoo stand" }],
    });
    expect(off.suggestedDictionary).toEqual([]);
    expect(stored().suggestedDictionary).toEqual([]);
  });

  it("setSettings can't overwrite the dictionary or its queue", async () => {
    await op("add", { term: "Daintree" });
    await call("voice-input:set-settings", {
      language: "es",
      dictionary: [],
      suggestedDictionary: [{ word: "Bogus", utterance: "", suggestedAt: 0, frequency: 9 }],
      customDictionary: ["Bogus"],
    });

    expect(stored().language).toBe("es");
    expect(storedTerms()).toEqual(["Daintree"]);
    expect(stored().suggestedDictionary).toEqual([]);
    expect("customDictionary" in stored()).toBe(false);
  });

  it("folds an old word list that reappears on a migrated store into entries", async () => {
    disk.state.data.voiceInput = {
      ...stored(),
      dictionary: [{ term: "Daintree", heardAs: [], source: "manual", addedAt: 5 }],
      customDictionary: ["daintree", "Zustand"],
    };

    const settings = await call<VoiceInputSettings>("voice-input:get-settings");

    expect(settings.dictionary).toEqual([
      { term: "Daintree", heardAs: [], source: "manual", addedAt: 5 },
      { term: "Zustand", heardAs: [], source: "manual", addedAt: NOW },
    ]);
    expect(settings).not.toHaveProperty("customDictionary");
    expect(storedTerms()).toEqual(["Daintree", "Zustand"]);
    expect("customDictionary" in stored()).toBe(false);
  });

  it("setSettings ignores dotted keys that would reach inside main-owned fields", async () => {
    await op("add", { term: "Daintree" });
    await call("voice-input:set-settings", {
      "dictionary.0.term": "daintree",
      "dictionary.1": { term: "Bogus", heardAs: [], source: "manual", addedAt: 0 },
      "suggestedDictionary.0": { word: "Bogus", utterance: "", suggestedAt: 0, frequency: 1 },
      keyterms: ["Bogus"],
      recordingMode: "push-to-talk",
    });

    expect(stored().recordingMode).toBe("push-to-talk");
    expect(storedTerms()).toEqual(["Daintree"]);
    expect(stored().suggestedDictionary).toEqual([]);
    expect("keyterms" in stored()).toBe(false);
  });

  it("writes a repaired dictionary back once, so it reads the same every time", async () => {
    disk.state.data.voiceInput = {
      ...stored(),
      dictionary: [{ term: "Vite" }, { term: "vite", heardAs: ["veet"] }],
      suggestedDictionary: [{ word: "Bun" }],
    };

    const first = await call<VoiceInputSettings>("voice-input:get-settings");
    vi.setSystemTime(NOW + 60_000);
    const second = await call<VoiceInputSettings>("voice-input:get-settings");

    expect(first.dictionary).toEqual([
      { term: "Vite", heardAs: ["veet"], source: "manual", addedAt: NOW },
    ]);
    expect(second.dictionary).toEqual(first.dictionary);
    expect(stored().dictionary).toEqual(first.dictionary);
    expect(stored().suggestedDictionary).toEqual([
      { word: "Bun", utterance: "", suggestedAt: 0, frequency: 1 },
    ]);

    vi.mocked(store.set).mockClear();
    await call("voice-input:get-settings");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("commits an accept in one write", async () => {
    disk.state.data.voiceInput = {
      ...stored(),
      suggestedDictionary: [
        { word: "Zustand", utterance: "zoo stand", suggestedAt: 1, frequency: 1 },
      ],
    };
    vi.mocked(store.set).mockClear();

    await op("acceptSuggestion", { word: "Zustand" });

    expect(store.set).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.set).mock.calls[0]![0]).toBe("voiceInput");
    expect(storedTerms()).toEqual(["Zustand"]);
    expect(stored().suggestedDictionary).toEqual([]);
  });

  it("a stale accept of a word no longer queued doesn't bring back a removed term", async () => {
    disk.state.data.voiceInput = {
      ...stored(),
      suggestedDictionary: [
        { word: "Zustand", utterance: "zoo stand", suggestedAt: 1, frequency: 1 },
      ],
    };
    await op("acceptSuggestion", { word: "Zustand" });
    await op("remove", { term: "Zustand" });

    const stale = await op("acceptSuggestion", { word: "Zustand" });

    expect(stale.dictionary).toEqual([]);
    expect(storedTerms()).toEqual([]);
  });

  it("refuses a rename onto another term and writes nothing", async () => {
    await op("add", { term: "Daintree" });
    await op("add", { term: "Zustand" });
    vi.mocked(store.set).mockClear();

    await expect(
      op("update", { term: "Zustand", changes: { term: "daintree" } })
    ).rejects.toThrow();
    expect(store.set).not.toHaveBeenCalled();
    expect(storedTerms()).toEqual(["Daintree", "Zustand"]);
  });

  it("can still remove a term kept from the old list that is longer than any new term", async () => {
    const long = "z".repeat(1_500);
    disk.state.data.voiceInput = {
      ...stored(),
      dictionary: [{ term: long, heardAs: [], source: "manual", addedAt: 1 }],
    };

    const after = await op("remove", { term: long });

    expect(after.dictionary).toEqual([]);
    expect(storedTerms()).toEqual([]);
  });

  it("keeps env-var key overrides out of the stored settings when it writes", async () => {
    process.env.WHISPER_API_KEY = "sk-from-env";
    try {
      await op("add", { term: "Daintree" });
      expect(stored().openaiApiKey).toBeUndefined();
    } finally {
      delete process.env.WHISPER_API_KEY;
    }
  });
});
