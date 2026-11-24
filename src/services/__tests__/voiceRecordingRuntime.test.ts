// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings, VoiceLiveSessionUpdate } from "@shared/types";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";

type StoredSettings = Pick<
  VoiceInputSettings,
  "enabled" | "transcriptionProvider" | "openaiApiKey"
>;

// Stands in for the recording service: counts how often its module is
// evaluated, can hold its import back or fail it, and records what it is
// initialized with.
const fake = vi.hoisted(() => ({
  imports: 0,
  failNextImport: false,
  importGate: null as Promise<void> | null,
  initialize: vi.fn(),
  refreshConfiguration: vi.fn(async () => true),
  recordsPresses: false,
}));
function mockRecordingService() {
  // Registered afresh for each test's module graph, so every import counts.
  vi.doMock("../VoiceRecordingService", async () => {
    fake.imports++;
    if (fake.importGate) await fake.importGate;
    if (fake.failNextImport) {
      fake.failNextImport = false;
      throw new Error("chunk failed to load");
    }
    return {
      voiceRecordingService: {
        initialize: fake.initialize,
        refreshConfiguration: fake.refreshConfiguration,
        recordsShortcutPresses: () => fake.recordsPresses,
      },
    };
  });
}

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombos: (actionId: string) => (actionId === "voiceInput.toggle" ? ["Cmd+."] : []),
    matchesEvent: (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period",
  },
}));

const ON: StoredSettings = { enabled: true, transcriptionProvider: "openai", openaiApiKey: "sk" };
const OFF: StoredSettings = { ...ON, enabled: false };

function stubVoiceInput(initial: StoredSettings) {
  const stored = { settings: initial };
  let liveSession: ((update: VoiceLiveSessionUpdate) => void) | null = null;
  const unsubscribeLive = vi.fn();
  const voiceInput = {
    getSettings: vi.fn(async () => stored.settings),
    onLiveSession: vi.fn((callback: (update: VoiceLiveSessionUpdate) => void) => {
      liveSession = callback;
      return unsubscribeLive;
    }),
  };
  vi.stubGlobal("electron", { voiceInput });
  return {
    stored,
    voiceInput,
    unsubscribeLive,
    reportLiveSession: (update: VoiceLiveSessionUpdate) => liveSession?.(update),
  };
}

const teardowns: Array<() => void> = [];

