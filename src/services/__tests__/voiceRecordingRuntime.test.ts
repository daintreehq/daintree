// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceInputSettings, VoiceLiveSessionUpdate } from "@shared/types";

// Stands in for the recording service: counts how often its module is
// evaluated, and initializes the way the real one does, by telling the runtime.
const fake = vi.hoisted(() => ({
  imports: 0,
  initialize: vi.fn(),
  recordsPresses: false,
}));
function mockRecordingService() {
  // Registered afresh for each test's module graph, so every import counts.
  vi.doMock("../VoiceRecordingService", async () => {
    fake.imports++;
    const runtime = await import("../voiceRecordingRuntime");
    const voiceRecordingService = {
      initialize(settings?: VoiceInputSettings) {
        fake.initialize(settings);
        runtime.setInitializedVoiceRecordingService(voiceRecordingService as never);
      },
      recordsShortcutPresses: () => fake.recordsPresses,
    };
    return { voiceRecordingService };
  });
}

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombos: (actionId: string) => (actionId === "voiceInput.toggle" ? ["Cmd+."] : []),
    matchesEvent: (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period",
  },
}));

const ON: VoiceInputSettings = {
  enabled: true,
  transcriptionProvider: "openai",
  openaiApiKey: "sk-test",
} as VoiceInputSettings;
const OFF: VoiceInputSettings = { ...ON, enabled: false };

function stubVoiceInput(settings: Promise<VoiceInputSettings>) {
  let liveSession: ((update: VoiceLiveSessionUpdate) => void) | null = null;
  const unsubscribeLive = vi.fn();
  const voiceInput = {
    getSettings: vi.fn(() => settings),
    onLiveSession: vi.fn((callback: (update: VoiceLiveSessionUpdate) => void) => {
      liveSession = callback;
      return unsubscribeLive;
    }),
  };
  vi.stubGlobal("electron", { voiceInput });
  return {
    voiceInput,
    unsubscribeLive,
    reportLiveSession: (update: VoiceLiveSessionUpdate) => liveSession?.(update),
  };
}

async function loadRuntime() {
  return import("../voiceRecordingRuntime");
}

const keydown = (init: Partial<KeyboardEvent>) => ({ ...init }) as KeyboardEvent;
const release = (code: string) => window.dispatchEvent(new KeyboardEvent("keyup", { code }));

const PRESS = { code: "Period", key: ".", metaKey: true, repeat: false, timeStamp: 42 };

beforeEach(() => {
  vi.resetModules();
  mockRecordingService();
  fake.imports = 0;
  fake.initialize.mockClear();
  fake.recordsPresses = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startVoiceRecordingRuntime (#17031)", () => {
  it("never imports the service while voice input is off", async () => {
    const { voiceInput } = stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();

    runtime.startVoiceRecordingRuntime();
    await vi.waitFor(() => expect(voiceInput.getSettings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.imports).toBe(0);
    expect(runtime.getLoadedVoiceRecordingService()).toBeNull();
  });

  it("loads the service once, handing it the settings it read, when dictation is configured", async () => {
    stubVoiceInput(Promise.resolve(ON));
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
    let land!: (settings: VoiceInputSettings) => void;
    stubVoiceInput(new Promise((resolve) => (land = resolve)));
    const runtime = await loadRuntime();

    const stop = runtime.startVoiceRecordingRuntime();
    stop();
    land(ON);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.imports).toBe(0);
  });

  it("loads the service when Settings turn dictation on in this view", async () => {
    stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();
    const { dispatchVoiceInputSettingsChanged } = await import("@/lib/voiceInputSettingsEvents");
    runtime.startVoiceRecordingRuntime();

    dispatchVoiceInputSettingsChanged({ ...ON, openaiApiKey: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.imports).toBe(0);

    dispatchVoiceInputSettingsChanged(ON);
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
    // The service reads the settings afresh rather than trusting the tab's copy.
    expect(fake.initialize).toHaveBeenCalledWith(undefined);
  });

  it("shows another view's session at once and loads the service to follow it", async () => {
    const { reportLiveSession, unsubscribeLive } = stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    runtime.startVoiceRecordingRuntime();

    reportLiveSession({ revision: 1, session: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.imports).toBe(0);

    const session = {
      sessionId: "s1",
      hostId: "local",
      projectId: "p2",
      projectName: "Other",
      details: null,
    } as const;
    reportLiveSession({ revision: 2, session });

    expect(useVoiceRecordingStore.getState().sessionElsewhere).toEqual(session);
    expect(unsubscribeLive).toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.getLoadedVoiceRecordingService()).not.toBeNull());
  });
});

describe("withVoiceRecordingService (#17031)", () => {
  it("runs at once against a loaded service, as a direct call would", async () => {
    stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();
    const service = await runtime.loadVoiceRecordingService();

    const use = vi.fn();
    runtime.withVoiceRecordingService(use);

    expect(use).toHaveBeenCalledWith(service);
  });

  it("loads the service first when nothing has yet", async () => {
    stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();

    const use = vi.fn();
    runtime.withVoiceRecordingService(use);
    expect(use).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(use).toHaveBeenCalledTimes(1));
    expect(fake.imports).toBe(1);
  });
});

describe("noteVoiceShortcutKeydown (#17031)", () => {
  it("keeps a voice key pressed before the service could hear it, until a start takes it", async () => {
    stubVoiceInput(Promise.resolve(OFF));
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
    stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown(PRESS));
    letGo();

    expect(runtime.takePendingVoiceShortcutPress()?.released).toBe(true);
  });

  it("keeps nothing for a repeat, another key, or a press the service records itself", async () => {
    stubVoiceInput(Promise.resolve(OFF));
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
    stubVoiceInput(Promise.resolve(OFF));
    const runtime = await loadRuntime();

    runtime.noteVoiceShortcutKeydown(keydown(PRESS));
    runtime.noteVoiceShortcutKeydown(keydown({ ...PRESS, timeStamp: 99 }));

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