async function loadRuntime() {
  const runtime = await import("../voiceRecordingRuntime");
  return {
    ...runtime,
    startVoiceRecordingRuntime: () => {
      const stop = runtime.startVoiceRecordingRuntime();
      teardowns.push(stop);
      return stop;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const changeSettingsHere = () =>
  window.dispatchEvent(new Event(VOICE_INPUT_SETTINGS_CHANGED_EVENT));

function keydown(init: KeyboardEventInit, timeStamp = 42): KeyboardEvent {
  return Object.defineProperty(new KeyboardEvent("keydown", init), "timeStamp", {
    value: timeStamp,
  });
}
const release = (code: string) => window.dispatchEvent(new KeyboardEvent("keyup", { code }));

const PRESS: KeyboardEventInit = { code: "Period", key: ".", metaKey: true };

beforeEach(() => {
  vi.resetModules();
  mockRecordingService();
  fake.imports = 0;
  fake.failNextImport = false;
  fake.importGate = null;
  fake.initialize.mockClear();
  fake.refreshConfiguration.mockClear();
  fake.recordsPresses = false;
});

afterEach(() => {
  for (const stop of teardowns.splice(0)) stop();
  vi.unstubAllGlobals();
});

describe("startVoiceRecordingRuntime (#17031)", () => {
  it("never imports the service while voice input is off", async () => {
    const { voiceInput } = stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    runtime.startVoiceRecordingRuntime();
    await settle();

    expect(voiceInput.getSettings).toHaveBeenCalledTimes(1);
    expect(fake.imports).toBe(0);
    expect(runtime.getLoadedVoiceRecordingService()).toBeNull();
  });

  it("loads the service once, handing it the settings it read, when dictation is configured", async () => {
    stubVoiceInput(ON);
    const runtime = await loadRuntime();

    runtime.startVoiceRecordingRuntime();
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
    runtime.startVoiceRecordingRuntime();
    await runtime.loadVoiceRecordingService();

    expect(fake.imports).toBe(1);
    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenCalledWith(ON);
  });

  it("loads nothing for a settings read that lands after teardown", async () => {
    stubVoiceInput(ON);
    const runtime = await loadRuntime();

    runtime.startVoiceRecordingRuntime()();
    await settle();

    expect(fake.imports).toBe(0);
  });

  it("loads the service when Settings turn dictation on in this view, from what main stored", async () => {
    const { stored } = stubVoiceInput(OFF);
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();
    await settle();

    changeSettingsHere();
    await settle();
    expect(fake.imports).toBe(0);

    stored.settings = ON;
    changeSettingsHere();
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
    expect(fake.initialize).toHaveBeenCalledWith(ON);
  });

  it("rereads the settings once loaded when they changed while the service was loading", async () => {
    const { stored } = stubVoiceInput(ON);
    let letImportFinish!: () => void;
    fake.importGate = new Promise((resolve) => (letImportFinish = resolve));
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();
    await vi.waitFor(() => expect(fake.imports).toBe(1));

    // Turned off while the chunk is still on its way: the boot read it was
    // handed is stale by the time it initializes.
    stored.settings = OFF;
    changeSettingsHere();
    letImportFinish();

    await vi.waitFor(() => expect(fake.refreshConfiguration).toHaveBeenCalledTimes(1));
    expect(fake.initialize).toHaveBeenCalledWith(ON);
  });

  it("tries again on the next change after the service failed to load", async () => {
    const { stored } = stubVoiceInput(ON);
    fake.failNextImport = true;
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();
    await vi.waitFor(() => expect(fake.imports).toBe(1));
    await settle();
    expect(runtime.getLoadedVoiceRecordingService()).toBeNull();

    stored.settings = { ...ON };
    changeSettingsHere();

    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
    expect(fake.initialize).toHaveBeenCalledTimes(1);
  });

  it("trusts no boot read a settings change overtook", async () => {
    const { voiceInput, stored } = stubVoiceInput(ON);
    let landBootRead!: (settings: StoredSettings) => void;
    voiceInput.getSettings.mockImplementationOnce(
      () => new Promise<StoredSettings>((resolve) => (landBootRead = resolve))
    );
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();

    stored.settings = OFF;
    changeSettingsHere();
    landBootRead(ON);
    await settle();

    expect(fake.imports).toBe(0);
  });

  it("shows another view's session at once and loads the service to follow it", async () => {
    const { reportLiveSession, unsubscribeLive } = stubVoiceInput(OFF);
    const runtime = await loadRuntime();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    runtime.startVoiceRecordingRuntime();
    await settle();

    reportLiveSession({ revision: 1, session: null });
    await settle();
    expect(fake.imports).toBe(0);

    const session = {
      sessionId: "s1",
      hostId: LOCAL_HOST_ID,
      projectId: "p2",
      projectName: "Other",
      details: null,
    };
    reportLiveSession({ revision: 2, session });

    expect(useVoiceRecordingStore.getState().sessionElsewhere).toEqual(session);
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
    expect(unsubscribeLive).toHaveBeenCalled();
  });
});

describe("withVoiceRecordingService (#17031)", () => {
  it("runs at once against a loaded service, as a direct call would", async () => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();
    const service = await runtime.loadVoiceRecordingService();

    const run = vi.fn();
    runtime.withVoiceRecordingService(run);

    expect(run).toHaveBeenCalledWith(service);
  });

  it("loads the service first when nothing has yet", async () => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    const run = vi.fn();
    runtime.withVoiceRecordingService(run);
    expect(run).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(fake.imports).toBe(1);
  });
});

describe("noteVoiceShortcutKeydown (#17031)", () => {
  it("keeps a voice key pressed before the service could hear it, until a start takes it", async () => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown(PRESS));
    release("KeyA");

    expect(runtime.takePendingVoiceShortcutPress()).toMatchObject({
      code: "Period",
      timeStamp: 42,
      released: false,
    });
    expect(runtime.takePendingVoiceShortcutPress()).toBeNull();
  });

  it.each([
    ["the key's own release", () => release("Period")],
    ["Meta's release", () => release("MetaLeft")],
    ["the window losing focus", () => window.dispatchEvent(new Event("blur"))],
  ])("marks the kept press released on %s", async (_what, letGo) => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown(PRESS));
    letGo();

    expect(runtime.takePendingVoiceShortcutPress()?.released).toBe(true);
  });

  it("keeps nothing for a repeat, another key, or a press the service records itself", async () => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown({ ...PRESS, repeat: true }));
    expect(runtime.takePendingVoiceShortcutPress()).toBeNull();

    runtime.noteVoiceShortcutKeydown(keydown({ ...PRESS, code: "KeyA" }));
    expect(runtime.takePendingVoiceShortcutPress()).toBeNull();

    await runtime.loadVoiceRecordingService();
    fake.recordsPresses = true;
    runtime.noteVoiceShortcutKeydown(keydown(PRESS));
    expect(runtime.takePendingVoiceShortcutPress()).toBeNull();
  });

  it("drops an older press no start took when the next voice key goes down", async () => {
    stubVoiceInput(OFF);
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown(PRESS, 1));
    runtime.noteVoiceShortcutKeydown(keydown(PRESS, 99));

    expect(runtime.takePendingVoiceShortcutPress()?.timeStamp).toBe(99);
  });
});

describe("onSpokenSend (#17031)", () => {
  it("keeps a composer's send registered before the service loads, until it unregisters", async () => {
    const runtime = await loadRuntime();
    const first = vi.fn();
    const second = vi.fn();

    const offFirst = runtime.onSpokenSend("panel-1", "project-1", first);
    runtime.onSpokenSend("panel-1", "project-1", second);
    // An older registration's teardown leaves the newer one in place.
    offFirst();

    expect(runtime.getSpokenSendHandler("panel-1", "project-1")).toBe(second);
    expect(runtime.getSpokenSendHandler("panel-1", undefined)).toBeUndefined();
  });
});

describe("startVoiceRecordingRuntime with on-device transcription (#17338)", () => {
  const LOCAL = { enabled: true, transcriptionProvider: "local", openaiApiKey: "" } as const;

  function stubLocalModel(state: "absent" | "ready") {
    const stub = stubVoiceInput(LOCAL as unknown as StoredSettings);
    let push:
      ((status: { state: string; totalBytes: number; receivedBytes: number }) => void) | null =
      null;
    const voiceInput = stub.voiceInput as unknown as Record<string, unknown>;
    // Main's status: what a read answers, and what a push announces.
    let current: string = state;
    voiceInput.getLocalModel = vi.fn(async () => ({
      state: current,
      totalBytes: 10,
      receivedBytes: 0,
    }));
    voiceInput.onLocalModelStatus = vi.fn((callback: typeof push) => {
      push = callback;
      return () => {};
    });
    return {
      ...stub,
      push: (next: "ready") => {
        current = next;
        push?.({ state: next, totalBytes: 10, receivedBytes: 10 });
      },
    };
  }

  it("loads the service with no key once the model is ready", async () => {
    stubLocalModel("ready");
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
  });

  it("waits for the model, and loads once a download in any view finishes it", async () => {
    const { push } = stubLocalModel("absent");
    const runtime = await loadRuntime();
    runtime.startVoiceRecordingRuntime();
    await settle();
    expect(fake.imports).toBe(0);

    push("ready");
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
  });

  it("counts a keyed provider by its key whatever the model says", async () => {
    const runtime = await loadRuntime();
    const keyless = { ...ON, openaiApiKey: "" } as VoiceInputSettings;
    expect(runtime.isVoiceInputConfigured(keyless, true)).toBe(false);
    expect(
      runtime.isVoiceInputConfigured({ ...keyless, transcriptionProvider: "local" }, true)
    ).toBe(true);
    expect(
      runtime.isVoiceInputConfigured({ ...keyless, transcriptionProvider: "local" }, false)
    ).toBe(false);
  });
});
